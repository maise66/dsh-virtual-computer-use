/**
 * dsh-virtual-computer-use —— Host 半（插件入口）。
 *
 * 这个插件解决三件事：
 *
 *   1. **虚拟鼠标键盘**：AI 操作屏幕时通过窗口消息投递输入，而不是移动真实光标、
 *      占用真实键盘。用户因此可以同时用自己的鼠标和键盘操作同一台电脑，
 *      AI 与用户互不打架。
 *
 *   2. **屏幕操作中的悬浮提示**：AI 一动手，屏幕角落就出现一个置顶、
 *      半透明、点击穿透、**不抢焦点**的小窗提示「AI 正在操作电脑」，
 *      让用户始终知道电脑正在被 AI 控制。
 *
 *   3. **双击 ESC 中断**：全局监听键盘，连续按两下 ESC（默认 400ms 内）
 *      立即中断 AI 正在跑的脚本操作。中断是"粘住"的——之后的电脑操作调用
 *      都会被拒绝，直到显式复位，避免 AI 无视用户意图继续操作。
 *
 * 三个模块的协作关系（全部经 OperationTracker 裁决）：
 *
 *     AI 调用工具 → tracker.begin() → 悬浮窗亮起 + 中断武装
 *                  → 执行虚拟输入
 *                  → tracker.end()   → 空闲 linger 后悬浮窗熄灭
 *
 *     用户按两下 ESC → esc-abort 触发 → tracker.abort()
 *                  → 悬浮窗切换为"已中断"提示 → 后续工具调用被拒绝
 *
 * 全部能力都做了降级：koffi 不可用、钩子装不上、悬浮窗建不出来，都只让对应
 * 功能失效并在 status 里说明原因，绝不让宿主进程崩溃或影响聊天功能。
 */

import { loadWin32, describeNative } from './lib/native.js';
import { OperationTracker } from './lib/tracker.js';
import { buildTools } from './lib/tools.js';
import { foregroundWindow } from './lib/windows.js';

/** 默认配置。 */
const DEFAULTS = {
  /** 是否显示「屏幕操作中」悬浮窗。 */
  overlay: true,
  /** 悬浮窗文案。 */
  overlayText: 'AI 正在操作电脑',
  /** 中断后悬浮窗显示的文案。 */
  overlayAbortedText: 'AI 操作已被中断',
  /** 悬浮窗位置：'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'。 */
  overlayPosition: 'top-right',
  /** 是否把电脑操作工具注册给模型。 */
  tools: true,
  /** 是否加载画面识别能力（截图 / OCR / UI 控件树 / 模板匹配）。 */
  vision: true,
  /** 空闲后悬浮窗延迟隐藏的毫秒数（避免连续操作时闪烁）。 */
  lingerMs: 1200,
  /** 双击 ESC 中断配置。 */
  escAbort: {
    enabled: true,
    thresholdMs: 400,
    cooldownMs: 400,
  },
};

/** 深合并配置（只处理本插件用到的两层结构）。 */
function resolveConfig(raw) {
  const config = { ...DEFAULTS, ...(raw ?? {}) };
  config.escAbort = { ...DEFAULTS.escAbort, ...(raw?.escAbort ?? {}) };
  return config;
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);

  /** 活动追踪器：悬浮窗与中断的唯一裁决者。 */
  const tracker = new OperationTracker({ lingerMs: config.lingerMs });

  /** 各子模块的运行态句柄；undefined 表示尚未初始化。 */
  const runtime = {
    overlay: undefined,
    escAbort: undefined,
    /** 虚拟输入模块（动态 import，避免静态依赖尚未就绪的模块时整体加载失败）。 */
    virtualInput: undefined,
    /** 视觉能力模块：截图 / OCR / UIA 控件树 / 模板匹配。 */
    capture: undefined,
    ocr: undefined,
    uia: undefined,
    templateMatch: undefined,
    /** 初始化过程中的错误，供 status 报告。 */
    initErrors: [],
  };

  /** 是否已完成初始化。 */
  let initialized = false;
  /** 初始化 Promise，保证只跑一次。 */
  let initPromise;

  /**
   * 惰性初始化：只在实际需要时才加载虚拟输入/悬浮窗/钩子。
   *
   * 这样做的好处是插件加载本身永远轻量、永远成功；即使某个子模块有问题，
   * 也只影响用到它的那条路径，不会拖垮 profile 启动。
   */
  async function ensureInitialized() {
    if (initialized) return;
    if (initPromise !== undefined) return initPromise;

    initPromise = (async () => {
      // --- 虚拟输入层 ---
      try {
        const mod = await import('./lib/virtual-input.js');
        runtime.virtualInput = mod;
      } catch (error) {
        runtime.initErrors.push(`virtual-input: ${error?.message ?? String(error)}`);
      }

      // --- 视觉能力层（全部可选，缺失只影响对应工具）---
      if (config.vision !== false) {
        for (const [key, file, label] of [
          ['capture', './lib/capture.js', 'capture'],
          ['ocr', './lib/ocr.js', 'ocr'],
          ['uia', './lib/uia.js', 'uia'],
          ['templateMatch', './lib/template-match.js', 'template-match'],
        ]) {
          try {
            runtime[key] = await import(file);
          } catch (error) {
            // 视觉模块是可选增强：缺失不应让插件整体不可用。
            runtime.initErrors.push(`${label}: ${error?.message ?? String(error)}`);
          }
        }
      }

      // --- 悬浮窗 ---
      if (config.overlay === true) {
        try {
          const mod = await import('./lib/overlay.js');
          const created = mod.createOverlay?.({
            text: config.overlayText,
            position: config.overlayPosition,
          });
          if (created !== undefined && created !== null) {
            runtime.overlay = created;
            // 追踪器状态 → 悬浮窗显隐，这是"AI 一动手就提示"的接线点。
            tracker.on('active', () => {
              try {
                created.show?.(tracker.status().aborted ? config.overlayAbortedText : config.overlayText);
              } catch (error) {
                runtime.initErrors.push(`overlay.show: ${error?.message ?? String(error)}`);
              }
            });
            tracker.on('idle', () => {
              try {
                created.hide?.();
              } catch (error) {
                runtime.initErrors.push(`overlay.hide: ${error?.message ?? String(error)}`);
              }
            });
            tracker.on('abort', () => {
              try {
                created.update?.(config.overlayAbortedText);
              } catch (error) {
                runtime.initErrors.push(`overlay.update: ${error?.message ?? String(error)}`);
              }
            });
            tracker.on('reset', () => {
              try {
                created.update?.(config.overlayText);
              } catch (error) {
                runtime.initErrors.push(`overlay.update: ${error?.message ?? String(error)}`);
              }
            });
          } else {
            runtime.initErrors.push('overlay: createOverlay() returned nothing');
          }
        } catch (error) {
          runtime.initErrors.push(`overlay: ${error?.message ?? String(error)}`);
        }
      }

      // --- 双击 ESC 中断 ---
      if (config.escAbort.enabled === true) {
        try {
          const mod = await import('./lib/esc-abort.js');
          const created = mod.createEscAbort?.({
            thresholdMs: config.escAbort.thresholdMs,
            cooldownMs: config.escAbort.cooldownMs,
          });
          if (created !== undefined && created !== null) {
            runtime.escAbort = created;
            // 中断触发 → 追踪器 abort → 悬浮窗提示 + 后续工具调用被拒。
            created.onAbort?.((event) => {
              tracker.abort(event?.source ?? 'double-escape');
            });
            const installed = await created.install?.();
            if (installed !== undefined && installed.ok === false) {
              runtime.initErrors.push(`esc-abort install: ${installed.reason ?? 'unknown'}`);
            }
          } else {
            runtime.initErrors.push('esc-abort: createEscAbort() returned nothing');
          }
        } catch (error) {
          runtime.initErrors.push(`esc-abort: ${error?.message ?? String(error)}`);
        }
      }

      initialized = true;
    })();

    return initPromise;
  }

  /** 复位中断状态（同时复位钩子侧与追踪器侧）。 */
  async function resetAbort() {
    try {
      await runtime.escAbort?.reset?.();
    } catch (error) {
      runtime.initErrors.push(`esc-abort reset: ${error?.message ?? String(error)}`);
    }
    tracker.reset();
    return { ok: true };
  }

  /** 汇总状态，供 vcu_status 工具与诊断使用。 */
  function status() {
    const native = describeNative();
    const nativeUsable = loadWin32().reason === undefined;
    const opt = tracker.status();
    /** 视觉能力可用性概览：模块是否加载成功。 */
    const vision = {
      capture: runtime.capture !== undefined,
      ocr: runtime.ocr !== undefined,
      uia: runtime.uia !== undefined,
      templateMatch: runtime.templateMatch !== undefined,
    };
    const visionReady = Object.values(vision).some(Boolean);
    return {
      ok: nativeUsable,
      supported: nativeUsable,
      summary: nativeUsable
        ? `虚拟鼠标键盘可用；画面识别${visionReady ? `部分可用（${Object.entries(vision).filter(([, v]) => v).map(([k]) => k).join('/')}）` : '不可用'}；`
          + `${opt.active ? '当前正在操作电脑' : '当前空闲'}`
          + `${opt.aborted ? '；**已被用户双击 ESC 中断**（需复位后才能继续）' : ''}。`
        : `虚拟鼠标键盘不可用：${native.reason}`,
      native,
      operation: opt,
      vision,
      escAbort: runtime.escAbort?.status?.() ?? { ok: false, reason: 'not initialized (no operation yet)' },
      overlay: runtime.overlay?.status?.() ?? { ok: false, reason: config.overlay === true ? 'not initialized (no operation yet)' : 'disabled by config' },
      initErrors: [...runtime.initErrors],
      config: {
        overlay: config.overlay,
        overlayText: config.overlayText,
        lingerMs: config.lingerMs,
        vision: config.vision,
        escAbort: config.escAbort,
      },
    };
  }

  /**
   * 包装工具执行：每个工具调用前确保初始化完成。
   *
   * 注意区分两类工具：
   *   - 需要虚拟输入的工具（点击/输入等）：virtualInput 缺失时必须拒绝，否则会
   *     出现"报告成功但什么都没发生"的假成功。
   *   - 只读视觉工具（截图/OCR/UIA/找图）：不依赖 virtualInput，只需视觉模块；
   *     各自在 execute 内部检查自己依赖的模块。
   */
  const VISION_TOOLS = new Set(['vcu_screenshot', 'vcu_ocr', 'vcu_ui_tree', 'vcu_find_image', 'vcu_save_template', 'vcu_video_capability']);
  const NO_INPUT_TOOLS = new Set(['vcu_status', 'vcu_reset_abort', 'vcu_list_windows', 'vcu_find_window', 'vcu_window_info', 'vcu_foreground_window']);

  function withInit(tools) {
    return tools.map((tool) => ({
      ...tool,
      async execute(args, exec) {
        await ensureInitialized();
        const needsInput = !VISION_TOOLS.has(tool.name) && !NO_INPUT_TOOLS.has(tool.name);
        if (needsInput && runtime.virtualInput === undefined) {
          return {
            ok: false,
            reason: '虚拟输入模块不可用',
            summary: `虚拟输入模块加载失败：${runtime.initErrors.join('; ') || '未知原因'}`,
          };
        }
        return tool.execute(args, exec);
      },
    }));
  }

  // -------------------------------------------------------------------------
  // 1. 注册 Agent 工具
  // -------------------------------------------------------------------------
  if (config.tools !== false) {
    ctx.inject(['tools'], (scope) => {
      const definitions = withInit(
        buildTools({
          get virtualInput() {
            return runtime.virtualInput;
          },
          // 视觉模块同样用 getter 惰性取，保证 ensureInitialized() 之后拿到的是最新引用。
          get capture() {
            return runtime.capture;
          },
          get ocr() {
            return runtime.ocr;
          },
          get uia() {
            return runtime.uia;
          },
          get templateMatch() {
            return runtime.templateMatch;
          },
          // 截图要变成模型能看的 ImageBlock，必须先经 attachments 服务落盘成
          // 持久引用（`sha256:…`）。这里用 getter：attachments 服务可能晚于本
          // 插件挂载，也可能根本没挂 —— 拿不到时截图工具自动降级为纯文字。
          get attachments() {
            return ctx.get('attachments');
          },
          tracker,
          resetAbort,
          status,
        }),
      );
      for (const definition of definitions) {
        scope.effect(
          () => scope.tools.register(definition),
          `virtual-computer-use: tool ${definition.name}`,
        );
      }
    });
  }

  // -------------------------------------------------------------------------
  // 2. 诊断路由（供手工排查；不依赖 tools 服务）
  // -------------------------------------------------------------------------
  ctx.inject(['webServer', 'connection'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/virtual-computer-use/status',
      handler: (req, res) => {
        const rejection = scope.connection.requestRejection(req);
        if (rejection !== undefined && rejection !== null) {
          res.statusCode = Number(rejection) || 403;
          res.end();
          return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405;
          res.setHeader('allow', 'GET, HEAD');
          res.end();
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify(status(), null, 2));
      },
    }), 'virtual-computer-use: GET /virtual-computer-use/status');

    // 手动控制悬浮窗与中断，便于用户排查/演示。
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/virtual-computer-use/control',
      handler: async (req, res) => {
        const rejection = scope.connection.requestRejection(req);
        if (rejection !== undefined && rejection !== null) {
          res.statusCode = Number(rejection) || 403;
          res.end();
          return;
        }
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('allow', 'POST');
          res.end();
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try {
          const text = Buffer.concat(chunks).toString('utf8').trim();
          body = text === '' ? {} : JSON.parse(text);
        } catch {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
          return;
        }

        await ensureInitialized();
        const action = String(body?.action ?? '');
        let result;
        switch (action) {
          case 'show-overlay':
            result = runtime.overlay?.show?.(config.overlayText) ?? { ok: false, reason: 'overlay unavailable' };
            break;
          case 'hide-overlay':
            result = runtime.overlay?.hide?.() ?? { ok: false, reason: 'overlay unavailable' };
            break;
          case 'abort':
            result = tracker.abort('manual');
            break;
          case 'reset':
            result = await resetAbort();
            break;
          case 'focus-check': {
            const fg = foregroundWindow();
            result = { ok: fg.ok === true, foreground: fg.window ?? null };
            break;
          }
          default:
            result = { ok: false, reason: `unknown action: ${action || '(empty)'}. Use one of show-overlay, hide-overlay, abort, reset, focus-check.` };
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify({ action, ...result, status: status() }, null, 2));
      },
    }), 'virtual-computer-use: POST /virtual-computer-use/control');
  });

  // -------------------------------------------------------------------------
  // 3. 清理
  // -------------------------------------------------------------------------
  ctx.effect(() => () => {
    try {
      tracker.dispose();
    } catch {
      // 清理失败不影响宿主退出。
    }
    // 逐个关停子模块，互不影响。
    void (async () => {
      for (const [name, fn] of [
        ['esc-abort', () => runtime.escAbort?.uninstall?.()],
        // overlay 没有 dispose()（它只提供 show/hide/update/setPosition/isVisible/
        // configure/status）。清理走 hide()：它会销毁窗口并清掉两个 unref 过的
        // 定时器；`dispose` 调用保留为可选，以防将来模块补上该方法。
        ['overlay', () => runtime.overlay?.hide?.() ?? runtime.overlay?.dispose?.()],
      ]) {
        try {
          await fn();
        } catch {
          // 已随进程退出失效时忽略。
        }
      }
    })();
  }, 'virtual-computer-use: cleanup');
}
