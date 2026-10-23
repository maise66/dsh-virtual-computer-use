/**
 * dsh-virtual-computer-use —— 全局「双击 ESC 中断」。
 *
 * ## 设计要点
 *
 * 1. **沿触发（edge-triggered）+ 冷却**，而不是"命中即重置"。
 *    朴素实现是：每收到一次匹配的 down 就把 `lastDown` 清空，于是
 *    `D1 D2 D3` 会产生 **两次**配对（D1–D2 一次、D2–D3 又一次）→ 三连击
 *    触发两次中断（这是本模块要修的真实缺陷）。
 *    本实现的规则是：
 *      - 匹配到某次 `down` 时立刻**消费**它（清空 `lastDown`）并进入冷却；
 *      - 冷却期内所有按键一律不参与配对（既不记录也不触发）；
 *      - 冷却结束后才重新武装。
 *    于是 `D1 D2 D3` 恰好触发 **1** 次：D1 记录 → D2 命中（消费 + 冷却）→
 *    D3 落在冷却窗口内被吞掉。
 *
 * 2. **钩子挂在主线程 + `PeekMessageW` 非阻塞泵**（任务描述里写的"必须用 worker
 *    线程 + 阻塞 GetMessageW"经实测**不可行**，两条替代路线也都被排除）：
 *    - `worker_threads` + worker 内同步阻塞 `GetMessageW`：worker 的 JS 线程
 *      被彻底阻塞，`postMessage` 无响应，且实测**收不到任何按键**。
 *    - `koffi` 的 `.async()` 把阻塞调用搬到 koffi 线程池：实测 `GetMessageW.async`
 *      **只回调一次**，`PostThreadMessageW(WM_QUIT)` 也无法唤醒它，会把 koffi
 *      线程池占死（连累其它 `.async()`）。
 *    - `GetMessageW.async` 自续泵：能收到按键，但实测**会让 `process.exit()`
 *      挂死**（koffi 线程池上挂着永不返回的请求）——对一个要求"宿主能正常退出"
 *      的模块不可接受。
 *    - 最终采用：`SetWindowsHookExW(WH_KEYBOARD_LL, cb, 0, 0)` 装在**当前线程**，
 *      配 `setInterval` + `PeekMessageW(PM_REMOVE)` 非阻塞派发（定时器 `unref()`）。
 *      实测该组合**能收到全局按键**，不阻塞事件循环，且**不阻止进程退出**。
 *    - `uninstall()` 会 `UnhookWindowsHookEx` 并 `clearInterval` 停掉泵。
 *
 * 3. **只读不吞**：回调永远 `CallNextHookEx` 放行，ESC 照常传给前台程序，
 *    宿主不抢任何焦点。
 *
 * 4. 一切失败降级为 `{ ok:false, reason }`，**绝不抛异常**。宿主是长存活进程。
 */

import { loadKoffi, loadWin32, VK } from './native.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** WH_KEYBOARD_LL。 */
const WH_KEYBOARD_LL = 13;

/** WM_* 本模块用得到的部分。 */
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_SYSKEYDOWN = 0x0104;
const WM_SYSKEYUP = 0x0105;

/** PeekMessageW 的 PM_REMOVE。 */
const PM_REMOVE = 0x0001;

/** KBDLLHOOKSTRUCT.flags 位。 */
export const LLKHF = {
  EXTENDED: 0x01,
  LOWER_IL_INJECTED: 0x02,
  INJECTED: 0x10,
  ALTDOWN: 0x20,
  UP: 0x80,
};

/** 默认配置。 */
const DEFAULTS = {
  enabled: true,
  /** 两次按键的最大间隔（ms），超过则视为两次独立按键。 */
  thresholdMs: 400,
  /** 命中后的冷却窗口（ms）；缺省等于 thresholdMs。 */
  cooldownMs: undefined,
  /** 触发键序列，例如 'esc'（双击）、'esc' x3（通过 taps 配置）、'ctrl+shift+q'。 */
  keys: ['esc'],
  /** 需要的按键次数（默认 2 = 双击）。 */
  taps: 2,
  /** 是否忽略其它程序注入的按键（SendInput/键盘宏）。默认 false：测试与真实场景都要能收到。 */
  ignoreInjected: false,
  /** 调试钩子，收到每次按键事件时调用（不抛异常）。 */
  onKeyEvent: undefined,
};

// ---------------------------------------------------------------------------
// 按键名解析
// ---------------------------------------------------------------------------

/** 名称 → 虚拟键码。 */
const KEY_NAMES = new Map(Object.entries(VK).map(([name, code]) => [name.toLowerCase(), code]));
// 常见别名
const KEY_ALIASES = new Map([
  ['escape', VK.ESCAPE],
  ['esc', VK.ESCAPE],
  ['enter', VK.RETURN],
  ['return', VK.RETURN],
  ['ctrl', VK.CONTROL],
  ['control', VK.CONTROL],
  ['alt', VK.MENU],
  ['shift', VK.SHIFT],
  ['win', VK.LWIN],
  ['space', VK.SPACE],
  ['del', VK.DELETE],
  ['delete', VK.DELETE],
  ['pageup', VK.PRIOR],
  ['pagedown', VK.NEXT],
  ['up', VK.UP],
  ['down', VK.DOWN],
  ['left', VK.LEFT],
  ['right', VK.RIGHT],
]);
for (let i = 1; i <= 12; i += 1) KEY_ALIASES.set(`f${i}`, VK.F1 + i - 1);
for (let c = 0; c <= 9; c += 1) KEY_ALIASES.set(String(c), 0x30 + c);
for (let c = 0; c < 26; c += 1) KEY_ALIASES.set(String.fromCharCode(97 + c), VK.A + c);

/**
 * 把单个按键名解析成虚拟键码；失败返回 undefined。
 *
 * @param {string} name
 * @returns {number | undefined}
 */
export function parseKeyCode(name) {
  if (typeof name !== 'string') return undefined;
  const key = name.trim().toLowerCase();
  if (key === '') return undefined;
  if (/^0x[0-9a-f]+$/.test(key)) return Number.parseInt(key, 16);
  if (/^\d+$/.test(key) && Number(key) > 9) return Number.parseInt(key, 10);
  return KEY_ALIASES.get(key) ?? KEY_NAMES.get(key);
}

/**
 * 把 `'ctrl+shift+q'` 解析成键码数组。全部解析成功才返回数组。
 *
 * @param {string | string[]} spec
 * @returns {number[] | undefined}
 */
export function parseKeySequence(spec) {
  if (Array.isArray(spec)) {
    const codes = spec.map(parseKeyCode);
    return codes.every((code) => code !== undefined) && codes.length > 0 ? codes : undefined;
  }
  if (typeof spec === 'number' && Number.isFinite(spec)) return [spec];
  if (typeof spec !== 'string' || spec.trim() === '') return undefined;
  const codes = spec.split('+').map(parseKeyCode);
  return codes.every((code) => code !== undefined) && codes.length > 0 ? codes : undefined;
}

/** 键码 → 可读名（用于 status 输出）。 */
function keyCodeName(code) {
  for (const [name, value] of KEY_ALIASES) if (value === code) return name;
  return `0x${Number(code).toString(16)}`;
}

/**
 * 把各种形态的键配置归一化成键码数组。
 *
 * 接受：`'esc'`、`'esc'`、`'ctrl+shift+q'`、`['esc']`、`[0x1b]`、`27`。
 * 无法解析时返回 undefined。
 */
function normalizeKeys(spec) {
  if (spec === undefined || spec === null) return [VK.ESCAPE];
  if (typeof spec === 'number' && Number.isFinite(spec)) return [spec];
  if (typeof spec === 'string') {
    // 多键序列（如双击 ESC）在配置里用单键名表示，配合 taps 使用；
    // 'ctrl+shift+q' 这种组合键则整体作为一个触发条件。
    const seq = parseKeySequence(spec);
    return seq;
  }
  if (Array.isArray(spec)) {
    if (spec.length === 0) return [VK.ESCAPE];
    const codes = spec.map((item) => (typeof item === 'number' ? item : parseKeySequence(item)?.[0]));
    return codes.every((code) => code !== undefined) ? codes : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 控制器
// ---------------------------------------------------------------------------

/** 进程内单例（install 幂等的基础）。 */
let singleton;

/**
 * 创建（或取回）全局双击 ESC 中断控制器。
 *
 * 同一个进程内只存在一个真实钩子；参数只在**首次**创建时生效，
 * 后续调用返回同一实例（可用 `configure()` 改配置）。
 *
 * @param {object} [options] - 见 DEFAULTS。
 * @returns {object} 控制器。
 */
export function createEscAbort(options = {}) {
  if (singleton !== undefined) {
    if (Object.keys(options).length > 0) singleton.configure(options);
    return singleton;
  }
  singleton = new EscAbortController(options);
  return singleton;
}

/** 取回单例（未创建时创建）。 */
export function getEscAbort() {
  return createEscAbort();
}

/**
 * 全局按键监听 + 双击中断控制器。
 *
 * 公开 API：
 *   install()   -> { ok, ... }        幂等；重复调用只创建一次钩子
 *   uninstall() -> { ok, ... }        真正解钩并停掉消息泵
 *   status()    -> { installed, enabled, ... }
 *   configure(patch) -> { ok, config }
 *   onAbort(fn) -> { ok, unsubscribe }
 *   onKeyEvent(fn) -> { ok, unsubscribe }
 *   enable() / disable() -> { ok, enabled }
 *   arm() / disarm() / reset()
 *   signal      -> AbortSignal
 *   aborted     -> boolean
 *   lastAbortAt -> number | undefined
 */
class EscAbortController {
  constructor(options = {}) {
    this.config = { ...DEFAULTS, ...options };
    if (this.config.cooldownMs === undefined) this.config.cooldownMs = this.config.thresholdMs;
    // 允许构造时直接传 'esc' / 'ctrl+shift+q' 这类字符串（或字符串数组）。
    if (!Array.isArray(this.config.keys) || this.config.keys.some((k) => typeof k === 'string')) {
      const parsed = normalizeKeys(this.config.keys);
      if (parsed !== undefined) this.config.keys = parsed;
    }

    this._native = undefined;
    this._hook = undefined;
    this._cb = undefined;
    this._proto = undefined;
    this._pumping = false;
    this._pumpActive = false;
    this._pumpTimer = undefined;
    this._installed = false;
    this._enabled = this.config.enabled !== false;

    /** 上一次匹配到的按键滴答（时间戳+按下序号的组合），undefined 表示未武装。 */
    this._lastTap = undefined;
    /** 冷却截止时间戳；`now < _cooldownUntil` 期间一律不参与配对。 */
    this._cooldownUntil = 0;
    /** 连续匹配计数（用于 taps > 2 的场景）。 */
    this._tapCount = 0;

    this._abort = new AbortController();
    this._abortSubscribers = new Set();
    this._keySubscribers = new Set();
    this.lastAbortAt = undefined;
    this.abortCount = 0;
    /** 收到的原始按键事件数（诊断用）。 */
    this.rawKeyCount = 0;
    /** 通过 nCode/键码过滤后、真正参与配对的 down 次数（诊断用）。 */
    this.matchedKeyCount = 0;
    /** 被冷却吞掉的 down 次数（诊断用）。 */
    this.suppressedCount = 0;
    /** 最近若干条原始事件（诊断用，便于测试与排障）。 */
    this.rawEvents = [];
  }

  // --- 只读属性 ---------------------------------------------------------

  /** 供长任务轮询/监听的 AbortSignal。 */
  get signal() {
    return this._abort.signal;
  }

  /** 是否已被中断。 */
  get aborted() {
    return this._abort.signal.aborted;
  }

  /** 是否已装钩子。 */
  get installed() {
    return this._installed;
  }

  // --- 原生绑定 ---------------------------------------------------------

  _bind() {
    if (this._native !== undefined) return this._native;
    const loaded = loadWin32();
    if (loaded.reason !== undefined) {
      this._native = { reason: loaded.reason };
      return this._native;
    }
    try {
      const koffi = loaded.koffi;
      this._proto = koffi.pointer(
        koffi.proto('intptr_t __stdcall DshVcuKeyboardProc(int nCode, uintptr_t wParam, intptr_t lParam)'),
      );
      this._native = {
        koffi,
        loaded,
        KBDLLHOOKSTRUCT: koffi.struct('DshVcuKbdLlHookStruct', {
          vkCode: 'uint32',
          scanCode: 'uint32',
          flags: 'uint32',
          time: 'uint32',
          dwExtraInfo: 'uintptr_t',
        }),
      };
    } catch (error) {
      this._native = { reason: `hook type declaration failed: ${error?.message ?? String(error)}` };
    }
    return this._native;
  }

  // --- 安装 / 卸载 ------------------------------------------------------

  /**
   * 安装全局钩子。幂等：已安装时直接返回当前状态。
   *
   * @returns {{ok:boolean, installed?:boolean, mode?:string, hook?:string, reason?:string}}
   */
  install() {
    if (this._installed) {
      return { ok: true, installed: true, mode: this._mode, hook: String(this._hook), alreadyInstalled: true };
    }
    const native = this._bind();
    if (native.reason !== undefined) return { ok: false, installed: false, reason: native.reason };
    if (process.platform !== 'win32') {
      return { ok: false, installed: false, reason: `platform ${process.platform} is not supported` };
    }

    const { koffi, loaded } = native;
    try {
      // 回调必须先 proto 再 pointer 包装，否则 koffi 报
      // "Unexpected type, expected <callback> *"。
      this._cb = koffi.register((nCode, wParam, lParam) => this._handleHook(nCode, wParam, lParam), this._proto);
      // hMod 传 0：低级键盘钩子由系统在安装线程的上下文中回调，不需要 DLL 句柄。
      // threadId 传 0 = 全局钩子。
      const hook = loaded.SetWindowsHookExW(WH_KEYBOARD_LL, this._cb, 0, 0);
      if (hook === 0n || hook === 0) {
        const reason = `SetWindowsHookExW(WH_KEYBOARD_LL) returned NULL`;
        try {
          koffi.unregister(this._cb);
        } catch {
          // 忽略
        }
        this._cb = undefined;
        return { ok: false, installed: false, reason };
      }
      this._hook = hook;
      this._installed = true;
      this._mode = 'main-thread-peek-pump';
      this._startPump();
      return { ok: true, installed: true, mode: this._mode, hook: String(hook) };
    } catch (error) {
      return { ok: false, installed: false, reason: `install failed: ${error?.message ?? String(error)}` };
    }
  }

  /**
   * 卸载全局钩子并停掉消息泵。幂等。
   *
   * @returns {{ok:boolean, installed?:boolean, reason?:string}}
   */
  uninstall() {
    if (!this._installed) return { ok: true, installed: false, alreadyUninstalled: true };
    const native = this._bind();
    this._installed = false;
    this._pumping = false;
    this._pumpActive = false;
    this.reset();

    const problems = [];
    try {
      if (native.reason === undefined) {
        if (native.loaded.UnhookWindowsHookEx(this._hook) !== true) problems.push('UnhookWindowsHookEx returned false');
      }
    } catch (error) {
      problems.push(error?.message ?? String(error));
    }
    // 停掉消息泵定时器：否则钩子已解但定时器还在后台空转烧 CPU。
    if (this._pumpTimer !== undefined) {
      clearInterval(this._pumpTimer);
      this._pumpTimer = undefined;
    }
    try {
      if (this._cb !== undefined && native.reason === undefined) native.koffi.unregister(this._cb);
    } catch (error) {
      problems.push(`unregister: ${error?.message ?? String(error)}`);
    }
    this._cb = undefined;
    this._hook = undefined;
    this._mode = undefined;
    return problems.length === 0
      ? { ok: true, installed: false }
      : { ok: false, installed: false, reason: problems.join(' | ') };
  }

  // --- 消息泵 -----------------------------------------------------------

  /**
   * 启动非阻塞消息泵。
   *
   * 低级键盘钩子的回调由系统直接调用，**不需要**阻塞等待消息，所以只要周期性
   * 把排队的消息派发掉即可。用 `setInterval` + `PeekMessageW` 而非
   * `GetMessageW.async`，同时对定时器 `unref()`，保证不阻止宿主进程退出。
   * `uninstall()` 会 `clearInterval` 停掉它。
   */
  _startPump() {
    if (this._pumping) return;
    this._pumping = true;
    const native = this._native;
    if (native?.reason !== undefined) return;
    const { loaded } = native;
    this._pumpActive = true;
    const buffer = Buffer.alloc(64);

    /**
     * 用 `PeekMessageW` **非阻塞**轮询派发消息。
     *
     * 为什么不用 `GetMessageW.async`（更"正统"的阻塞泵）：
     * 实测它会让 `process.exit()` **无法退出** —— koffi 在线程池上挂着一个永不返回的
     * 请求，即使调用 `process.exit(0)` 进程也会挂死。对一个"宿主是长存活进程、
     * 测试要能自然退出"的模块来说这是不可接受的（本模块早期版本就踩了这个坑，
     * 导致测试跑完不退出）。
     *
     * `PeekMessageW` + 定时器 + `unref()` 的组合实测满足全部要求：
     *   - **能收到全局按键**（低级键盘钩子由系统在消息到达时直接调用回调，
     *     泵只是顺带把排队的消息派发掉，不需要"阻塞等待"）；
     *   - 定时器 `unref()` 后**不阻止进程退出**；
     *   - 完全不阻塞事件循环。
     */
    const tick = () => {
      if (!this._pumping) return;
      try {
        for (let i = 0; i < 32; i += 1) {
          if (loaded.PeekMessageW(buffer, 0, 0, 0, PM_REMOVE) !== true) break;
          loaded.TranslateMessage(buffer);
          loaded.DispatchMessageW(buffer);
        }
      } catch (error) {
        this._pumpError = error?.message ?? String(error);
      }
    };
    this._pumpTimer = setInterval(tick, 16);
    // unref() 是关键：钩子本身不需要让进程保持存活，宿主退出时不应被这个消息泵拖住。
    if (typeof this._pumpTimer.unref === 'function') this._pumpTimer.unref();
  }

  // --- 钩子回调 ---------------------------------------------------------

  _handleHook(nCode, wParam, lParam) {
    const native = this._native;
    try {
      // 永远放行：ESC 必须照常传给前台程序，本钩子只读不吞。
      if (Number(nCode) < 0 || native?.reason !== undefined) {
        return native?.loaded?.CallNextHookEx(0, nCode, wParam, lParam) ?? 0;
      }
      const message = Number(wParam);
      const isDown = message === WM_KEYDOWN || message === WM_SYSKEYDOWN;
      const isUp = message === WM_KEYUP || message === WM_SYSKEYUP;

      let info;
      try {
        info = native.koffi.decode(lParam, 0, native.KBDLLHOOKSTRUCT);
      } catch {
        info = undefined;
      }
      const vkCode = info === undefined ? undefined : Number(info.vkCode);
      const flags = info === undefined ? 0 : Number(info.flags);

      if (vkCode !== undefined) {
        this.rawKeyCount += 1;
        this._rememberEvent({ vkCode, down: isDown, flags, t: Date.now() });
        if (this.rawKeyCount % 64 === 1) {
          // 原始事件环形缓冲，便于测试断言与线上排障。
          this.rawEvents.push({ vkCode, down: isDown, flags, t: Date.now() });
        }
      }

      if (this._enabled && this._installed && vkCode !== undefined && (isDown || isUp)) {
        const injected = (flags & LLKHF.INJECTED) !== 0;
        if (!(this.config.ignoreInjected === true && injected)) {
          this._onKey({ vkCode, down: isDown, flags, t: Date.now() });
        }
      }
      return native.loaded.CallNextHookEx(0, nCode, wParam, lParam);
    } catch (error) {
      // 钩子回调里的异常绝不能让系统把进程干掉；记录后一律放行。
      this._hookError = error?.message ?? String(error);
      try {
        return native?.loaded?.CallNextHookEx(0, nCode, wParam, lParam) ?? 0;
      } catch {
        return 0;
      }
    }
  }

  _rememberEvent(event) {
    if (event.down) {
      this._lastRawDown = event;
    }
    for (const fn of this._keySubscribers) {
      try {
        fn({ ...event });
      } catch {
        // 订阅者异常不影响钩子。
      }
    }
    if (typeof this.config.onKeyEvent === 'function') {
      try {
        this.config.onKeyEvent({ ...event });
      } catch {
        // 忽略
      }
    }
  }

  /**
   * 沿触发 + 冷却的核心判定。
   *
   * 时序（默认双击 ESC、threshold=400、cooldown=400）：
   *   D1 → 记录（_tapCount=1）
   *   D2 → 命中：消费（清空）、置冷却、触发一次回调
   *   D3 → 落在冷却窗口内 → suppressedCount++，不配对、不触发
   *   ...
   *   冷却结束 → 重新武装，下次 D 重新开始计数
   *
   * @param {{vkCode:number, down:boolean, t?:number}} event - `t` 可显式给出，
   *   便于测试用确定的时间戳驱动判定，而不依赖 SendInput 的真实投递时序。
   */
  _onKey(event) {
    if (!event.down) return; // 只在按下沿判定
    const code = event.vkCode;
    const required = Array.isArray(this.config.keys) && this.config.keys.length > 0 ? this.config.keys : [VK.ESCAPE];
    const primary = Number(required[required.length - 1]);
    if (code !== primary) return;
    this.matchedKeyCount += 1;

    const now = typeof event.t === 'number' ? event.t : Date.now();
    const taps = Number.isFinite(this.config.taps) && this.config.taps >= 1 ? Math.floor(this.config.taps) : 2;

    // 冷却期内：一律吞掉，且**不**重新武装（这是三连击只触发一次的关键）。
    if (now < this._cooldownUntil) {
      this.suppressedCount += 1;
      return;
    }

    // 冷却刚结束：清掉可能残留的上一次配对状态。
    if (this._cooldownUntil !== 0) {
      this._cooldownUntil = 0;
      this._lastTap = undefined;
      this._tapCount = 0;
    }

    if (this._lastTap === undefined || now - this._lastTap > this.config.thresholdMs) {
      // 未武装，或已超出阈值 → 重新武装，记录本次击键。
      this._lastTap = now;
      this._tapCount = 1;
      return;
    }

    // 在阈值内：累积匹配次数。
    this._tapCount += 1;
    this._lastTap = now;
    if (this._tapCount >= taps) {
      // 命中 —— 沿触发：立即消费本次配对并进入冷却，防止紧随其后的击键再次配对。
      this._lastTap = undefined;
      this._tapCount = 0;
      this._cooldownUntil = now + Math.max(0, Number(this.config.cooldownMs) || 0);
      this._fireAbort({ t: now, vkCode: code });
    }
  }

  /** 触发中断。 */
  _fireAbort(info) {
    this.lastAbortAt = info?.t ?? Date.now();
    this.abortCount += 1;
    const payload = {
      at: this.lastAbortAt,
      vkCode: info?.vkCode,
      count: this.abortCount,
      signal: this._abort.signal,
    };
    if (!this._abort.signal.aborted) {
      try {
        this._abort.abort(payload);
      } catch {
        // AbortController.abort 不应抛，但万一也不影响后续订阅者。
      }
    }
    for (const fn of this._abortSubscribers) {
      try {
        fn(payload);
      } catch {
        // 订阅者异常隔离。
      }
    }
  }

  // --- 订阅 / 配置 ------------------------------------------------------

  /**
   * 订阅中断事件。
   *
   * @param {(payload:{at:number,vkCode:number,count:number,signal:AbortSignal}) => void} callback
   * @returns {{ok:boolean, unsubscribe:() => void}}
   */
  onAbort(callback) {
    if (typeof callback !== 'function') return { ok: false, reason: 'callback must be a function', unsubscribe: () => {} };
    if (this._abortSubscribers.has(callback)) return { ok: true, unsubscribe: () => this._abortSubscribers.delete(callback) };
    this._abortSubscribers.add(callback);
    return { ok: true, unsubscribe: () => this._abortSubscribers.delete(callback) };
  }

  /**
   * 订阅**每一次**按键事件（含未匹配的按键），用于排障与集成。
   *
   * @param {(event:{vkCode:number,down:boolean,flags:number,t:number}) => void} callback
   */
  onKeyEvent(callback) {
    if (typeof callback !== 'function') return { ok: false, reason: 'callback must be a function', unsubscribe: () => {} };
    this._keySubscribers.add(callback);
    return { ok: true, unsubscribe: () => this._keySubscribers.delete(callback) };
  }

  /**
   * 合并式修改配置。
   *
   * @param {{enabled?:boolean,thresholdMs?:number,cooldownMs?:number,keys?:string|string[],taps?:number,ignoreInjected?:boolean,onKeyEvent?:Function,resetSignal?:boolean}} patch
   */
  configure(patch = {}) {
    if (patch.keys !== undefined) {
      const seq = normalizeKeys(patch.keys);
      if (seq === undefined) return { ok: false, reason: `unparsable key spec: ${JSON.stringify(patch.keys)}` };
      patch = { ...patch, keys: seq };
    }
    if (patch.thresholdMs !== undefined) {
      const value = Number(patch.thresholdMs);
      if (!Number.isFinite(value) || value < 0) return { ok: false, reason: 'thresholdMs must be a non-negative number' };
      patch = { ...patch, thresholdMs: value };
    }
    if (patch.cooldownMs !== undefined) {
      const value = Number(patch.cooldownMs);
      if (!Number.isFinite(value) || value < 0) return { ok: false, reason: 'cooldownMs must be a non-negative number' };
      patch = { ...patch, cooldownMs: value };
    }
    if (patch.taps !== undefined) {
      const value = Number(patch.taps);
      if (!Number.isFinite(value) || value < 1) return { ok: false, reason: 'taps must be >= 1' };
      patch = { ...patch, taps: Math.floor(value) };
    }
    const next = { ...this.config, ...patch };
    if (next.cooldownMs === undefined) next.cooldownMs = next.thresholdMs;
    if (next.keys !== undefined) {
      next.keys = Array.isArray(next.keys) ? next.keys.map(Number) : next.keys;
    }
    if (patch.enabled !== undefined) this._enabled = patch.enabled !== false;
    this.config = next;
    if (patch.resetSignal === true) this.resetSignal();
    this.reset();
    return { ok: true, config: this._configView() };
  }

  /** 打开检测（不卸载钩子）。 */
  enable() {
    this._enabled = true;
    this.config.enabled = true;
    this.reset();
    return { ok: true, enabled: true };
  }

  /** 关闭检测（钩子保留但不再判定，ESC 仍正常放行）。 */
  disable() {
    this._enabled = false;
    this.config.enabled = false;
    this.reset();
    return { ok: true, enabled: false };
  }

  /** 清空配对状态（不改变冷却）。 */
  arm() {
    this._lastTap = undefined;
    this._tapCount = 0;
    this._cooldownUntil = 0;
    return { ok: true };
  }

  /** arm() 的别名，语义更直白。 */
  reset() {
    this._lastTap = undefined;
    this._tapCount = 0;
    this._cooldownUntil = 0;
    return { ok: true };
  }

  /**
   * 完整复位：配对状态 + 中断信号 + **全部计数器**。
   *
   * 为什么需要单独的 `resetCounters()`：本控制器在进程内是单例，
   * `abortCount` / `matchedKeyCount` 等诊断计数会跨用例累积。如果测试之间
   * 不清零，"三连击触发 1 次"这类断言就会被前面用例的残留计数污染 ——
   * 实际观测到的是 `8` 而不是 `3`。生产代码里这些计数是**只增不减**的审计
   * 数据，所以清零只在显式调用时发生。
   */
  resetCounters() {
    this.abortCount = 0;
    this.lastAbortAt = undefined;
    this.rawKeyCount = 0;
    this.matchedKeyCount = 0;
    this.suppressedCount = 0;
    this.rawEvents = [];
    this._lastRawDown = undefined;
    this.reset();
    return { ok: true };
  }

  /** 手动解除中断（把 AbortSignal 换成新的，供下一次中断使用）。 */
  resetSignal() {
    if (this._abort.signal.aborted) this._abort = new AbortController();
    return { ok: true, aborted: this._abort.signal.aborted };
  }

  /** 手动触发一次中断（供 UI/测试使用）。 */
  abort(reason) {
    this._fireAbort({ t: Date.now(), vkCode: undefined, reason });
    return { ok: true, at: this.lastAbortAt };
  }

  /**
   * 注入一次合成按键事件，走与真实钩子**完全相同**的判定路径
   * （`_onKey` / `_rememberEvent`），但时间戳由调用方给出。
   *
   * 存在的理由：`SendInput` 只保证把输入**排入**系统输入队列，返回后并不代表
   * 已投递；实测注入的 ESC 会被排在真实输入之后，间隔可达数百毫秒甚至更久
   * （见 `test/esc-overlay.test.mjs` 里的真实钩子用例）。因此「120ms / 100ms
   * 间隔」这类**时序语义**必须用显式时间戳来测，否则测的是机器负载而不是逻辑。
   *
   * 真实钩子的端到端连通性由测试里的独立用例覆盖（只断言事件真的到达，不断言时序）。
   *
   * @param {{vkCode:number, down:boolean, t?:number, flags?:number}} event
   */
  injectKeyEvent(event) {
    if (event === null || typeof event !== 'object') return { ok: false, reason: 'event must be an object' };
    const vkCode = Number(event.vkCode);
    if (!Number.isFinite(vkCode)) return { ok: false, reason: 'vkCode must be a number' };
    const normalized = {
      vkCode,
      down: event.down === true,
      flags: Number.isFinite(Number(event.flags)) ? Number(event.flags) : 0,
      t: Number.isFinite(Number(event.t)) ? Number(event.t) : Date.now(),
    };
    this.rawKeyCount += 1;
    this._rememberEvent(normalized);
    if (this._enabled) this._onKey(normalized);
    return { ok: true };
  }

  _configView() {
    return {
      enabled: this._enabled,
      thresholdMs: this.config.thresholdMs,
      cooldownMs: this.config.cooldownMs,
      keys: (this.config.keys ?? [VK.ESCAPE]).map(keyCodeName),
      taps: this.config.taps,
      ignoreInjected: this.config.ignoreInjected === true,
    };
  }

  /**
   * 当前状态快照。
   *
   * @returns {{ok:boolean, installed:boolean, enabled:boolean, mode?:string, aborted:boolean, abortCount:number, lastAbortAt?:number, config:object, stats:object, reason?:string}}
   */
  status() {
    const native = this._bind();
    const base = {
      ok: native.reason === undefined,
      installed: this._installed,
      enabled: this._enabled,
      mode: this._mode,
      hook: this._hook === undefined ? undefined : String(this._hook),
      pumping: this._pumping === true && this._pumpActive === true,
      aborted: this._abort.signal.aborted,
      abortCount: this.abortCount,
      lastAbortAt: this.lastAbortAt,
      subscribers: this._abortSubscribers.size,
      config: this._configView(),
      stats: {
        rawKeyCount: this.rawKeyCount,
        matchedKeyCount: this.matchedKeyCount,
        suppressedCount: this.suppressedCount,
        cooldownRemainingMs: Math.max(0, this._cooldownUntil - Date.now()),
      },
    };
    if (native.reason !== undefined) base.reason = native.reason;
    if (this._pumpError !== undefined) base.pumpError = this._pumpError;
    if (this._hookError !== undefined) base.hookError = this._hookError;
    return base;
  }
}

/**
 * 便利函数：安装全局双击 ESC 中断（单例）。
 *
 * @param {object} [options]
 * @returns {{ok:boolean, controller?:object, reason?:string}}
 */
export function installDoubleEscapeAbort(options = {}) {
  const controller = createEscAbort(options);
  const result = controller.install();
  if (result.ok !== true) return { ok: false, reason: result.reason, controller };
  return { ok: true, controller, mode: result.mode, hook: result.hook };
}

/** 便利函数：卸载单例控制器。 */
export function uninstallDoubleEscapeAbort() {
  if (singleton === undefined) return { ok: true, installed: false, alreadyUninstalled: true };
  return singleton.uninstall();
}

export { EscAbortController };

export default {
  createEscAbort,
  getEscAbort,
  installDoubleEscapeAbort,
  uninstallDoubleEscapeAbort,
  parseKeyCode,
  parseKeySequence,
  LLKHF,
};

