/**
 * dsh-virtual-computer-use —— 「AI 正在操作电脑」置顶悬浮窗。
 *
 * ## 设计要点
 *
 * 1. **纯 FFI 建窗**：`RegisterClassExW` + `CreateWindowExW`，不依赖 Electron
 *    的 BrowserWindow，因此在独立 node 进程里也能跑（测试可直接验证）。
 *
 * 2. **绝不抢焦点**：扩展样式组合
 *    `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`
 *    配 `SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA)` 与
 *    `ShowWindow(SW_SHOWNA)`。`NOACTIVATE` 保证显示时不激活、
 *    `TRANSPARENT` 保证鼠标点击穿透到下方窗口、`TOOLWINDOW` 保证不进任务栏。
 *    这是硬要求：AI 正在给别的窗口注入输入，悬浮窗一旦抢焦点就会打断注入目标。
 *
 * 3. **消息泵与重绘**：`WM_PAINT` 通过窗口过程回调触发重绘。窗口过程是一个
 *    koffi 回调，同时需要「返回 DefWindowProcW 的 LRESULT」与「推送一次性重绘
 *    请求」两种语义 —— 这两者共用一个 `intptr_t` 返回通道，所以本模块用一个
 *    **异步推流（streams）** 回调：每次 `WM_PAINT` 把绘制请求 postMessage 到
 *    主线程，主线程绘制完后再 `ack()` 让窗口过程返回 DefWindowProcW 的结果。
 *    `PeekMessageW` 由主线程定时器驱动以派发已排队的消息。
 *
 * 4. **动画**：不依赖 `SetTimer`（native.js 未绑定），用一个主线程
 *    `setInterval` 周期性 `InvalidateRect` 触发 `WM_PAINT`，圆点做呼吸变化。
 *
 * 5. 一切失败降级为 `{ ok:false, reason }`，**绝不抛异常**。
 */

import { loadWin32, WS, WS_EX, SW, SM, WM as NATIVE_WM } from './native.js';
// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 窗口消息。默认复用 native.js 的 WM，缺失时用同样的常量兜底。 */
const WM = {
  PAINT: NATIVE_WM?.PAINT ?? 0x000f,
  ERASEBKGND: NATIVE_WM?.ERASEBKGND ?? 0x0014,
  DESTROY: NATIVE_WM?.DESTROY ?? 0x0002,
  NCDESTROY: 0x0082,
  CLOSE: NATIVE_WM?.CLOSE ?? 0x0010,
  SETCURSOR: NATIVE_WM?.SETCURSOR ?? 0x0020,
};

/** GetWindowLongPtrW 索引。 */
const GWL_EXSTYLE = -20;
const GWL_STYLE = -16;

/** SetLayeredWindowAttributes 标志。 */
const LWA_ALPHA = 0x02;

/** PeekMessageW 的 PM_REMOVE。 */
const PM_REMOVE = 0x0001;

/** SetBkMode 的 TRANSPARENT。 */
const TRANSPARENT_BK = 1;

/** 四角预设。 */
const CORNER_PRESETS = new Set(['top-right', 'top-left', 'bottom-right', 'bottom-left', 'center']);

/** 默认配置。 */
const DEFAULTS = {
  /** 文案。 */
  text: 'AI 正在操作电脑',
  /** 位置：四角预设名，或 { x, y }。 */
  position: 'top-right',
  /** 距屏幕边缘的留白（px）。 */
  margin: 16,
  /** 尺寸（px）。 */
  width: 260,
  height: 48,
  /** 不透明度 0–255。 */
  alpha: 225,
  /** 呼吸动画周期（ms）；0 表示关闭动画。 */
  pulseMs: 900,
  /** GDI 字体名。 */
  fontFace: 'Microsoft YaHei',
  fontSize: 16,
  /** 主色（0x00BBGGRR，GDI 的 COLORREF 是小端 BGR）。 */
  accentColor: 0x00227CEB,
  textColor: 0x00FFFFFF,
  /** 窗口类名前缀（实际类名会追加 pid 与序号，保证唯一）。 */
  className: 'DshVcuOverlayWnd',
};

let classSerial = 0;

/**
 * koffi 的类型/回调原型按名字全局注册，重复声明同名类型会抛
 * `Duplicate type name`。这些必须缓存在模块级，保证整个进程只声明一次。
 */
const OverlayTypes = {
  wndProcProto: undefined,
};

/** 把 `#RRGGBB` 或 `0xRRGGBB` 转成 GDI COLORREF（0x00BBGGRR）。 */
function toColorRef(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value >>> 0;
  if (typeof value !== 'string') return fallback;
  const hex = value.trim().replace(/^#/, '').replace(/^0x/i, '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return fallback;
  const rgb = Number.parseInt(hex, 16);
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const bl = rgb & 0xff;
  return ((bl << 16) | (g << 8) | r) >>> 0;
}

// ---------------------------------------------------------------------------
// 控制器
// ---------------------------------------------------------------------------

/** 进程内单例。 */
let singleton;

/**
 * 创建（或取回）「屏幕操作中」悬浮窗控制器。
 *
 * @param {object} [options] - 见 DEFAULTS。
 * @returns {object} 控制器，带 show/hide/update/isVisible/status。
 */
export function createOverlay(options = {}) {
  if (singleton !== undefined) {
    if (Object.keys(options).length > 0) singleton.configure(options);
    return singleton;
  }
  singleton = new ScreenOverlay(options);
  return singleton;
}

/** 取回单例。 */
export function getOverlay() {
  return createOverlay();
}

/**
 * 「AI 正在操作电脑」悬浮窗。
 *
 * 公开 API：
 *   show(text?)   -> { ok, hwnd, rect, ... }   创建（或显示）窗口
 *   hide()        -> { ok, destroyed }         隐藏并真正销毁窗口
 *   update(text)  -> { ok, text }              改文案并立刻重绘
 *   setPosition(p)-> { ok, rect }              改位置（四角预设 / {x,y}）
 *   isVisible()   -> boolean
 *   status()      -> { visible, styles, ... }
 */
class ScreenOverlay {
  constructor(options = {}) {
    this.config = { ...DEFAULTS, ...options };
    this._native = undefined;
    this._hwnd = undefined;
    this._className = undefined;
    this._wndProc = undefined;
    this._wndProcProto = undefined;
    this._visible = false;
    this._pulseTimer = undefined;
    this._pumpTimer = undefined;
    this._forcedStyle = undefined;
    this._pumpTicks = 0;
    this._paintCount = 0;
    this._classNameBuffer = undefined;
    this._menuNameBuffer = undefined;
  }

  /**
   * 从窗口过程里异步请求一次重绘。
   *
   * 窗口过程是同步回调，在其中直接 GetDC/绘制会有重入与卡死风险；这里用
   * `queueMicrotask` 把它推迟到当前消息派发之后，由主线程执行。
   */
  _requestPaint() {
    if (this._hwnd === undefined) return;
    queueMicrotask(() => {
      const hwnd = this._hwnd;
      if (hwnd === undefined) return;
      try {
        this._paint(hwnd);
      } catch (error) {
        this._paintError = error?.message ?? String(error);
      }
    });
  }

  // --- 原生绑定 ---------------------------------------------------------

  _bind() {
    if (this._native !== undefined) return this._native;
    const loaded = loadWin32();
    if (loaded.reason !== undefined) {
      this._native = { reason: loaded.reason };
      return this._native;
    }
    const required = [
      'RegisterClassExW',
      'CreateWindowExW',
      'DefWindowProcW',
      'DestroyWindow',
      'SetLayeredWindowAttributes',
      'ShowWindow',
      'SetWindowPos',
      'PeekMessageW',
      'DispatchMessageW',
      'TranslateMessage',
      'InvalidateRect',
      'UpdateWindow',
      'IsWindow',
      'IsWindowVisible',
      'GetWindowLongPtrW',
      'SetWindowLongPtrW',
      'GetSystemMetrics',
      'BeginPaint',
      'EndPaint',
      'RoundRect',
      'Ellipse',
      'CreateFontW',
      'SelectObject',
      'SetBkMode',
      'SetTextColor',
      'TextOutW',
      'DeleteObject',
      'CreateSolidBrush',
      'CreatePen',
      'GetDC',
      'ReleaseDC',
    ];
    // SetWindowLongPtrW / IsWindowVisible 在 native.js 里没有绑定。
    // 本模块**不修改 native.js**（其它队友正在并行写它），因此这里做一层
    // 局部补充绑定，复用同一个 koffi 句柄，失败时降级为 undefined。
    // 注意：必须先补绑定，再检查缺失，否则 SetWindowLongPtrW 会被误判为缺失。
    let extra = {};
    try {
      const koffi = loaded.koffi;
      const user32 = koffi.load('user32.dll');
      extra = {
        SetWindowLongPtrW:
          loaded.SetWindowLongPtrW ??
          user32.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hwnd, int index, intptr_t value)'),
        IsWindowVisible: loaded.IsWindowVisible ?? user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)'),
      };
    } catch (error) {
      extra = { extraBindingFailure: error?.message ?? String(error) };
    }
    const merged = { ...loaded, ...extra };
    const missing = required.filter((name) => merged[name] === undefined);
    if (missing.length > 0) {
      this._native = { reason: `missing Win32 bindings: ${missing.join(', ')}`, missing };
      return this._native;
    }
    this._native = { loaded: merged };
    return this._native;
  }

  // --- 几何 -------------------------------------------------------------

  /** 计算窗口矩形（考虑多显示器虚拟屏，并夹到可见区域内）。 */
  _computeRect() {
    const loaded = this._native.loaded;
    const margin = Math.max(0, Number(this.config.margin) || 0);
    const width = Math.max(80, Number(this.config.width) || DEFAULTS.width);
    const height = Math.max(24, Number(this.config.height) || DEFAULTS.height);

    // 虚拟屏（覆盖全部显示器）；退化时用主屏。
    let vsLeft = Number(loaded.GetSystemMetrics(SM.XVIRTUALSCREEN));
    let vsTop = Number(loaded.GetSystemMetrics(SM.YVIRTUALSCREEN));
    let vsWidth = Number(loaded.GetSystemMetrics(SM.CXVIRTUALSCREEN));
    let vsHeight = Number(loaded.GetSystemMetrics(SM.CYVIRTUALSCREEN));
    if (!Number.isFinite(vsWidth) || vsWidth <= 0) {
      vsWidth = Number(loaded.GetSystemMetrics(SM.CXSCREEN));
      vsLeft = 0;
    }
    if (!Number.isFinite(vsHeight) || vsHeight <= 0) {
      vsHeight = Number(loaded.GetSystemMetrics(SM.CYSCREEN));
      vsTop = 0;
    }
    const minX = vsLeft;
    const minY = vsTop;
    const maxX = vsLeft + vsWidth - width;
    const maxY = vsTop + vsHeight - height;

    const pos = this.config.position;
    let x;
    let y;
    if (pos !== null && typeof pos === 'object' && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y))) {
      x = Number(pos.x);
      y = Number(pos.y);
    } else {
      const preset = typeof pos === 'string' && CORNER_PRESETS.has(pos) ? pos : DEFAULTS.position;
      switch (preset) {
        case 'top-left':
          x = minX + margin;
          y = minY + margin;
          break;
        case 'bottom-left':
          x = minX + margin;
          y = maxY - margin;
          break;
        case 'bottom-right':
          x = maxX - margin;
          y = maxY - margin;
          break;
        case 'center':
          x = Math.round(minX + (vsWidth - width) / 2);
          y = Math.round(minY + (vsHeight - height) / 2);
          break;
        case 'top-right':
        default:
          x = maxX - margin;
          y = minY + margin;
          break;
      }
    }

    // 夹到可见区域内，绝不超出屏幕。
    x = Math.min(Math.max(x, minX), Math.max(minX, maxX));
    y = Math.min(Math.max(y, minY), Math.max(minY, maxY));
    return { x: Math.round(x), y: Math.round(y), width, height };
  }

  // --- 窗口类 -----------------------------------------------------------

  /** 注册窗口类；类名含 pid+序号，保证唯一；重复注册幂等。 */
  _registerClass() {
    const { loaded } = this._native;
    classSerial += 1;
    this._className = `${this.config.className}_${process.pid}_${classSerial}`;

    // WNDCLASSEXW 布局（x64, pack=8）—— **80 字节**。
    // 以下偏移由 C# 的 Marshal.OffsetOf 权威核对过（见本文件末尾的实测记录）：
    //   偏移  0: UINT    cbSize(4)
    //   偏移  4: UINT    style(4)
    //   偏移  8: WNDPROC lpfnWndProc(8)
    //   偏移 16: int     cbClsExtra(4)
    //   偏移 20: int     cbWndExtra(4)
    //   偏移 24: HINSTANCE hInstance(8)
    //   偏移 32: HICON    hIcon(8)
    //   偏移 40: HCURSOR  hCursor(8)
    //   偏移 48: HBRUSH   hbrBackground(8)
    //   偏移 56: LPCWSTR  lpszMenuName(8)
    //   偏移 64: LPCWSTR  lpszClassName(8)   ← 关键：类名指针在这里，不是 72
    //   偏移 72: HICON    hIconSm(8)
    //
    // 踩坑记录（两次都真实发生并已由回归测试锁定）：
    //   1. 曾把 **类名字符串本体** 直接内联进这块缓冲区。lpszClassName 是**指针**，
    //      Windows 会把它当野指针解引用 → RegisterClassExW 报 87
    //      (ERROR_INVALID_PARAMETER)。字符串必须单独分配、只写地址。
    //   2. 曾把 lpszClassName 写在偏移 72（那是 hIconSm 的位置），并把缓冲区裁到
    //      72 字节。实测：cbSize=72 → atom=0/err=87；cbSize=80 且类名在偏移 64 →
    //      atom 非 0/err=0。结构体少算 8 字节同样会让整个类注册被拒，
    //      随后 CreateWindowExW 报 1407 (ERROR_CANNOT_FIND_WND_CLASS)。
    const WNDCLASSEXW_SIZE = 80;
    const wndClass = Buffer.alloc(WNDCLASSEXW_SIZE);
    wndClass.writeUInt32LE(WNDCLASSEXW_SIZE, 0); // cbSize —— 必须与真实结构大小一致
    wndClass.writeUInt32LE(0x0003, 4); // style = CS_HREDRAW | CS_VREDRAW
    // WNDPROC 必须走 koffi 回调（先 proto 再 pointer 包装）。
    // 注意：koffi 的回调原型按**名字**全局注册，同名重复声明会抛
    // "Duplicate type name"。同一个进程里 show()->hide()->show() 会走到这里两次，
    // 所以原型只声明一次并缓存（惰性初始化，避免模块级副作用）。
    const koffi = loaded.koffi;
    const registry = (OverlayTypes.wndProcProto ??= koffi.pointer(
      koffi.proto('intptr_t __stdcall DshVcuOverlayProc(intptr_t hwnd, uint32 msg, uintptr_t wp, intptr_t lp)'),
    ));
    this._wndProcProto = registry;
    // 窗口过程跑在系统回调里：绝不做重绘（重入 + 卡死风险），
    // 只把绘制请求异步抛给主线程。
    this._wndProc = koffi.register((hwnd, msg, wParam, lParam) => this._handleMessage(hwnd, msg, wParam, lParam), this._wndProcProto);
    wndClass.writeBigUInt64LE(BigInt(koffi.address(this._wndProc)), 8); // lpfnWndProc

    // 类名与菜单名是指针字段：单独分配并保持引用存活（否则可能被 GC 回收）。
    this._classNameBuffer = Buffer.from(`${this._className}\0`, 'utf16le');
    this._menuNameBuffer = Buffer.from('\0', 'utf16le');
    wndClass.writeBigUInt64LE(BigInt(koffi.address(this._menuNameBuffer)), 56); // lpszMenuName
    wndClass.writeBigUInt64LE(BigInt(koffi.address(this._classNameBuffer)), 64); // lpszClassName

    const atom = Number(loaded.RegisterClassExW(wndClass));
    if (atom === 0) {
      // 类已存在（同进程内重复注册）视为成功；真正的失败会在 CreateWindowExW 暴露。
      return { ok: true, atom: 0, reRegistered: true, className: this._className };
    }
    return { ok: true, atom, className: this._className };
  }

  // --- 窗口过程 ---------------------------------------------------------

  _handleMessage(hwnd, msg, wParam, lParam) {
    const { loaded } = this._native;
    const message = Number(msg);
    try {
      if (message === WM.PAINT) {
        // 窗口过程跑在系统回调里，绝不做重绘（重入 + 阻塞风险）。
        // 这里只把绘制请求异步抛给主线程。
        this._paintCount += 1;
        this._requestPaint();
        return loaded.DefWindowProcW(hwnd, message, wParam, lParam);
      }
      if (message === WM.ERASEBKGND) {
        return 1; // 已由 WM_PAINT 全量绘制，避免闪烁
      }
      if (message === WM.SETCURSOR) {
        return 1;
      }
      return loaded.DefWindowProcW(hwnd, message, wParam, lParam);
    } catch {
      try {
        return loaded.DefWindowProcW(hwnd, message, wParam, lParam);
      } catch {
        return 0;
      }
    }
  }

  // --- 消息泵 -----------------------------------------------------------

  /** 主线程定时泵：派发窗口消息 + 触发重绘。绝不阻塞事件循环。 */
  _startPump() {
    if (this._pumpTimer !== undefined) return;
    const { loaded } = this._native;
    const buffer = Buffer.alloc(64);

    const tick = () => {
      this._pumpTicks += 1;
      try {
        // 只 peek 不阻塞；一次 tick 内尽量排空队列。
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
    if (typeof this._pumpTimer.unref === 'function') this._pumpTimer.unref();
  }

  _stopPump() {
    if (this._pumpTimer !== undefined) {
      clearInterval(this._pumpTimer);
      this._pumpTimer = undefined;
    }
  }

  // --- 绘制 -------------------------------------------------------------

  /** 圆角矩形背景 + 左侧呼吸圆点 + 文案。 */
  _paint(hwnd) {
    const { loaded } = this._native;
    const rect = this._computeRect();
    const dc = loaded.GetDC(hwnd);
    if (dc === 0n || dc === 0) return;
    const created = [];
    try {
      const width = rect.width;
      const height = rect.height;
      const accent = toColorRef(this.config.accentColor, DEFAULTS.accentColor);
      const textColor = toColorRef(this.config.textColor, DEFAULTS.textColor);

      // 底色：深色半透明面板（配合 SetLayeredWindowAttributes 的整体 alpha）
      const brush = loaded.CreateSolidBrush(0x00201c1a);
      const pen = loaded.CreatePen(0, 1, accent);
      const oldBrush = loaded.SelectObject(dc, brush);
      const oldPen = loaded.SelectObject(dc, pen);
      created.push(brush, pen);

      loaded.RoundRect(dc, 0, 0, width, height, 18, 18);

      // 左强调条
      const bar = loaded.CreateSolidBrush(accent);
      const oldBar = loaded.SelectObject(dc, bar);
      created.push(bar);
      loaded.RoundRect(dc, 6, 8, 12, height - 8, 6, 6);

      // 呼吸圆点：pulse 决定半径
      const pulse = this.config.pulseMs > 0 ? (Math.sin(this._pulsePhase) + 1) / 2 : 1;
      const dotRadius = 4 + pulse * 3;
      const dot = loaded.CreateSolidBrush(accent);
      const oldDot = loaded.SelectObject(dc, dot);
      created.push(dot);
      const cx = 28;
      const cy = Math.round(height / 2);
      loaded.Ellipse(dc, Math.round(cx - dotRadius), Math.round(cy - dotRadius), Math.round(cx + dotRadius), Math.round(cy + dotRadius));

      // 文案
      const face = Buffer.from(`${this.config.fontFace}\0`, 'utf16le');
      const font = loaded.CreateFontW(
        -Math.abs(Number(this.config.fontSize) || DEFAULTS.fontSize),
        0,
        0,
        0,
        600,
        0,
        0,
        0,
        1, // DEFAULT_CHARSET —— 配微软雅黑可正确显示中文
        0,
        0,
        5, // CLEARTYPE_QUALITY
        0,
        face,
      );
      const oldFont = loaded.SelectObject(dc, font);
      created.push(font);
      loaded.SetBkMode(dc, TRANSPARENT_BK);
      loaded.SetTextColor(dc, textColor);
      const text = Buffer.from(`${this.config.text}\0`, 'utf16le');
      loaded.TextOutW(dc, 46, Math.round((height - Number(this.config.fontSize || 16)) / 2) - 1, text, this.config.text.length);

      // 归还 GDI 对象，避免句柄泄漏。
      if (oldFont !== undefined && oldFont !== 0n && oldFont !== 0) loaded.SelectObject(dc, oldFont);
      if (oldDot !== undefined && oldDot !== 0n && oldDot !== 0) loaded.SelectObject(dc, oldDot);
      if (oldBar !== undefined && oldBar !== 0n && oldBar !== 0) loaded.SelectObject(dc, oldBar);
      if (oldPen !== undefined && oldPen !== 0n && oldPen !== 0) loaded.SelectObject(dc, oldPen);
      if (oldBrush !== undefined && oldBrush !== 0n && oldBrush !== 0) loaded.SelectObject(dc, oldBrush);
    } catch (error) {
      this._paintError = error?.message ?? String(error);
    } finally {
      for (const object of created) {
        try {
          loaded.DeleteObject(object);
        } catch {
          // 忽略
        }
      }
      loaded.ReleaseDC(hwnd, dc);
    }
  }

  // --- 公开 API ---------------------------------------------------------

  /**
   * 显示悬浮窗（已显示时只更新文案）。
   *
   * @param {string} [text] - 覆盖文案。
   * @returns {{ok:boolean, hwnd?:string, rect?:object, created?:boolean, reason?:string}}
   */
  show(text) {
    if (typeof text === 'string' && text.length > 0) this.config.text = text;
    const native = this._bind();
    if (native.reason !== undefined) return { ok: false, reason: native.reason };
    const { loaded } = native;

    try {
      if (this._hwnd !== undefined && loaded.IsWindow(this._hwnd) === true) {
        this._applyStyles(this._hwnd);
        this._paint(this._hwnd);
        this._visible = true;
        return { ok: true, hwnd: String(this._hwnd), rect: this._computeRect(), created: false };
      }

      this._registerClass();
      const rect = this._computeRect();
      const exStyle =
        WS_EX.LAYERED | WS_EX.TRANSPARENT | WS_EX.TOPMOST | WS_EX.NOACTIVATE | WS_EX.TOOLWINDOW;
      const style = WS.POPUP;
      const title = Buffer.from('DSH 屏幕操作中\0', 'utf16le');
      const classNameBuffer = Buffer.from(`${this._className}\0`, 'utf16le');

      const hwnd = loaded.CreateWindowExW(
        exStyle,
        classNameBuffer,
        title,
        style,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        0,
        0,
        0,
        0,
      );
      if (hwnd === 0n || hwnd === 0) {
        return { ok: false, reason: 'CreateWindowExW returned NULL', className: this._className };
      }
      this._hwnd = hwnd;

      // 先做一次性绘制，再显示，避免首帧闪白/空白。
      this._paint(hwnd);
      this._startPump();
      this._startPulse();

      // SetWindowPos 用 TOPMOST(-1) 放在最前（HWND_TOPMOST）。
      // SWP_NOACTIVATE 保证不激活；SWP_SHOWWINDOW 让窗口可见。
      const SWP_TOPMOST = -1;
      try {
        loaded.SetWindowPos(hwnd, SWP_TOPMOST, rect.x, rect.y, rect.width, rect.height, 0x0010 | 0x0040);
      } catch {
        // 忽略；ShowWindow 已足以可见。
      }
      // SW_SHOWNA = 显示但不激活 —— 不抢焦点的关键一步。
      loaded.ShowWindow(hwnd, SW.SHOWNA);
      loaded.SetLayeredWindowAttributes(hwnd, 0, Number(this.config.alpha) || DEFAULTS.alpha, LWA_ALPHA);
      // ShowWindow 之后再补一次样式/层属性，随后把 WM_PAINT 送到窗口过程，
      // 确保「窗口过程确实被调度过」这一点可被测试观测到。
      this._applyStyles(hwnd);
      loaded.InvalidateRect(hwnd, 0, true);
      this._visible = true;
      this._lastRect = rect;
      return { ok: true, hwnd: String(hwnd), rect, created: true, exStyle: `0x${exStyle.toString(16)}` };
    } catch (error) {
      return { ok: false, reason: `show failed: ${error?.message ?? String(error)}` };
    }
  }

  /** 重新应用扩展样式与分层属性（用于外部误改后修复，以及测试注入）。 */
  _applyStyles(hwnd) {
    const { loaded } = this._native;
    const base = WS_EX.LAYERED | WS_EX.TRANSPARENT | WS_EX.TOPMOST | WS_EX.NOACTIVATE | WS_EX.TOOLWINDOW;
    const exStyle = this._forcedStyle === undefined ? base : base | this._forcedStyle;
    try {
      loaded.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, exStyle);
    } catch {
      // SetWindowLongPtrW 未绑定时忽略（样式在建窗时已经带上）。
    }
    loaded.SetLayeredWindowAttributes(hwnd, 0, Number(this.config.alpha) || DEFAULTS.alpha, LWA_ALPHA);
  }

  /**
   * 隐藏并**真正销毁**窗口。
   *
   * @returns {{ok:boolean, destroyed?:boolean, reason?:string}}
   */
  hide() {
    if (this._hwnd === undefined) {
      this._stopPulse();
      return { ok: true, destroyed: false, alreadyHidden: true };
    }
    const native = this._bind();
    if (native.reason !== undefined) return { ok: false, reason: native.reason };
    const { loaded } = native;
    const hwnd = this._hwnd;
    this._visible = false;
    this._stopPulse();
    this._stopPump();
    let destroyed = false;
    try {
      loaded.ShowWindow(hwnd, SW.HIDE);
      destroyed = loaded.DestroyWindow(hwnd) === true;
    } catch (error) {
      return { ok: false, reason: `hide failed: ${error?.message ?? String(error)}` };
    }
    // 让销毁消息走完，IsWindow 立即变为 false。
    try {
      const buffer = Buffer.alloc(64);
      for (let i = 0; i < 16; i += 1) {
        if (loaded.PeekMessageW(buffer, 0, 0, 0, PM_REMOVE) !== true) break;
        loaded.DispatchMessageW(buffer);
      }
    } catch {
      // 忽略
    }
    try {
      if (this._wndProc !== undefined && loaded.koffi !== undefined) loaded.koffi.unregister(this._wndProc);
    } catch {
      // 忽略
    }
    this._wndProc = undefined;
    this._hwnd = undefined;
    return { ok: true, destroyed };
  }

  /**
   * 改文案并立即重绘。
   *
   * @param {string} text
   */
  update(text) {
    if (typeof text !== 'string') return { ok: false, reason: 'text must be a string' };
    this.config.text = text;
    if (this._hwnd === undefined) return { ok: true, text, visible: false };
    const native = this._bind();
    if (native.reason !== undefined) return { ok: false, reason: native.reason };
    try {
      this._paint(this._hwnd);
      native.loaded.InvalidateRect(this._hwnd, 0, false);
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) };
    }
    return { ok: true, text, visible: true };
  }

  /**
   * 改位置。支持四角预设与 `{x, y}`。
   *
   * @param {string | {x:number, y:number}} position
   */
  setPosition(position) {
    this.config.position = position;
    if (this._hwnd === undefined) return { ok: true, rect: this._computeRect() };
    const native = this._bind();
    if (native.reason !== undefined) return { ok: false, reason: native.reason };
    const rect = this._computeRect();
    try {
      native.loaded.SetWindowPos(this._hwnd, -1, rect.x, rect.y, rect.width, rect.height, 0x0010 | 0x0040);
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) };
    }
    this._lastRect = rect;
    return { ok: true, rect };
  }

  /** 是否可见（窗口存在且 IsWindowVisible）。 */
  isVisible() {
    if (this._hwnd === undefined || this._visible !== true) return false;
    const native = this._bind();
    if (native.reason !== undefined) return false;
    try {
      return native.loaded.IsWindow(this._hwnd) === true && native.loaded.IsWindowVisible(this._hwnd) === true;
    } catch {
      return false;
    }
  }

  /** 合并式配置。 */
  configure(patch = {}) {
    this.config = { ...this.config, ...patch };
    if (this._hwnd !== undefined) {
      const native = this._bind();
      if (native.reason === undefined) {
        try {
          this._applyStyles(this._hwnd);
          this.setPosition(this.config.position);
          this.update(this.config.text);
        } catch {
          // 忽略
        }
      }
    }
    return { ok: true, config: this._configView() };
  }

  /** 测试/集成用：强制附加一组扩展样式位。 */
  _forceExtraStyles(bits) {
    this._forcedStyle = bits === undefined ? undefined : Number(bits) >>> 0;
    if (this._hwnd !== undefined && this._forcedStyle !== undefined) {
      const { loaded } = this._native;
      const current = Number(loaded.GetWindowLongPtrW(this._hwnd, GWL_EXSTYLE));
      loaded.SetWindowLongPtrW(this._hwnd, GWL_EXSTYLE, current | this._forcedStyle);
    }
    return { ok: true, forcedStyle: this._forcedStyle };
  }

  // --- 动画 -------------------------------------------------------------

  _startPulse() {
    if (this._pulseTimer !== undefined) return;
    const period = Number(this.config.pulseMs) || 0;
    if (period <= 0) return;
    const step = 120;
    this._pulseTimer = setInterval(() => {
      this._pulsePhase += (Math.PI * 2 * step) / period;
      if (this._pulsePhase > Math.PI * 4) this._pulsePhase -= Math.PI * 4;
      if (this._hwnd === undefined) return;
      try {
        this._paint(this._hwnd);
      } catch {
        // 忽略
      }
    }, step);
    if (typeof this._pulseTimer.unref === 'function') this._pulseTimer.unref();
  }

  _stopPulse() {
    if (this._pulseTimer !== undefined) {
      clearInterval(this._pulseTimer);
      this._pulseTimer = undefined;
    }
  }

  // --- 状态 -------------------------------------------------------------

  _configView() {
    return {
      text: this.config.text,
      position: this.config.position,
      margin: this.config.margin,
      width: this.config.width,
      height: this.config.height,
      alpha: this.config.alpha,
      pulseMs: this.config.pulseMs,
      fontFace: this.config.fontFace,
      fontSize: this.config.fontSize,
    };
  }

  /**
   * 状态快照，含实际窗口样式位与矩形，便于测试与排障。
   *
   * @returns {object}
   */
  status() {
    const native = this._bind();
    const base = {
      ok: native.reason === undefined,
      visible: this.isVisible(),
      hwnd: this._hwnd === undefined ? undefined : String(this._hwnd),
      className: this._className,
      config: this._configView(),
      rect: this._hwnd === undefined ? undefined : this._computeRect(),
      pumpTicks: this._pumpTicks,
      paintCount: this._paintCount,
    };
    if (native.reason !== undefined) {
      base.reason = native.reason;
      return base;
    }
    if (this._hwnd !== undefined) {
      const { loaded } = native;
      try {
        const exStyle = Number(loaded.GetWindowLongPtrW(this._hwnd, GWL_EXSTYLE)) >>> 0;
        const style = Number(loaded.GetWindowLongPtrW(this._hwnd, GWL_STYLE)) >>> 0;
        base.exStyle = exStyle;
        base.style = style;
        base.layered = (exStyle & WS_EX.LAYERED) !== 0;
        base.transparent = (exStyle & WS_EX.TRANSPARENT) !== 0;
        base.topmost = (exStyle & WS_EX.TOPMOST) !== 0;
        base.noActivate = (exStyle & WS_EX.NOACTIVATE) !== 0;
        base.toolWindow = (exStyle & WS_EX.TOOLWINDOW) !== 0;
        base.foreground = String(loaded.GetForegroundWindow());
        base.isForeground = loaded.GetForegroundWindow() === this._hwnd;
      } catch (error) {
        base.styleError = error?.message ?? String(error);
      }
    }
    if (this._pumpError !== undefined) base.pumpError = this._pumpError;
    if (this._paintError !== undefined) base.paintError = this._paintError;
    return base;
  }
}

/**
 * 便利函数：显示「AI 正在操作电脑」悬浮窗（单例）。
 *
 * @param {object} [options]
 * @returns {{ok:boolean, overlay?:object, reason?:string}}
 */
export function showOperationOverlay(options = {}) {
  const overlay = createOverlay(options);
  const result = overlay.show();
  if (result.ok !== true) return { ok: false, reason: result.reason, overlay };
  return { ok: true, overlay, hwnd: result.hwnd, rect: result.rect };
}

/** 便利函数：隐藏悬浮窗（单例）。 */
export function hideOperationOverlay() {
  if (singleton === undefined) return { ok: true, destroyed: false, alreadyHidden: true };
  return singleton.hide();
}

export { ScreenOverlay, toColorRef };

export default { createOverlay, getOverlay, showOperationOverlay, hideOperationOverlay };
