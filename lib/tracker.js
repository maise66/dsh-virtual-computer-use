/**
 * 会话活动追踪层 —— "什么时候该显示悬浮窗、什么时候该武装中断"的唯一裁决者。
 *
 * 设计动机：
 *
 * 悬浮窗和中断都不应该由每个动作自己去开关。否则一次 `click` 就会闪一下悬浮窗，
 * 而 AI 连续做 20 个动作时悬浮窗会疯狂重建；中断也会在动作之间的空隙里被卸掉。
 *
 * 正确模型是**引用计数式的活动会话**：
 *
 *   beginOperation('click')  → 计数 1 → 悬浮窗显示、中断武装
 *   beginOperation('type')   → 计数 2
 *   endOperation()           → 计数 1 → 保持
 *   endOperation()           → 计数 0 → 等 lingerMs 后隐藏、解除武装
 *
 * lingerMs（默认 1200ms）的作用：AI 连续操作时动作之间有几十到几百毫秒的间隙，
 * 没有 linger 的话悬浮窗会一隐一现地闪。延迟隐藏让连续操作期间悬浮窗稳定存在，
 * 而真正空闲后又能及时消失，不会一直挂在屏幕上。
 *
 * 中断一旦触发，本会话立即进入 aborted 状态：后续动作应被拒绝执行，
 * 直到显式 reset()。这保证"双击 ESC 之后 AI 不会偷偷继续操作"。
 */

import { EventEmitter } from 'node:events';

/** 活动计数归零后，悬浮窗再保留多久才隐藏（毫秒）。 */
const DEFAULT_LINGER_MS = 1200;

export class OperationTracker extends EventEmitter {
  /**
   * @param options.lingerMs - 空闲后延迟隐藏的毫秒数。
   * @param options.now - 注入时钟，便于测试。
   */
  constructor(options = {}) {
    super();
    this.lingerMs = Number.isFinite(options.lingerMs) ? Math.max(0, options.lingerMs) : DEFAULT_LINGER_MS;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();

    /** 当前进行中的操作计数。 */
    this.depth = 0;
    /** 悬浮窗当前是否应该可见（含 linger 期）。 */
    this.active = false;
    /** 本会话是否已被用户中断。 */
    this.aborted = false;
    /** 中断发生的时间戳。 */
    this.abortedAt = undefined;
    /** 当前正在进行的操作标签栈，用于诊断"AI 到底在做什么"。 */
    this.stack = [];
    /** 已经发起过的操作总数，用于审计。 */
    this.totalOperations = 0;
    /** linger 隐藏定时器。 */
    this.lingerTimer = undefined;
  }

  /**
   * 标记一次操作开始。
   *
   * @param label - 操作名（如 'click'、'type_text'），用于悬浮窗文案与审计。
   * @returns 一个幂等的结束函数；重复调用只生效一次。
   */
  begin(label = 'operation') {
    if (this.aborted) {
      return { ok: false, reason: 'operation aborted by the user (double ESC)' };
    }
    this.depth += 1;
    this.totalOperations += 1;
    this.stack.push(label);

    // 有新操作进来就取消待隐藏，悬浮窗保持显示，避免连续操作时闪烁。
    if (this.lingerTimer !== undefined) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = undefined;
    }
    if (this.active !== true) {
      this.active = true;
      this.emit('active', { label, depth: this.depth });
    }
    this.emit('begin', { label, depth: this.depth });

    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.end(label);
    };
  }

  /** 标记一次操作结束（与 begin 配对）。 */
  end(label) {
    this.depth = Math.max(0, this.depth - 1);
    // 从栈尾往头找，移除最靠近栈顶的同名项，保持栈语义正确。
    const index = this.stack.lastIndexOf(label);
    if (index >= 0) this.stack.splice(index, 1);
    this.emit('end', { label, depth: this.depth });

    if (this.depth === 0) {
      // 不立即隐藏：等 linger，把连续操作之间的缝隙盖住。
      this.scheduleLinger();
    }
  }

  /** 安排 linger 之后的隐藏。 */
  scheduleLinger() {
    if (this.lingerTimer !== undefined) return;
    if (this.lingerMs === 0) {
      this.deactivate();
      return;
    }
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = undefined;
      if (this.depth === 0) this.deactivate();
    }, this.lingerMs);
    // 定时器不应阻止宿主进程退出。
    if (typeof this.lingerTimer.unref === 'function') this.lingerTimer.unref();
  }

  /** 真正进入空闲态。 */
  deactivate() {
    if (this.active !== true) return;
    this.active = false;
    this.emit('idle', { totalOperations: this.totalOperations });
  }

  /**
   * 用户中断：清空计数、停掉 linger、标记 aborted。
   *
   * @param source - 中断来源描述（默认 'double-escape'），用于审计与提示。
   */
  abort(source = 'double-escape') {
    const at = this.now();
    this.aborted = true;
    this.abortedAt = at;
    this.depth = 0;
    this.stack = [];
    if (this.lingerTimer !== undefined) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = undefined;
    }
    this.active = false;
    this.emit('abort', { source, at });
    return { ok: true, source, at };
  }

  /** 复位中断状态，允许开始新一轮操作。 */
  reset() {
    this.aborted = false;
    this.abortedAt = undefined;
    this.depth = 0;
    this.stack = [];
    this.emit('reset', { at: this.now() });
    return { ok: true };
  }

  /** 当前状态快照。 */
  status() {
    return {
      active: this.active,
      depth: this.depth,
      aborted: this.aborted,
      abortedAt: this.abortedAt,
      stack: [...this.stack],
      totalOperations: this.totalOperations,
      lingerMs: this.lingerMs,
    };
  }

  /** 释放定时器。 */
  dispose() {
    if (this.lingerTimer !== undefined) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = undefined;
    }
    this.removeAllListeners();
  }
}
