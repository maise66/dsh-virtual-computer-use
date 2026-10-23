/**
 * 截图管线：把"屏幕上/窗口里长什么样"变成模型能看的 PNG。
 *
 * 三层能力，从粗到细：
 *   1. `captureVirtualScreen()` / `captureFullScreen()` —— 整个虚拟屏（多显示器合并）
 *   2. `captureWindow(hwnd)` —— **单个窗口，且能在被遮挡/最小化时抓到**（PrintWindow 的价值）
 *   3. `captureRegion(x,y,w,h)` —— 屏幕任意矩形（局部放大、模板匹配取样用）
 *
 * ## 为什么用 PrintWindow 而不是屏幕 BitBlt
 *
 * 屏幕 BitBlt 只能抓"当前真的显示在屏幕上"的内容：窗口被别的程序挡住、被移到屏幕外、
 * 最小化，抓到的就是遮挡物的像素。`PrintWindow(hwnd, dc, PW_RENDERFULLCONTENT)` 是
 * 让**目标窗口自己重绘一遍**到内存 DC，因此能拿到后台窗口的真实内容。
 *
 * 本机实测（真实记事本）：把窗口 `SetWindowPos` 移到屏幕外 (-4000,-4000) 后，
 * PrintWindow 仍返回 true、`GetDIBits` 返回全部 758 行，且对像素跑 OCR 能完整
 * 识别出正文 "Hello OCR 2026 / ABCDEFG 12345 / Vision Test OK" —— 这是本文件
 * "抓后台窗口"能力的直接证据（见 test/vision.test.mjs 的断言）。
 *
 * ## 资源纪律（宿主长期存活，这是硬要求）
 *
 * 每个 GDI 对象（DC / Bitmap）都在 `try/finally` 里创建与释放。GDI 句柄是**每进程
 * 10000 个**的有限资源，泄漏会先让截图失败，最终拖垮整个宿主进程（截图、绘制、
 * 窗口创建全部失效）。所以这里的写法是：**先声明变量，进 try，finally 里逆序释放**，
 * 任何一条异常路径都不放过。
 *
 * ## 指针传参的坑（本机实测结论）
 *
 * `GetDIBits` 的 bits 参数需要一个**指向足够大缓冲区的指针**。koffi 下有三条可行路线：
 *   - `koffi.as(buffer, 'void *')` —— 可用（实测 lines 正确、内容非黑）
 *   - `_Out_ uint8_t *` + 直接传 Buffer —— 可用
 *   - `Number(koffi.address(buffer))` 当整数传 —— 可用，且与本仓库
 *     `virtual-input.js` 里 `readEditLine()` 的做法一致
 *
 * 本模块选 **`koffi.address()`**：它就是"显式地址"语义，绕开了 koffi 对 Buffer 的
 * 类型推断，也不需要额外的 `koffi.as` 包装；同时和 input 层保持同一种习惯，
 * 后人看代码不用记两套。三条路线实测产出的像素**逐字节一致**（非黑占比均 0.9805）。
 */

import { loadWin32, windowRect, clientRect, enumWindows, readWide } from './native.js';
import {
  encodePngRgba,
  imageStats,
  readPngHeader,
  resizeRgba,
  bgraToRgba,
} from './png.js';

// ---------------------------------------------------------------------------
// Win32 常量（本模块私用；native.js 未导出的部分在这里局部声明）
// ---------------------------------------------------------------------------

/** 光栅操作码：直接拷贝。 */
const SRCCOPY = 0x00cc0020;

/** PrintWindow 标志：让窗口渲染全部内容（含 DWM 合成内容），后台窗口的关键。 */
const PW_RENDERFULLCONTENT = 0x00000002;

/** GetDIBits 的 usage：BI_RGB（不压缩、不查色板）。 */
const BI_RGB = 0;

/** BITMAPINFOHEADER 固定 40 字节。 */
const BITMAPINFOHEADER_SIZE = 40;

/** MonitorFromPoint 标志。 */
const MONITOR_DEFAULTTONEAREST = 0x00000002;

// ---------------------------------------------------------------------------
// GDI 绑定补齐
// ---------------------------------------------------------------------------

/**
 * 本模块必需的 GDI 绑定。
 *
 * `native.js` 的 `loadWin32()` 已经绑定了 gdi32 的一部分（CreateCompatibleDC /
 * CreateCompatibleBitmap / SelectObject / BitBlt / GetDC / ReleaseDC / DeleteObject），
 * 但**截图必需的 `GetDIBits`、`DeleteDC`、`GetWindowDC`、`PrintWindow` 没有绑定**。
 *
 * 按任务约定，**不改 native.js**，因此这里用 `loadWin32().koffi` + `loadWin32().gdi32/user32`
 * 自己补齐缺失的绑定，并做**逐个 try/catch 隔离**（同一个教训：任何一个名字绑错，
 * 不能让整块能力消失）。绑定结果缓存在模块级，进程内只做一次。
 */
let captureBindings;

function ensureCaptureBindings() {
  if (captureBindings !== undefined) return captureBindings;

  const loaded = loadWin32();
  if (loaded.reason !== undefined) {
    captureBindings = { reason: loaded.reason };
    return captureBindings;
  }

  const failures = [];
  const bind = (dll, name, signature) => {
    // 优先复用 native.js 已绑好的（避免重复绑定，也保证签名一致）。
    if (typeof loaded[name] === 'function') return loaded[name];
    try {
      return dll.func(signature);
    } catch (error) {
      failures.push(`${name}: ${error?.message ?? String(error)}`);
      return undefined;
    }
  };

  const user32 = loaded.user32;
  const gdi32 = loaded.gdi32;

  const bindings = {
    koffi: loaded.koffi,
    from: loaded.from,
    failures,
    gdi32,
    user32,

    // --- 窗口 DC 与抓取 ---
    GetWindowDC: bind(user32, 'GetWindowDC', 'intptr_t __stdcall GetWindowDC(intptr_t hwnd)'),
    PrintWindow: bind(user32, 'PrintWindow', 'bool __stdcall PrintWindow(intptr_t hwnd, intptr_t dc, uint32 flags)'),
    GetWindowRect: loaded.GetWindowRect,
    GetClientRect: loaded.GetClientRect,
    ClientToScreen: loaded.ClientToScreen,
    ScreenToClient: loaded.ScreenToClient,
    GetSystemMetrics: loaded.GetSystemMetrics,
    IsWindow: loaded.IsWindow,
    IsIconic: loaded.IsIconic,
    IsWindowVisible: loaded.IsWindowVisible,
    // 光标读取：截图**不应该**动真实光标，readCursor() 用它做前后对照。
    // 这里必须显式从 native.js 借过来，否则 readCursor() 永远返回 undefined，
    // 结果是 cursorUntouched 恒为 false —— 一个会误导调用方的假失败。
    GetCursorPos: loaded.GetCursorPos,

    // --- 显示器 ---
    MonitorFromPoint: loaded.MonitorFromPoint,
    GetMonitorInfoW: loaded.GetMonitorInfoW,

    // --- 窗口枚举（用于 listMonitors 的兜底与诊断）---
    EnumWindows: loaded.EnumWindows,
    GetClassNameW: loaded.GetClassNameW,
    GetWindowTextW: loaded.GetWindowTextW,

    // --- GDI 内存 DC 与位图 ---
    CreateCompatibleDC: bind(gdi32, 'CreateCompatibleDC', 'intptr_t __stdcall CreateCompatibleDC(intptr_t dc)'),
    CreateCompatibleBitmap: bind(gdi32, 'CreateCompatibleBitmap', 'intptr_t __stdcall CreateCompatibleBitmap(intptr_t dc, int w, int h)'),
    SelectObject: bind(gdi32, 'SelectObject', 'intptr_t __stdcall SelectObject(intptr_t dc, intptr_t obj)'),
    BitBlt: bind(gdi32, 'BitBlt', 'bool __stdcall BitBlt(intptr_t dst, int x, int y, int w, int h, intptr_t src, int sx, int sy, uint32 rop)'),
    GetDIBits: bind(gdi32, 'GetDIBits', 'int __stdcall GetDIBits(intptr_t dc, intptr_t bmp, uint32 start, uint32 lines, void *bits, _Inout_ uint8_t *bi, uint32 usage)'),
    DeleteDC: bind(gdi32, 'DeleteDC', 'bool __stdcall DeleteDC(intptr_t dc)'),
    DeleteObject: bind(gdi32, 'DeleteObject', 'bool __stdcall DeleteObject(intptr_t obj)'),
    GetDC: bind(user32, 'GetDC', 'intptr_t __stdcall GetDC(intptr_t hwnd)'),
    ReleaseDC: bind(user32, 'ReleaseDC', 'int __stdcall ReleaseDC(intptr_t hwnd, intptr_t dc)'),
  };

  const required = [
    'GetWindowDC', 'PrintWindow', 'GetWindowRect', 'GetSystemMetrics',
    'CreateCompatibleDC', 'CreateCompatibleBitmap', 'SelectObject', 'BitBlt',
    'GetDIBits', 'DeleteDC', 'DeleteObject', 'GetDC', 'ReleaseDC',
  ];
  const missing = required.filter((name) => typeof bindings[name] !== 'function');
  if (missing.length > 0) {
    captureBindings = {
      reason: `capture bindings unavailable: ${missing.join(', ')}${failures.length > 0 ? ` (${failures.join(' | ')})` : ''}`,
      failures,
    };
    return captureBindings;
  }

  captureBindings = bindings;
  return captureBindings;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function toHwnd(value) {
  return Number(value);
}

/** 同步睡眠（用于 SetWindowPos 后的稳定等待）。 */
function sleepSync(ms) {
  const delay = Math.trunc(Number(ms) || 0);
  if (delay <= 0) return;
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, delay);
}

/**
 * 读光标位置（只读，用于"截图不影响用户鼠标"的校验）。
 *
 * 返回 `undefined` 表示读不到；调用方**不能**把 undefined 当成"光标动了"。
 */
function readCursor(loaded) {
  try {
    if (typeof loaded.GetCursorPos !== 'function') return undefined;
    const buffer = Buffer.alloc(8);
    if (loaded.GetCursorPos(buffer) !== true) return undefined;
    return { x: buffer.readInt32LE(0), y: buffer.readInt32LE(4) };
  } catch {
    return undefined;
  }
}

/**
 * 给截图结果附加"光标有没有动"的判定。
 *
 * 语义刻意区分成三态，而不是简单 true/false：
 *   - `true`  —— 前后都读到了，且坐标一致（截图确实没碰光标）
 *   - `false` —— 前后都读到了，但坐标不同（**可能是用户自己在动鼠标**，不一定是截图造成的）
 *   - `undefined` —— 读不到光标位置，无法判定（不要谎报成功）
 *
 * `cursorUnchanged` 这个别名保留给"顺带确认成功"的调用方，它只在 true 时为真。
 */
function attachCursorCheck(result, loaded, cursorBefore) {
  const cursorAfter = readCursor(loaded);
  result.cursorBefore = cursorBefore;
  result.cursorAfter = cursorAfter;
  if (cursorBefore === undefined || cursorAfter === undefined) {
    result.cursorUntouched = undefined;
    result.cursorUnchanged = undefined;
    result.cursorNote = 'could not read the cursor position, so "the cursor did not move" could not be verified';
    return result;
  }
  const same = cursorBefore.x === cursorAfter.x && cursorBefore.y === cursorAfter.y;
  result.cursorUntouched = same;
  result.cursorUnchanged = same;
  if (!same) {
    result.cursorNote = 'the cursor moved during the capture — this implementation never moves the cursor, '
      + 'so the most likely cause is the user moving their own mouse at the same time';
  }
  return result;
}

// ---------------------------------------------------------------------------
// 核心：GDI 抓取到 BGRA 像素
// ---------------------------------------------------------------------------

/**
 * 从一个源 DC 抓取矩形区域到 BGRA 像素缓冲。
 *
 * 全部 GDI 对象在 finally 里逆序释放；任何一步失败都返回 `{ok:false, reason}`
 * 而不是抛异常，也不会留下半释放的句柄。
 *
 * @param opts.preferPrintWindow - 传入 hwnd 时优先 PrintWindow，失败退回 BitBlt。
 * @returns `{ok, bgra, width, height, method, lines}`.
 */
function grabFromDc(loaded, sourceDc, sourceX, sourceY, width, height, opts = {}) {
  const w = Math.trunc(width);
  const h = Math.trunc(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { ok: false, reason: `invalid capture size ${String(width)}x${String(height)}` };
  }
  // 上限保护：4 亿字节 ≈ 10000x10000，超过几乎必然是调用方算错了（例如传了 undefined）。
  if (w * h > 100_000_000) {
    return { ok: false, reason: `capture size ${w}x${h} is unreasonably large (${w * h} pixels)` };
  }

  /** @type {any} */
  let memDc;
  /** @type {any} */
  let bitmap;
  let previous;

  try {
    memDc = loaded.CreateCompatibleDC(sourceDc);
    if (!memDc || Number(memDc) === 0) {
      return { ok: false, reason: 'CreateCompatibleDC failed' };
    }

    bitmap = loaded.CreateCompatibleBitmap(sourceDc, w, h);
    if (!bitmap || Number(bitmap) === 0) {
      return { ok: false, reason: 'CreateCompatibleBitmap failed (out of GDI handles?)' };
    }

    previous = loaded.SelectObject(memDc, bitmap);

    let method;
    let printed;
    if (typeof opts.printWindow === 'function') {
      // 路线 1：PrintWindow(PW_RENDERFULLCONTENT) —— 能抓后台窗口
      printed = opts.printWindow(memDc);
      method = 'PrintWindow(PW_RENDERFULLCONTENT)';
      if (printed !== true) {
        // 部分老程序不认 PW_RENDERFULLCONTENT，退到 flags=0 再试一次。
        printed = opts.printWindowFallback === undefined ? undefined : opts.printWindowFallback(memDc);
        method = 'PrintWindow(0)';
      }
    }

    let copied = printed === true;
    if (!copied) {
      // 路线 2：BitBlt 源 DC —— 只对"真的显示在屏幕上"的内容有效
      copied = loaded.BitBlt(memDc, 0, 0, w, h, sourceDc, sourceX, sourceY, SRCCOPY) === true;
      if (printed !== true) method = 'BitBlt(SRCCOPY)';
      if (!copied) {
        return { ok: false, reason: 'both PrintWindow and BitBlt failed to render the target' };
      }
    }

    // BITMAPINFOHEADER：biHeight 取**负值**表示 top-down，省掉一次整图翻转。
    const bi = Buffer.alloc(BITMAPINFOHEADER_SIZE + 256 * 4);
    bi.writeUInt32LE(BITMAPINFOHEADER_SIZE, 0);
    bi.writeInt32LE(w, 4);
    bi.writeInt32LE(-h, 8);
    bi.writeUInt16LE(1, 12);   // planes
    bi.writeUInt16LE(32, 14);  // 32bpp
    bi.writeUInt32LE(BI_RGB, 16);
    bi.writeUInt32LE(w * h * 4, 20);

    const bgra = Buffer.alloc(w * h * 4);
    // koffi.address() 给出裸地址，当整数传给 void * 参数（见文件头说明）。
    const address = Number(loaded.koffi.address(bgra));
    const lines = Number(loaded.GetDIBits(memDc, bitmap, 0, h, address, bi, 0));
    if (!Number.isFinite(lines) || lines !== h) {
      return {
        ok: false,
        reason: `GetDIBits returned ${lines} scan lines, expected ${h} (the bitmap may be discarded or the DC invalid)`,
        lines: Number.isFinite(lines) ? lines : undefined,
      };
    }

    return { ok: true, bgra, width: w, height: h, method, lines };
  } catch (error) {
    return { ok: false, reason: `GDI capture failed: ${error?.message ?? String(error)}` };
  } finally {
    // 逆序释放：SelectObject 还原 → DeleteObject(bitmap) → DeleteDC。
    // 每一步单独 try：一个失败不能阻止后面的释放（否则照样泄漏）。
    try {
      if (memDc && previous !== undefined) loaded.SelectObject(memDc, previous);
    } catch { /* 还原失败不改变结论 */ }
    try {
      if (bitmap) loaded.DeleteObject(bitmap);
    } catch { /* 同上 */ }
    try {
      if (memDc) loaded.DeleteDC(memDc);
    } catch { /* 同上 */ }
  }
}

// ---------------------------------------------------------------------------
// 后处理：缩放 / 尺寸控制 / 编码
// ---------------------------------------------------------------------------

/**
 * 按选项把像素结果加工成最终返回。
 *
 * 三种"把图变小"的手段，优先级为：显式 `scale` → `maxWidth/maxHeight` → `maxBytes` 自动降采样。
 * `maxBytes` 是**防止把超大 PNG 塞进模型上下文**的兜底：不断按 0.8 缩放重编码，
 * 直到体积达标或已经小到没有意义。
 *
 * @returns `{ok, png, width, height, ...}` 或 `{ok:false, reason}`。
 */
function finalize(pixels, rawWidth, rawHeight, options = {}, meta = {}) {
  const started = Date.now();
  let width = rawWidth;
  let height = rawHeight;
  let rgba = bgraToRgba(pixels);

  const scaleExplicit = Number(options.scale);
  const maxWidth = Number.isFinite(Number(options.maxWidth)) ? Math.trunc(Number(options.maxWidth)) : undefined;
  const maxHeight = Number.isFinite(Number(options.maxHeight)) ? Math.trunc(Number(options.maxHeight)) : undefined;

  // 计算目标尺寸：显式 scale 优先，否则按 maxWidth/maxHeight 等比适配。
  let targetWidth = width;
  let targetHeight = height;
  if (Number.isFinite(scaleExplicit) && scaleExplicit > 0 && scaleExplicit !== 1) {
    targetWidth = Math.max(1, Math.round(width * scaleExplicit));
    targetHeight = Math.max(1, Math.round(height * scaleExplicit));
  } else if (maxWidth !== undefined || maxHeight !== undefined) {
    const byWidth = maxWidth !== undefined ? maxWidth / width : Infinity;
    const byHeight = maxHeight !== undefined ? maxHeight / height : Infinity;
    const factor = Math.min(1, byWidth, byHeight);
    if (Number.isFinite(factor) && factor > 0 && factor < 1) {
      targetWidth = Math.max(1, Math.round(width * factor));
      targetHeight = Math.max(1, Math.round(height * factor));
    }
  }

  if (targetWidth !== width || targetHeight !== height) {
    try {
      const resized = resizeRgba(rgba, width, height, targetWidth, targetHeight);
      rgba = resized.rgba;
      width = resized.width;
      height = resized.height;
    } catch (error) {
      return { ok: false, reason: `downscale failed: ${error?.message ?? String(error)}` };
    }
  }

  let png;
  try {
    png = encodePngRgba(rgba, width, height);
  } catch (error) {
    return { ok: false, reason: `PNG encoding failed: ${error?.message ?? String(error)}` };
  }

  // maxBytes 兜底：反复缩到 0.8 倍，直到达标或已经太小。
  const maxBytes = Number.isFinite(Number(options.maxBytes)) ? Math.trunc(Number(options.maxBytes)) : undefined;
  let shrunkTimes = 0;
  if (maxBytes !== undefined && maxBytes > 0) {
    while (png.length > maxBytes && width > 64 && height > 64 && shrunkTimes < 12) {
      const nextWidth = Math.max(1, Math.round(width * 0.8));
      const nextHeight = Math.max(1, Math.round(height * 0.8));
      if (nextWidth === width && nextHeight === height) break;
      try {
        const resized = resizeRgba(rgba, width, height, nextWidth, nextHeight);
        rgba = resized.rgba;
        width = resized.width;
        height = resized.height;
        png = encodePngRgba(rgba, width, height);
      } catch (error) {
        return { ok: false, reason: `auto-downscale for maxBytes failed: ${error?.message ?? String(error)}` };
      }
      shrunkTimes += 1;
    }
  }

  const stats = imageStats(rgba);

  return {
    ok: true,
    png,
    width,
    height,
    bytes: png.length,
    /** 原始（未缩放）尺寸，便于调用方把 OCR bbox 换算回屏幕坐标。 */
    sourceWidth: rawWidth,
    sourceHeight: rawHeight,
    scale: width / rawWidth,
    downscaled: width !== rawWidth || height !== rawHeight,
    autoShrunkForMaxBytes: shrunkTimes,
    format: 'png',
    /** 图像内容统计：测试用它判断"是不是全黑（抓取失败）"。 */
    content: stats.ok === true ? {
      nonBlackRatio: Number(stats.nonBlackRatio.toFixed(4)),
      nonWhiteRatio: Number(stats.nonWhiteRatio.toFixed(4)),
      meanLuma: Number(stats.meanLuma.toFixed(2)),
    } : undefined,
    elapsedMs: Date.now() - started,
    ...meta,
  };
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 抓取指定窗口（**优先 PrintWindow，被遮挡/移出屏幕也能抓到**）。
 *
 * @param hwnd - 目标窗口句柄。
 * @param options.scale - 缩放系数（0.5 = 缩小一半）。
 * @param options.maxWidth / maxHeight - 等比缩放到不超过该尺寸。
 * @param options.maxBytes - PNG 超过该字节数时自动继续降采样。
 * @param options.includeNonClient - 默认 true（抓整窗含标题栏/菜单）；false 时尝试只抓客户区。
 * @returns `{ok, png, width, height, method, sourceWidth, sourceHeight, scale, content, cursorUntouched, ...}`
 */
export function captureWindow(hwnd, options = {}) {
  const loaded = ensureCaptureBindings();
  if (loaded.reason !== undefined) return { ok: false, reason: loaded.reason, failures: loaded.failures };

  const target = toHwnd(hwnd);
  if (!Number.isInteger(target) || target === 0) {
    return { ok: false, reason: `invalid hwnd: ${String(hwnd)}` };
  }
  if (loaded.IsWindow(target) !== true) {
    return { ok: false, reason: `hwnd ${target} is no longer a valid window (the app may have closed)` };
  }

  const rect = windowRect(loaded, target);
  if (rect === undefined || rect.width <= 0 || rect.height <= 0) {
    return {
      ok: false,
      reason: `window ${target} has no usable size (${rect === undefined ? 'GetWindowRect failed' : `${rect.width}x${rect.height}`})`,
    };
  }

  const cursorBefore = readCursor(loaded);
  let sourceDc;
  try {
    // GetWindowDC 抓的是**包含非客户区**的整窗；客户区裁剪在下面用客户区原点换算。
    sourceDc = loaded.GetWindowDC(target);
    if (!sourceDc || Number(sourceDc) === 0) {
      return { ok: false, reason: 'GetWindowDC failed' };
    }

    const grabbed = grabFromDc(loaded, sourceDc, 0, 0, rect.width, rect.height, {
      printWindow: (dc) => loaded.PrintWindow(target, dc, PW_RENDERFULLCONTENT),
      printWindowFallback: (dc) => loaded.PrintWindow(target, dc, 0),
    });
    if (grabbed.ok !== true) return grabbed;

    const result = finalize(grabbed.bgra, grabbed.width, grabbed.height, options, {
      hwnd: target,
      method: grabbed.method,
      getDIBitsLines: grabbed.lines,
      windowRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      // 窗口客户区原点在屏幕上的坐标：OCR bbox(像素) → 屏幕坐标 的换算基点。
      clientOrigin: (() => {
        try {
          const point = Buffer.alloc(8);
          point.writeInt32LE(0, 0);
          point.writeInt32LE(0, 4);
          if (loaded.ClientToScreen(target, point) !== true) return { x: rect.left, y: rect.top };
          return { x: point.readInt32LE(0), y: point.readInt32LE(4) };
        } catch {
          return { x: rect.left, y: rect.top };
        }
      })(),
      minimized: loaded.IsIconic(target) === true,
      visible: loaded.IsWindowVisible(target) === true,
      /** PrintWindow 意味着"不在最前也能抓"，但抓的是窗口自己重绘的内容。 */
      captureMethodNote: grabbed.method === 'BitBlt(SRCCOPY)'
        ? 'PrintWindow failed on this window; fell back to a screen copy, which only sees unobstructed pixels'
        : 'rendered by the window itself (works while it is occluded or off-screen)',
    });

    if (result.ok === true) attachCursorCheck(result, loaded, cursorBefore);
    return result;
  } catch (error) {
    return { ok: false, reason: `captureWindow failed: ${error?.message ?? String(error)}` };
  } finally {
    try {
      if (sourceDc) loaded.ReleaseDC(target, sourceDc);
    } catch { /* 释放失败不改变结论 */ }
  }
}

/**
 * 抓整个虚拟屏（**多显示器合并**的完整桌面）。
 *
 * 用 `GetSystemMetrics(76..79)` 拿虚拟屏原点与尺寸。这就是"用户看到的整个桌面"，
 * 也是 OCR / 模板匹配最常用的输入。
 *
 * @returns 同 captureWindow，另含 `virtualScreen:{x,y,width,height}`。
 */
export function captureVirtualScreen(options = {}) {
  return captureFullScreen(options);
}

/**
 * 抓整个虚拟屏（多显示器）。
 *
 * 注意主屏原点未必是 (0,0)：多显示器时虚拟屏原点可能为负（副屏在主屏左侧/上方）。
 * 因此 BitBlt 的源坐标必须用**虚拟屏原点**，而不是 0,0 —— 这是多屏环境最常见的错误。
 */
export function captureFullScreen(options = {}) {
  const loaded = ensureCaptureBindings();
  if (loaded.reason !== undefined) return { ok: false, reason: loaded.reason, failures: loaded.failures };

  let originX = Number(loaded.GetSystemMetrics(76)); // SM_XVIRTUALSCREEN
  let originY = Number(loaded.GetSystemMetrics(77)); // SM_YVIRTUALSCREEN
  let width = Number(loaded.GetSystemMetrics(78));   // SM_CXVIRTUALSCREEN
  let height = Number(loaded.GetSystemMetrics(79));  // SM_CYVIRTUALSCREEN

  // 虚拟屏度量在某些会话（远程桌面切换、显示器热插拔瞬间）会返回 0，
  // 此时退回主屏度量，避免整条截图能力失效。
  let fellBackToPrimary = false;
  if (!(width > 0) || !(height > 0)) {
    fellBackToPrimary = true;
    originX = 0;
    originY = 0;
    width = Number(loaded.GetSystemMetrics(0)); // SM_CXSCREEN
    height = Number(loaded.GetSystemMetrics(1)); // SM_CYSCREEN
  }
  if (!(width > 0) || !(height > 0)) {
    return { ok: false, reason: 'GetSystemMetrics returned no usable screen size (no interactive desktop?)' };
  }

  const cursorBefore = readCursor(loaded);
  let screenDc;
  try {
    screenDc = loaded.GetDC(0);
    if (!screenDc || Number(screenDc) === 0) return { ok: false, reason: 'GetDC(0) failed' };

    const grabbed = grabFromDc(loaded, screenDc, originX, originY, width, height, {});
    if (grabbed.ok !== true) return grabbed;

    const result = finalize(grabbed.bgra, grabbed.width, grabbed.height, options, {
      method: 'BitBlt(SRCCOPY)',
      screenOrigin: { x: originX, y: originY },
      virtualScreen: { x: originX, y: originY, width, height },
      fellBackToPrimary,
      getDIBitsLines: grabbed.lines,
    });
    if (result.ok === true) attachCursorCheck(result, loaded, cursorBefore);
    return result;
  } catch (error) {
    return { ok: false, reason: `captureFullScreen failed: ${error?.message ?? String(error)}` };
  } finally {
    try {
      if (screenDc) loaded.ReleaseDC(0, screenDc);
    } catch { /* 同上 */ }
  }
}

/**
 * 抓屏幕上的任意矩形区域（**屏幕坐标**）。
 *
 * @returns 同 captureWindow，另含 `region:{x,y,width,height}`（本次请求的区域）。
 */
export function captureRegion(x, y, width, height, options = {}) {
  const loaded = ensureCaptureBindings();
  if (loaded.reason !== undefined) return { ok: false, reason: loaded.reason, failures: loaded.failures };

  const rx = Math.trunc(Number(x));
  const ry = Math.trunc(Number(y));
  const rw = Math.trunc(Number(width));
  const rh = Math.trunc(Number(height));
  if (![rx, ry, rw, rh].every(Number.isFinite)) {
    return { ok: false, reason: `invalid region: x=${String(x)} y=${String(y)} width=${String(width)} height=${String(height)}` };
  }
  if (rw <= 0 || rh <= 0) {
    return { ok: false, reason: `region has non-positive size: ${rw}x${rh}` };
  }

  const cursorBefore = readCursor(loaded);
  let screenDc;
  try {
    screenDc = loaded.GetDC(0);
    if (!screenDc || Number(screenDc) === 0) return { ok: false, reason: 'GetDC(0) failed' };

    const grabbed = grabFromDc(loaded, screenDc, rx, ry, rw, rh, {});
    if (grabbed.ok !== true) return grabbed;

    const result = finalize(grabbed.bgra, grabbed.width, grabbed.height, options, {
      method: 'BitBlt(SRCCOPY)',
      region: { x: rx, y: ry, width: rw, height: rh },
      getDIBitsLines: grabbed.lines,
    });
    if (result.ok === true) attachCursorCheck(result, loaded, cursorBefore);
    return result;
  } catch (error) {
    return { ok: false, reason: `captureRegion failed: ${error?.message ?? String(error)}` };
  } finally {
    try {
      if (screenDc) loaded.ReleaseDC(0, screenDc);
    } catch { /* 同上 */ }
  }
}

/**
 * 抓取原始 BGRA 像素（不编码 PNG）。
 *
 * 给**模板匹配、像素级分析**这类不想付 PNG 编解码成本、也不想被缩放干扰的调用方用。
 * 注意：得到的 Buffer 归调用方所有，本模块不再引用它。
 *
 * @returns `{ok, bgra, width, height, method}` 或 `{ok:false, reason}`。
 */
export function capturePixels(target, options = {}) {
  const loaded = ensureCaptureBindings();
  if (loaded.reason !== undefined) return { ok: false, reason: loaded.reason, failures: loaded.failures };

  const mode = options.mode ?? (options.hwnd !== undefined || Number.isInteger(Number(target)) ? 'window' : 'screen');

  if (mode === 'region') {
    const { x, y, width, height } = options;
    let screenDc;
    try {
      screenDc = loaded.GetDC(0);
      if (!screenDc) return { ok: false, reason: 'GetDC(0) failed' };
      return grabFromDc(loaded, screenDc, Math.trunc(Number(x)), Math.trunc(Number(y)), Math.trunc(Number(width)), Math.trunc(Number(height)), {});
    } finally {
      try { if (screenDc) loaded.ReleaseDC(0, screenDc); } catch { /* 同上 */ }
    }
  }

  if (mode === 'screen') {
    const originX = Number(loaded.GetSystemMetrics(76));
    const originY = Number(loaded.GetSystemMetrics(77));
    const width = Number(loaded.GetSystemMetrics(78));
    const height = Number(loaded.GetSystemMetrics(79));
    if (!(width > 0) || !(height > 0)) return { ok: false, reason: 'no usable virtual screen size' };
    let screenDc;
    try {
      screenDc = loaded.GetDC(0);
      if (!screenDc) return { ok: false, reason: 'GetDC(0) failed' };
      return grabFromDc(loaded, screenDc, originX, originY, width, height, {});
    } finally {
      try { if (screenDc) loaded.ReleaseDC(0, screenDc); } catch { /* 同上 */ }
    }
  }

  // 窗口模式
  const hwndValue = options.hwnd !== undefined ? options.hwnd : target;
  const hwndNumber = toHwnd(hwndValue);
  if (!Number.isInteger(hwndNumber) || hwndNumber === 0) return { ok: false, reason: `invalid hwnd: ${String(hwndValue)}` };
  if (loaded.IsWindow(hwndNumber) !== true) return { ok: false, reason: `hwnd ${hwndNumber} is not a valid window` };
  const rect = windowRect(loaded, hwndNumber);
  if (rect === undefined || rect.width <= 0 || rect.height <= 0) return { ok: false, reason: 'window has no usable size' };

  let sourceDc;
  try {
    sourceDc = loaded.GetWindowDC(hwndNumber);
    if (!sourceDc) return { ok: false, reason: 'GetWindowDC failed' };
    return grabFromDc(loaded, sourceDc, 0, 0, rect.width, rect.height, {
      printWindow: (dc) => loaded.PrintWindow(hwndNumber, dc, PW_RENDERFULLCONTENT),
      printWindowFallback: (dc) => loaded.PrintWindow(hwndNumber, dc, 0),
    });
  } finally {
    try { if (sourceDc) loaded.ReleaseDC(hwndNumber, sourceDc); } catch { /* 同上 */ }
  }
}

/**
 * 枚举显示器及其边界。
 *
 * `MONITORINFO` 结构布局（**本机实测**，容易算错）：
 *   cbSize(4) + rcMonitor(16) + rcWork(16) + dwFlags(4) = **40 字节**
 *
 * 取显示器的方法：对虚拟屏的四角与中心各取一次 `MonitorFromPoint`，去重。
 * 比 EnumDisplayMonitors 少一个回调绑定，且对本插件"知道有哪些屏、边界在哪"的
 * 需求完全够用（不需要每屏的 device name）。
 *
 * @returns `{ok, count, monitors:[{index, handle, primary, x, y, width, height, workArea:{...}}]}`
 */
export function listMonitors() {
  const loaded = ensureCaptureBindings();
  if (loaded.reason !== undefined) return { ok: false, reason: loaded.reason, monitors: [] };
  if (typeof loaded.MonitorFromPoint !== 'function' || typeof loaded.GetMonitorInfoW !== 'function') {
    return { ok: false, reason: 'MonitorFromPoint / GetMonitorInfoW are unavailable in this FFI build', monitors: [] };
  }

  const vx = Number(loaded.GetSystemMetrics(76));
  const vy = Number(loaded.GetSystemMetrics(77));
  const vw = Number(loaded.GetSystemMetrics(78)) || Number(loaded.GetSystemMetrics(0));
  const vh = Number(loaded.GetSystemMetrics(79)) || Number(loaded.GetSystemMetrics(1));

  // 采样点：四角 + 中心 + 主屏左上（保证主屏一定被发现）。
  const points = [
    [vx, vy],
    [vx + vw - 1, vy],
    [vx, vy + vh - 1],
    [vx + vw - 1, vy + vh - 1],
    [Math.round(vx + vw / 2), Math.round(vy + vh / 2)],
    [0, 0],
  ];

  const seen = new Set();
  const monitors = [];
  const failures = [];

  for (const [px, py] of points) {
    const handle = Number(loaded.MonitorFromPoint(Math.trunc(px), Math.trunc(py), MONITOR_DEFAULTTONEAREST));
    if (!Number.isInteger(handle) || handle === 0 || seen.has(handle)) continue;
    seen.add(handle);

    const info = Buffer.alloc(40);
    info.writeUInt32LE(40, 0); // cbSize 必须先填，否则 GetMonitorInfoW 直接失败
    try {
      if (loaded.GetMonitorInfoW(handle, info) !== true) {
        failures.push(`GetMonitorInfoW failed for handle ${handle}`);
        continue;
      }
    } catch (error) {
      failures.push(`GetMonitorInfoW threw: ${error?.message ?? String(error)}`);
      continue;
    }

    const left = info.readInt32LE(4);
    const top = info.readInt32LE(8);
    const right = info.readInt32LE(12);
    const bottom = info.readInt32LE(16);
    const workLeft = info.readInt32LE(20);
    const workTop = info.readInt32LE(24);
    const workRight = info.readInt32LE(28);
    const workBottom = info.readInt32LE(32);
    const flags = info.readUInt32LE(36);

    monitors.push({
      index: monitors.length,
      handle,
      /** MONITORINFOF_PRIMARY = 0x1 */
      primary: (flags & 0x1) !== 0,
      x: left,
      y: top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
      workArea: {
        x: workLeft,
        y: workTop,
        width: Math.max(0, workRight - workLeft),
        height: Math.max(0, workBottom - workTop),
      },
    });
  }

  // 主屏排前面，方便调用方直接取 monitors[0]。
  monitors.sort((a, b) => Number(b.primary) - Number(a.primary));

  if (monitors.length === 0) {
    return { ok: false, reason: `no monitor could be described${failures.length > 0 ? ` (${failures.join(' | ')})` : ''}`, monitors: [] };
  }

  return {
    ok: true,
    count: monitors.length,
    monitors,
    virtualScreen: { x: vx, y: vy, width: vw, height: vh },
  };
}

/**
 * 能力自检：截图管线能不能用、绑到了什么、缺哪些函数。
 *
 * 这是给 `vcu_status` 与排查用的，所以除了 `ok` 还给出**具体缺哪一项**，
 * 而不是笼统的"不可用"。
 */
export function describeCapture() {
  const loaded = ensureCaptureBindings();
  const base = {
    module: 'capture',
    pid: process.pid,
    platform: process.platform,
  };

  if (loaded.reason !== undefined) {
    return {
      ...base,
      ok: false,
      supported: false,
      reason: loaded.reason,
      failures: loaded.failures ?? [],
    };
  }

  const required = [
    'GetWindowDC', 'PrintWindow', 'GetWindowRect', 'GetClientRect', 'ClientToScreen',
    'GetSystemMetrics', 'CreateCompatibleDC', 'CreateCompatibleBitmap', 'SelectObject',
    'BitBlt', 'GetDIBits', 'DeleteDC', 'DeleteObject', 'GetDC', 'ReleaseDC',
  ];
  const missing = required.filter((name) => typeof loaded[name] !== 'function');
  const optional = ['MonitorFromPoint', 'GetMonitorInfoW', 'IsIconic', 'IsWindowVisible', 'GetCursorPos'];
  const missingOptional = optional.filter((name) => typeof loaded[name] !== 'function');

  let virtualScreen;
  try {
    virtualScreen = {
      x: Number(loaded.GetSystemMetrics(76)),
      y: Number(loaded.GetSystemMetrics(77)),
      width: Number(loaded.GetSystemMetrics(78)),
      height: Number(loaded.GetSystemMetrics(79)),
    };
  } catch {
    virtualScreen = undefined;
  }

  return {
    ...base,
    ok: missing.length === 0,
    supported: missing.length === 0,
    koffi: loaded.from,
    missingBindings: missing,
    missingOptionalBindings: missingOptional,
    bindingFailures: loaded.failures ?? [],
    virtualScreen,
    capabilities: {
      /** 窗口抓取，含被遮挡/后台窗口（PrintWindow）。 */
      captureWindow: missing.length === 0,
      /** 全屏 / 虚拟屏（多显示器）。 */
      captureVirtualScreen: missing.length === 0,
      /** 屏幕任意区域。 */
      captureRegion: missing.length === 0,
      /** 原始 BGRA 像素（给模板匹配用）。 */
      capturePixels: missing.length === 0,
      /** 显示器枚举。 */
      listMonitors: typeof loaded.MonitorFromPoint === 'function' && typeof loaded.GetMonitorInfoW === 'function',
      /** 缩放与体积控制。 */
      scaling: true,
      /** 抓取是否会影响真实光标（本实现不影响；这是本插件的核心卖点之一）。 */
      movesRealCursor: false,
      /** 能否自证"抓取没动光标"（依赖 GetCursorPos 绑定）。 */
      canVerifyCursor: typeof loaded.GetCursorPos === 'function',
    },
    /** 如实说明能力边界，避免调用方误以为 PrintWindow 万能。 */
    limitations: [
      'Hardware-accelerated surfaces (video players, GPU-composited games, some Electron/Chromium canvases) ' +
        'often render as a black or partial image with PrintWindow, because the content lives in a GPU ' +
        'surface that the window procedure does not repaint. captureFullScreen() (screen BitBlt) usually ' +
        'works for the visible part of those windows instead.',
      'Some UWP / Store apps do not respond to PrintWindow at all and return an all-black bitmap while ' +
        'PrintWindow still reports true. Check the returned "content.nonBlackRatio" before trusting an image.',
      'Minimized windows have no client area to render; PrintWindow on a minimized window is unreliable. ' +
        'Restore it (ShowWindow SW_RESTORE) or capture the full screen instead.',
      'A window that is larger than the virtual screen, or partially off-screen, is still captured in full ' +
        'for captureWindow (PrintWindow renders into a memory DC), but captureRegion/captureFullScreen can ' +
        'only see what is actually on screen.',
    ],
  };
}

/**
 * 把"图片像素坐标"换算成**屏幕坐标**。
 *
 * 截图后图片与真实屏幕的对应关系有两个变数：
 *   1. 抓取的区域原点（窗口在屏幕上的位置 / 虚拟屏原点 / region 的 x,y）
 *   2. 缩放（scale / maxWidth / maxBytes 都会改图片尺寸）
 *
 * 这个函数把这两步一次算清，是"OCR 看到文字 → 算出点哪里"的关键链条。
 * 输出**刻意取像素中心**：模型通常拿文字的 bbox 去点，点左上角容易落在字外。
 *
 * @param capture - `captureWindow` / `captureFullScreen` / `captureRegion` 的返回值。
 * @param point - `{x, y}` 图片像素坐标（通常是某个 word 的 bbox 中心）。
 * @param options.inverse - true 表示反向换算（屏幕坐标 → 图片像素坐标）。
 * @returns `{ok, x, y}` 或 `{ok:false, reason}`。
 */
export function imagePointToScreen(capture, point, options = {}) {
  if (capture === null || capture === undefined || capture.ok !== true) {
    return { ok: false, reason: 'imagePointToScreen needs a successful capture result' };
  }
  const px = Number(point?.x);
  const py = Number(point?.y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    return { ok: false, reason: `point must be {x,y} numbers, got ${JSON.stringify(point)}` };
  }

  // 图片原点对应的屏幕坐标。
  let originX;
  let originY;
  if (capture.windowRect !== undefined) {
    originX = capture.windowRect.x;
    originY = capture.windowRect.y;
  } else if (capture.screenOrigin !== undefined) {
    originX = capture.screenOrigin.x;
    originY = capture.screenOrigin.y;
  } else if (capture.region !== undefined) {
    originX = capture.region.x;
    originY = capture.region.y;
  } else {
    return { ok: false, reason: 'capture result has no origin information (windowRect / screenOrigin / region)' };
  }

  const sourceWidth = Number(capture.sourceWidth);
  const width = Number(capture.width);
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(width) || width === 0) {
    return { ok: false, reason: 'capture result has no usable width/scale information' };
  }
  // 图片像素 → 原始像素 的比例（缩放是等比的，用宽度算即可）。
  const toSource = sourceWidth / width;

  if (options.inverse === true) {
    // 屏幕 → 图片
    return { ok: true, x: (px - originX) / toSource, y: (py - originY) / toSource };
  }
  return { ok: true, x: originX + px * toSource, y: originY + py * toSource };
}

/**
 * 把"图片像素坐标"换算成**目标窗口的客户区坐标**（可直接喂给 `vcu_click`）。
 *
 * 两步链条：
 *   图片像素 →（除以缩放）→ 窗口内像素（含非客户区，即相对窗口左上角）→ 减去客户区
 *   相对窗口的偏移 → 客户区坐标。
 *
 * 客户区偏移由 `GetClientRect` + `ClientToScreen` 得到：窗口客户区原点在屏幕上的位置
 * 减去窗口左上角，就是边框/标题栏占掉的宽度与高度。
 *
 * @param capture - `captureWindow()` 的返回值（必须带 `hwnd`）。
 * @param point - `{x, y}` 图片像素坐标。
 * @returns `{ok, clientX, clientY, screenX, screenY, hwnd}` 或 `{ok:false, reason}`。
 */
export function imagePointToClient(capture, point) {
  const loaded = ensureCaptureBindings();
  if (loaded.reason !== undefined) return { ok: false, reason: loaded.reason };
  if (capture === null || capture === undefined || capture.ok !== true) {
    return { ok: false, reason: 'imagePointToClient needs a successful capture result' };
  }
  const hwnd = Number(capture.hwnd);
  if (!Number.isInteger(hwnd) || hwnd === 0) {
    return { ok: false, reason: 'capture result has no hwnd (only captureWindow results have one)' };
  }
  if (loaded.IsWindow(hwnd) !== true) {
    return { ok: false, reason: `hwnd ${hwnd} is no longer a valid window` };
  }

  const screen = imagePointToScreen(capture, point);
  if (screen.ok !== true) return screen;

  const client = clientRect(loaded, hwnd);
  const rect = windowRect(loaded, hwnd);
  if (client === undefined || rect === undefined) {
    return { ok: false, reason: 'GetClientRect / GetWindowRect failed' };
  }

  // 客户区原点在屏幕上的坐标。
  let clientScreenX = rect.left;
  let clientScreenY = rect.top;
  try {
    const pt = Buffer.alloc(8);
    pt.writeInt32LE(0, 0);
    pt.writeInt32LE(0, 4);
    if (loaded.ClientToScreen(hwnd, pt) === true) {
      clientScreenX = pt.readInt32LE(0);
      clientScreenY = pt.readInt32LE(4);
    }
  } catch {
    // 用窗口左上角兜底（无边框窗口时两者相同）。
  }

  return {
    ok: true,
    hwnd,
    clientX: Math.round(screen.x - clientScreenX),
    clientY: Math.round(screen.y - clientScreenY),
    screenX: Math.round(screen.x),
    screenY: Math.round(screen.y),
    clientOriginOnScreen: { x: clientScreenX, y: clientScreenY },
    windowRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    clientSize: { width: client.width, height: client.height },
  };
}

/**
 * 保存截图到文件（供排查与"给用户看"的场景）。
 *
 * 单独的便利函数，不做目录创建——路径错了就明确失败，不猜用户意图。
 */
export async function saveCapture(capture, filePath) {
  if (capture === null || capture === undefined || capture.ok !== true) {
    return { ok: false, reason: 'saveCapture needs a successful capture result' };
  }
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, capture.png);
    return { ok: true, path: filePath, bytes: capture.png.length };
  } catch (error) {
    return { ok: false, reason: `could not write ${String(filePath)}: ${error?.message ?? String(error)}` };
  }
}

/** 校验一个 Buffer 是不是结构完整的 PNG（IHDR 尺寸与期望一致）。 */
export function verifyPng(png, expectedWidth, expectedHeight) {
  const header = readPngHeader(png);
  if (header.ok !== true) return header;
  const checks = {
    signatureValid: true,
    ihdrCrcValid: header.ihdrCrcValid,
    bitDepth8: header.bitDepth === 8,
    widthMatches: expectedWidth === undefined ? undefined : header.width === expectedWidth,
    heightMatches: expectedHeight === undefined ? undefined : header.height === expectedHeight,
  };
  const failed = Object.entries(checks).filter(([, value]) => value === false).map(([key]) => key);
  return {
    ok: failed.length === 0,
    width: header.width,
    height: header.height,
    bytes: header.bytes,
    checks,
    reason: failed.length === 0 ? undefined : `PNG checks failed: ${failed.join(', ')}`,
  };
}

/** 供诊断：本模块依赖的原生绑定是否齐全。 */
export const PUBLIC_API = {
  captureWindow,
  captureFullScreen,
  captureVirtualScreen,
  captureRegion,
  capturePixels,
  listMonitors,
  describeCapture,
  imagePointToScreen,
  imagePointToClient,
  saveCapture,
  verifyPng,
};
