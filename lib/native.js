/**
 * dsh-virtual-computer-use —— 原生 FFI 层（koffi + user32/kernel32/gdi32）。
 *
 * 设计要点：
 *
 * 1. **复用宿主自带的 koffi**。DSH 桌面外壳把 koffi 放在
 *    `@deepseek-ai/dsh-desktop-host/node_modules/koffi`，其中二进制
 *    `koffi.node` 被 Electron 拆到 `app.asar.unpacked`。插件本身零依赖安装，
 *    通过三级回退解析 koffi：
 *      a. 宿主入口 createRequire（asar 内虚拟路径，宿主进程内可用）
 *      b. `.unpacked` 下的 `koffi.node` 原生文件直载（独立进程/测试可用）
 *      c. 插件自身 createRequire（用户自装了 koffi 时）
 *
 * 2. **一切失败都降级成 `{ ok:false, reason }`，绝不抛异常**。宿主是长期
 *    存活的进程，任何未捕获异常都会拖垮聊天界面。
 *
 * 3. **所有函数签名集中在此声明**，其余模块只消费语义化包装，不直接碰 koffi。
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 安装根目录候选。
 *
 * 关键：**不能只用 `process.execPath`**。插件既跑在宿主里（Electron 可执行文件，
 * execPath 指向安装根），也可能被 `node test/x.mjs` 这种独立进程加载
 * （此时 execPath = `C:\Program Files\nodejs\node.exe`，推导出的 resources 路径是错的）。
 *
 * 所以这里同时考虑：
 *   1. `DSH_VCU_KOFFI_ROOT` 环境变量（显式覆盖，测试/异常部署用）
 *   2. execPath 旁边的 resources（宿主进程的标准情况）
 *   3. 标准安装位置 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources`（独立进程）
 *   4. `dsh-desktop-host` 解析到的真实位置（若宿主入口可见）
 */
function installRoots() {
  const roots = [];
  const push = (value) => {
    if (typeof value === 'string' && value !== '' && !roots.includes(value)) roots.push(value);
  };

  push(process.env.DSH_VCU_KOFFI_ROOT);

  const execDir = dirname(process.execPath);
  push(join(execDir, 'resources'));

  const localAppData = process.env.LOCALAPPDATA;
  if (typeof localAppData === 'string' && localAppData !== '') {
    push(join(localAppData, 'Programs', 'DeepSeek Harness', 'resources'));
  }

  return roots;
}

/** 安装目录下 koffi 原生二进制的候选位置（Electron 会把 .node 拆到 unpacked）。 */
function nativeCandidates() {
  const arch = process.arch === 'arm64' ? 'win32_arm64' : 'win32_x64';
  const out = [];
  for (const resources of installRoots()) {
    out.push(join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', '@koromix', `koffi-${arch}`, arch, 'koffi.node'));
    out.push(join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node'));
    out.push(join(resources, 'app.asar', 'dsh', 'node_modules', '@koromix', `koffi-${arch}`, arch, 'koffi.node'));
  }
  return out;
}

/** 宿主入口候选：koffi 的 JS 包只存在于 asar 虚拟路径里，必须用宿主入口做 base。 */
function hostEntryCandidates() {
  return [
    typeof process.argv[1] === 'string' && process.argv[1] !== '' ? process.argv[1] : undefined,
    join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js'),
  ].filter((value) => typeof value === 'string' && value !== '');
}

/** 进程内只解析一次。 */
let nativeHandle;

/**
 * 加载 koffi。返回 `{ koffi, from }` 或 `{ reason }`。
 */
export function loadKoffi() {
  if (nativeHandle !== undefined) return nativeHandle;
  if (process.platform !== 'win32') {
    nativeHandle = { reason: `platform ${process.platform} is not supported (Windows only)` };
    return nativeHandle;
  }
  const attempts = [];

  // 路线 a：宿主入口（asar 虚拟路径），宿主进程内的标准路径。
  for (const base of hostEntryCandidates()) {
    try {
      const require = createRequire(base);
      nativeHandle = { koffi: require('koffi'), from: require.resolve('koffi') };
      return nativeHandle;
    } catch (error) {
      attempts.push(`hostEntry(${base}): ${error?.message ?? String(error)}`);
    }
  }

  // 路线 b：直接加载 .node 原生文件，绕过 asar（独立进程 / 测试场景）。
  for (const nativePath of nativeCandidates()) {
    try {
      if (!existsSync(nativePath)) {
        attempts.push(`native(${nativePath}): not found`);
        continue;
      }
      const require = createRequire(import.meta.url);
      const koffi = require(nativePath);
      nativeHandle = { koffi, from: nativePath };
      return nativeHandle;
    } catch (error) {
      attempts.push(`native(${nativePath}): ${error?.message ?? String(error)}`);
    }
  }

  // 路线 c：插件自己的 node_modules（用户显式安装 koffi 时）。
  try {
    const require = createRequire(import.meta.url);
    nativeHandle = { koffi: require('koffi'), from: require.resolve('koffi') };
    return nativeHandle;
  } catch (error) {
    attempts.push(`plugin: ${error?.message ?? String(error)}`);
  }

  nativeHandle = { reason: `koffi (bundled FFI) is unavailable: ${attempts.join(' | ')}` };
  return nativeHandle;
}

// ---------------------------------------------------------------------------
// Win32 常量
// ---------------------------------------------------------------------------

/** 扩展窗口样式。 */
export const WS_EX = {
  LAYERED: 0x0008_0000,
  TRANSPARENT: 0x0000_0020,
  TOPMOST: 0x0000_0008,
  NOACTIVATE: 0x0800_0000,
  TOOLWINDOW: 0x0000_0080,
};

/** 窗口样式。 */
export const WS = {
  POPUP: 0x8000_0000,
  CHILD: 0x4000_0000,
  VISIBLE: 0x1000_0000,
};

/** 通用窗口消息。 */
export const WM = {
  SETFOCUS: 0x0007,
  KILLFOCUS: 0x0008,
  ENABLE: 0x000A,
  SETTEXT: 0x000C,
  GETTEXT: 0x000D,
  GETTEXTLENGTH: 0x000E,
  PAINT: 0x000F,
  CLOSE: 0x0010,
  DESTROY: 0x0002,
  QUIT: 0x0012,
  ERASEBKGND: 0x0014,
  SETCURSOR: 0x0020,
  GETMINMAXINFO: 0x0024,
  MOUSEMOVE: 0x0200,
  LBUTTONDOWN: 0x0201,
  LBUTTONUP: 0x0202,
  LBUTTONDBLCLK: 0x0203,
  RBUTTONDOWN: 0x0204,
  RBUTTONUP: 0x0205,
  RBUTTONDBLCLK: 0x0206,
  MBUTTONDOWN: 0x0207,
  MBUTTONUP: 0x0208,
  MBUTTONDBLCLK: 0x0209,
  MOUSEWHEEL: 0x020A,
  MOUSEHWHEEL: 0x020E,
  KEYDOWN: 0x0100,
  KEYUP: 0x0101,
  CHAR: 0x0102,
  SYSKEYDOWN: 0x0104,
  SYSKEYUP: 0x0105,
  SYSCHAR: 0x0106,
  ACTIVATE: 0x0006,
  GETOBJECT: 0x003D,
  NCHITTEST: 0x0084,
  SETREDRAW: 0x000B,
  PRINT: 0x0317,
  PRINTCLIENT: 0x0318,
  NEXTDLGCTL: 0x0028,
  /** 垂直/水平滚动条消息：比滚轮更精确可控的滚动途径。 */
  VSCROLL: 0x0115,
  HSCROLL: 0x0114,
  /** 非客户区鼠标消息：拖动窗口标题栏（HTCAPTION）走这条。 */
  NCLBUTTONDOWN: 0x00A1,
  NCLBUTTONUP: 0x00A2,
  NCLBUTTONDBLCLK: 0x00A3,
  NCMOUSEMOVE: 0x00A0,
  /** 窗口拖动/取消模式的辅助消息。 */
  CANCELMODE: 0x001F,
  ENTERSIZEMOVE: 0x0231,
  EXITSIZEMOVE: 0x0232,
};

/**
 * 滚动条命令（WM_VSCROLL / WM_HSCROLL 的 wParam 低字）。
 */
export const SB = {
  LINEUP: 0,
  LINEDOWN: 1,
  PAGEUP: 2,
  PAGEDOWN: 3,
  THUMBPOSITION: 4,
  THUMBTRACK: 5,
  TOP: 6,
  BOTTOM: 7,
  ENDSCROLL: 8,
};

/**
 * 非客户区命中测试返回值（WM_NCHITTEST 的 lParam / NCLBUTTONDOWN 的 wParam）。
 * 拖动窗口标题栏就是把 HTCAPTION 作为 wParam 投递 WM_NCLBUTTONDOWN。
 */
export const HT = {
  NOWHERE: 0,
  CLIENT: 1,
  CAPTION: 2,
  SYSMENU: 3,
  BOTTOM: 15,
  TOP: 12,
};

/**
 * 编辑控件（Edit / RichEdit）消息。
 *
 * 这些是**虚拟键盘的关键补充**：纯 `PostMessage` 投递的裸 `WM_KEYDOWN` 不携带
 * 非字符语义（Delete、方向键、Home/End、Ctrl+X 等），因为 PostMessage 绕过了
 * 接收线程消息循环里的 `TranslateMessage`。编辑控件消息由窗口过程直接处理，
 * 是可靠路径。
 *
 * 已实测验证（真实记事本）：`EM_SETSEL(0,-1)` 能真正全选（选区 0..11，
 * 而 Ctrl+A 走按键路径的选区是 1..1，完全无效）；`EM_REPLACESEL` 能精确改写
 * 任意选区（`AAXYZAAAAA`）。
 *
 * 注意：早先版本这里有个错误的 `SETCURSORPOS: 0x0200`，它既不是真实的消息名，
 * 又与 `MOUSEMOVE` 撞号，已删除。
 */
export const EM = {
  GETSEL: 0x00B0,
  SETSEL: 0x00B1,
  GETRECT: 0x00B2,
  SETRECT: 0x00B3,
  SCROLLCARET: 0x00B7,
  GETMODIFY: 0x00B8,
  SETMODIFY: 0x00B9,
  GETLINECOUNT: 0x00BA,
  LINEINDEX: 0x00BB,
  LINELENGTH: 0x00C4,
  GETLINE: 0x00C4,
  REPLACESEL: 0x00C2,
  SETREADONLY: 0x00CF,
  SETCUEBANNER: 0x1501,
};

/** 键盘事件标志。 */
export const KEYEVENTF = {
  EXTENDEDKEY: 0x0001,
  KEYUP: 0x0002,
  UNICODE: 0x0004,
  SCANCODE: 0x0008,
};

/** 鼠标消息的 wParam 标志位。 */
export const MK = {
  LBUTTON: 0x0001,
  RBUTTON: 0x0002,
  SHIFT: 0x0004,
  CONTROL: 0x0008,
  MBUTTON: 0x0010,
};

/** SetWindowPos 标志。 */
export const SWP = {
  NOSIZE: 0x0001,
  NOMOVE: 0x0002,
  NOZORDER: 0x0004,
  NOACTIVATE: 0x0010,
  FRAMECHANGED: 0x0020,
  SHOWWINDOW: 0x0040,
  NOOWNERZORDER: 0x0200,
};

/** ShowWindow 命令。 */
export const SW = {
  HIDE: 0,
  SHOWNORMAL: 1,
  SHOWMINIMIZED: 2,
  SHOWMAXIMIZED: 3,
  SHOWNOACTIVATE: 4,
  SHOW: 5,
  MINIMIZE: 6,
  RESTORE: 9,
  SHOWDEFAULT: 10,
  SHOWNA: 8,
};

/** 虚拟键码（本项目用到的部分）。 */
export const VK = {
  BACK: 0x08,
  TAB: 0x09,
  RETURN: 0x0D,
  SHIFT: 0x10,
  CONTROL: 0x11,
  MENU: 0x12,
  ESCAPE: 0x1B,
  SPACE: 0x20,
  PRIOR: 0x21,
  NEXT: 0x22,
  END: 0x23,
  HOME: 0x24,
  LEFT: 0x25,
  UP: 0x26,
  RIGHT: 0x27,
  DOWN: 0x28,
  DELETE: 0x2E,
  LWIN: 0x5B,
  F1: 0x70,
  A: 0x41,
  C: 0x43,
  V: 0x56,
  X: 0x58,
  Z: 0x5A,
};

/** 系统度量索引。 */
export const SM = {
  CXSCREEN: 0,
  CYSCREEN: 1,
  XVIRTUALSCREEN: 76,
  YVIRTUALSCREEN: 77,
  CXVIRTUALSCREEN: 78,
  CYVIRTUALSCREEN: 79,
};

// ---------------------------------------------------------------------------
// 绑定
// ---------------------------------------------------------------------------

/** 进程内只绑定一次；`reason` 存在表示不可用。 */
let bound;

/**
 * 绑定一个导出函数；失败时返回 `undefined` 并记录原因。
 *
 * **为什么必须逐个隔离**：koffi 的 `func()` 在函数名不存在时抛异常。如果所有
 * 绑定都写在一个大 try 里，任何一个名字打错、或声明在错误的 DLL 上，都会让
 * 整块绑定失败 —— 结果是连 `GetCursorPos` 这种完全无关、且正确的绑定也一起
 * 失效，整个插件直接变成不可用。
 *
 * 这个设计不是预防性的空想：`FillRect`（真实位于 user32，不是 gdi32）曾经
 * 就是这样把全部 Win32 能力击穿的。逐个隔离后，最坏情况只是某一个函数
 * 不可用，其余功能照常工作，并且能在 `describeNative()` 里精确报告是哪一个。
 *
 * @param failures - 收集失败记录的数组。
 */
function bind(dll, name, signature, failures) {
  try {
    return dll.func(signature);
  } catch (error) {
    failures.push(`${name}: ${error?.message ?? String(error)}`);
    return undefined;
  }
}

/**
 * 绑定 user32 / gdi32 / kernel32。
 *
 * @returns 绑定集合，或带 `reason` 的降级对象。
 */
export function loadWin32() {
  if (bound !== undefined) return bound;
  const loaded = loadKoffi();
  if (loaded.koffi === undefined) {
    bound = { reason: loaded.reason };
    return bound;
  }

  /** 记录单个函数绑定失败的原因；非空表示能力不完整。 */
  const failures = [];

  try {
    const koffi = loaded.koffi;
    const user32 = koffi.load('user32.dll');
    const gdi32 = koffi.load('gdi32.dll');
    const kernel32 = koffi.load('kernel32.dll');

    const b = (dll, name, signature) => bind(dll, name, signature, failures);

    bound = {
      koffi,
      from: loaded.from,
      user32,
      gdi32,
      kernel32,
      /** 绑定失败的函数清单；空数组表示能力完整。 */
      failures,

      // --- 窗口查找与枚举 ---
      EnumWindows: b(user32, 'EnumWindows', 'bool __stdcall EnumWindows(void *lpEnumFunc, intptr_t lParam)'),
      EnumChildWindows: b(user32, 'EnumChildWindows', 'bool __stdcall EnumChildWindows(intptr_t parent, void *lpEnumFunc, intptr_t lParam)'),
      FindWindowW: b(user32, 'FindWindowW', 'intptr_t __stdcall FindWindowW(char16_t *cls, char16_t *title)'),
      FindWindowExW: b(user32, 'FindWindowExW', 'intptr_t __stdcall FindWindowExW(intptr_t parent, intptr_t child, char16_t *cls, char16_t *title)'),
      IsWindow: b(user32, 'IsWindow', 'bool __stdcall IsWindow(intptr_t hwnd)'),
      IsWindowVisible: b(user32, 'IsWindowVisible', 'bool __stdcall IsWindowVisible(intptr_t hwnd)'),
      IsWindowEnabled: b(user32, 'IsWindowEnabled', 'bool __stdcall IsWindowEnabled(intptr_t hwnd)'),
      IsIconic: b(user32, 'IsIconic', 'bool __stdcall IsIconic(intptr_t hwnd)'),
      IsHungAppWindow: b(user32, 'IsHungAppWindow', 'bool __stdcall IsHungAppWindow(intptr_t hwnd)'),

      // --- 窗口信息 ---
      GetWindowTextW: b(user32, 'GetWindowTextW', 'int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ char16_t *buf, int max)'),
      GetWindowTextLengthW: b(user32, 'GetWindowTextLengthW', 'int __stdcall GetWindowTextLengthW(intptr_t hwnd)'),
      GetClassNameW: b(user32, 'GetClassNameW', 'int __stdcall GetClassNameW(intptr_t hwnd, _Out_ char16_t *buf, int max)'),
      GetWindowThreadProcessId: b(user32, 'GetWindowThreadProcessId', 'uint32 __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32 *pid)'),
      GetWindowRect: b(user32, 'GetWindowRect', 'bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ int32 *rect)'),
      GetClientRect: b(user32, 'GetClientRect', 'bool __stdcall GetClientRect(intptr_t hwnd, _Out_ int32 *rect)'),
      GetWindowLongPtrW: b(user32, 'GetWindowLongPtrW', 'intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)'),
      GetParent: b(user32, 'GetParent', 'intptr_t __stdcall GetParent(intptr_t hwnd)'),
      GetAncestor: b(user32, 'GetAncestor', 'intptr_t __stdcall GetAncestor(intptr_t hwnd, uint32 flags)'),
      WindowFromPoint: b(user32, 'WindowFromPoint', 'intptr_t __stdcall WindowFromPoint(int32 x, int32 y)'),
      GetForegroundWindow: b(user32, 'GetForegroundWindow', 'intptr_t __stdcall GetForegroundWindow()'),
      GetFocus: b(user32, 'GetFocus', 'intptr_t __stdcall GetFocus()'),
      GetSystemMetrics: b(user32, 'GetSystemMetrics', 'int __stdcall GetSystemMetrics(int index)'),

      // --- 坐标转换 ---
      ClientToScreen: b(user32, 'ClientToScreen', 'bool __stdcall ClientToScreen(intptr_t hwnd, _Inout_ int32 *pt)'),
      ScreenToClient: b(user32, 'ScreenToClient', 'bool __stdcall ScreenToClient(intptr_t hwnd, _Inout_ int32 *pt)'),

      // --- 消息投递（虚拟输入的核心）---
      PostMessageW: b(user32, 'PostMessageW', 'bool __stdcall PostMessageW(intptr_t hwnd, uint32 msg, uintptr_t wp, intptr_t lp)'),
      SendMessageW: b(user32, 'SendMessageW', 'intptr_t __stdcall SendMessageW(intptr_t hwnd, uint32 msg, uintptr_t wp, intptr_t lp)'),
      SendMessageTimeoutW: b(user32, 'SendMessageTimeoutW', 'intptr_t __stdcall SendMessageTimeoutW(intptr_t hwnd, uint32 msg, uintptr_t wp, intptr_t lp, uint32 flags, uint32 timeout, _Out_ uintptr_t *result)'),

      // --- 窗口状态（只做非侵入式操作，绝不抢焦点）---
      ShowWindow: b(user32, 'ShowWindow', 'bool __stdcall ShowWindow(intptr_t hwnd, int cmd)'),
      SetWindowPos: b(user32, 'SetWindowPos', 'bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32 flags)'),
      UpdateWindow: b(user32, 'UpdateWindow', 'bool __stdcall UpdateWindow(intptr_t hwnd)'),
      InvalidateRect: b(user32, 'InvalidateRect', 'bool __stdcall InvalidateRect(intptr_t hwnd, intptr_t rect, bool erase)'),
      AttachThreadInput: b(user32, 'AttachThreadInput', 'bool __stdcall AttachThreadInput(uint32 attach, uint32 attachTo, bool fAttach)'),
      SetForegroundWindow: b(user32, 'SetForegroundWindow', 'bool __stdcall SetForegroundWindow(intptr_t hwnd)'),
      BringWindowToTop: b(user32, 'BringWindowToTop', 'bool __stdcall BringWindowToTop(intptr_t hwnd)'),

      // --- 键盘状态（用于构造正确的 lParam 与修饰键）---
      GetKeyState: b(user32, 'GetKeyState', 'int16 __stdcall GetKeyState(int vk)'),
      GetAsyncKeyState: b(user32, 'GetAsyncKeyState', 'int16 __stdcall GetAsyncKeyState(int vk)'),
      MapVirtualKeyW: b(user32, 'MapVirtualKeyW', 'uint32 __stdcall MapVirtualKeyW(uint32 code, uint32 mapType)'),
      GetKeyboardLayout: b(user32, 'GetKeyboardLayout', 'intptr_t __stdcall GetKeyboardLayout(uint32 threadId)'),
      ToUnicodeEx: b(user32, 'ToUnicodeEx', 'int __stdcall ToUnicodeEx(uint32 vk, uint32 scan, _In_ uint8_t *state, _Out_ char16_t *buf, int cch, uint32 flags, intptr_t layout)'),

      // --- 光标（只读取，用于并行性校验）---
      GetCursorPos: b(user32, 'GetCursorPos', 'bool __stdcall GetCursorPos(_Out_ int32 *pt)'),
      // 定位真实光标。**默认路径不用它**：本插件的虚拟鼠标靠窗口消息投递，
      // 不移动真实光标。只有"拖动窗口"这种系统级模态操作才需要（因为它由
      // 窗口管理器跟随真实光标实现），且那一路径会明确标注"会占用真实鼠标"。
      SetCursorPos: b(user32, 'SetCursorPos', 'bool __stdcall SetCursorPos(int X, int Y)'),

      // --- 悬浮窗 ---
      RegisterClassExW: b(user32, 'RegisterClassExW', 'uint16 __stdcall RegisterClassExW(_In_ uint8_t *wndclass)'),
      UnregisterClassW: b(user32, 'UnregisterClassW', 'bool __stdcall UnregisterClassW(char16_t *cls, intptr_t inst)'),
      CreateWindowExW: b(user32, 'CreateWindowExW', 'intptr_t __stdcall CreateWindowExW(uint32 ex, char16_t *cls, char16_t *title, uint32 style, int x, int y, int w, int h, intptr_t parent, intptr_t menu, intptr_t inst, intptr_t param)'),
      DefWindowProcW: b(user32, 'DefWindowProcW', 'intptr_t __stdcall DefWindowProcW(intptr_t hwnd, uint32 msg, uintptr_t wp, intptr_t lp)'),
      DestroyWindow: b(user32, 'DestroyWindow', 'bool __stdcall DestroyWindow(intptr_t hwnd)'),
      SetLayeredWindowAttributes: b(user32, 'SetLayeredWindowAttributes', 'bool __stdcall SetLayeredWindowAttributes(intptr_t hwnd, uint32 crKey, uint8 alpha, uint32 flags)'),
      GetMessageW: b(user32, 'GetMessageW', 'int __stdcall GetMessageW(_Out_ uint8_t *msg, intptr_t hwnd, uint32 min, uint32 max)'),
      PeekMessageW: b(user32, 'PeekMessageW', 'bool __stdcall PeekMessageW(_Out_ uint8_t *msg, intptr_t hwnd, uint32 min, uint32 max, uint32 remove)'),
      TranslateMessage: b(user32, 'TranslateMessage', 'bool __stdcall TranslateMessage(_In_ uint8_t *msg)'),
      DispatchMessageW: b(user32, 'DispatchMessageW', 'intptr_t __stdcall DispatchMessageW(_In_ uint8_t *msg)'),
      PostQuitMessage: b(user32, 'PostQuitMessage', 'void __stdcall PostQuitMessage(int code)'),

      // --- 显示器信息（供悬浮窗定位）---
      MonitorFromPoint: b(user32, 'MonitorFromPoint', 'intptr_t __stdcall MonitorFromPoint(int32 x, int32 y, uint32 flags)'),
      GetMonitorInfoW: b(user32, 'GetMonitorInfoW', 'bool __stdcall GetMonitorInfoW(intptr_t monitor, _Out_ uint8_t *info)'),

      // --- GDI 绘制 ---
      // 注意：FillRect 属于 **user32.dll**，不是 gdi32.dll（这是本项目踩过的坑，
      // 绑错 DLL 会让整块绑定失败，见 bind() 的说明）。
      GetDC: b(user32, 'GetDC', 'intptr_t __stdcall GetDC(intptr_t hwnd)'),
      GetWindowDC: b(user32, 'GetWindowDC', 'intptr_t __stdcall GetWindowDC(intptr_t hwnd)'),
      ReleaseDC: b(user32, 'ReleaseDC', 'int __stdcall ReleaseDC(intptr_t hwnd, intptr_t dc)'),
      BeginPaint: b(user32, 'BeginPaint', 'intptr_t __stdcall BeginPaint(intptr_t hwnd, _Out_ uint8_t *ps)'),
      EndPaint: b(user32, 'EndPaint', 'bool __stdcall EndPaint(intptr_t hwnd, _In_ uint8_t *ps)'),
      FillRect: b(user32, 'FillRect', 'int __stdcall FillRect(intptr_t dc, _In_ int32 *rect, intptr_t brush)'),
      // PrintWindow：抓取窗口内容的官方途径，能拍**被遮挡/移到屏幕外**的窗口
      // （它要求窗口自己重绘到给定的 DC，因此窗口外也能抓到）。
      PrintWindow: b(user32, 'PrintWindow', 'bool __stdcall PrintWindow(intptr_t hwnd, intptr_t dc, uint32 flags)'),
      CreateSolidBrush: b(gdi32, 'CreateSolidBrush', 'intptr_t __stdcall CreateSolidBrush(uint32 color)'),
      DeleteObject: b(gdi32, 'DeleteObject', 'bool __stdcall DeleteObject(intptr_t obj)'),
      CreatePen: b(gdi32, 'CreatePen', 'intptr_t __stdcall CreatePen(int style, int width, uint32 color)'),
      SelectObject: b(gdi32, 'SelectObject', 'intptr_t __stdcall SelectObject(intptr_t dc, intptr_t obj)'),
      Rectangle: b(gdi32, 'Rectangle', 'bool __stdcall Rectangle(intptr_t dc, int left, int top, int right, int bottom)'),
      RoundRect: b(gdi32, 'RoundRect', 'bool __stdcall RoundRect(intptr_t dc, int left, int top, int right, int bottom, int ew, int eh)'),
      Ellipse: b(gdi32, 'Ellipse', 'bool __stdcall Ellipse(intptr_t dc, int left, int top, int right, int bottom)'),
      SetBkMode: b(gdi32, 'SetBkMode', 'int __stdcall SetBkMode(intptr_t dc, int mode)'),
      SetTextColor: b(gdi32, 'SetTextColor', 'uint32 __stdcall SetTextColor(intptr_t dc, uint32 color)'),
      CreateFontW: b(gdi32, 'CreateFontW', 'intptr_t __stdcall CreateFontW(int h, int w, int esc, int orient, int weight, uint32 italic, uint32 underline, uint32 strike, uint32 charset, uint32 prec, uint32 clip, uint32 quality, uint32 pitch, char16_t *face)'),
      TextOutW: b(gdi32, 'TextOutW', 'bool __stdcall TextOutW(intptr_t dc, int x, int y, char16_t *text, int len)'),
      GetTextExtentPoint32W: b(gdi32, 'GetTextExtentPoint32W', 'bool __stdcall GetTextExtentPoint32W(intptr_t dc, char16_t *text, int len, _Out_ int32 *size)'),

      // --- 截图的 GDI 管线（内存 DC + 位图 + 位块传输 + 像素回读）---
      // 这条链路是"看图"能力的基础：把窗口或屏幕的内容搬进内存位图，
      // 再用 GetDIBits 取回 BGRA 像素，最后编码成 PNG 交给模型。
      CreateCompatibleDC: b(gdi32, 'CreateCompatibleDC', 'intptr_t __stdcall CreateCompatibleDC(intptr_t dc)'),
      CreateCompatibleBitmap: b(gdi32, 'CreateCompatibleBitmap', 'intptr_t __stdcall CreateCompatibleBitmap(intptr_t dc, int w, int h)'),
      BitBlt: b(gdi32, 'BitBlt', 'bool __stdcall BitBlt(intptr_t dst, int x, int y, int w, int h, intptr_t src, int sx, int sy, uint32 rop)'),
      GetDIBits: b(gdi32, 'GetDIBits', 'int __stdcall GetDIBits(intptr_t dc, intptr_t bmp, uint32 start, uint32 lines, _Out_ uint8_t *bits, _Inout_ uint8_t *info, uint32 usage)'),
      DeleteDC: b(gdi32, 'DeleteDC', 'bool __stdcall DeleteDC(intptr_t dc)'),
      StretchBlt: b(gdi32, 'StretchBlt', 'bool __stdcall StretchBlt(intptr_t dst, int dx, int dy, int dw, int dh, intptr_t src, int sx, int sy, int sw, int sh, uint32 rop)'),
      SetStretchBltMode: b(gdi32, 'SetStretchBltMode', 'int __stdcall SetStretchBltMode(intptr_t dc, int mode)'),

      // --- 键盘钩子 ---
      SetWindowsHookExW: b(user32, 'SetWindowsHookExW', 'intptr_t __stdcall SetWindowsHookExW(int idHook, void *lpfn, intptr_t hMod, uint32 threadId)'),
      UnhookWindowsHookEx: b(user32, 'UnhookWindowsHookEx', 'bool __stdcall UnhookWindowsHookEx(intptr_t hhk)'),
      CallNextHookEx: b(user32, 'CallNextHookEx', 'intptr_t __stdcall CallNextHookEx(intptr_t hhk, int nCode, uintptr_t wp, intptr_t lp)'),
      GetModuleHandleW: b(kernel32, 'GetModuleHandleW', 'intptr_t __stdcall GetModuleHandleW(char16_t *name)'),
      GetCurrentThreadId: b(kernel32, 'GetCurrentThreadId', 'uint32 __stdcall GetCurrentThreadId()'),

      // --- 进程信息（用于判断目标窗口所属程序的类型，例如终端）---
      OpenProcess: b(kernel32, 'OpenProcess', 'intptr_t __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
      QueryFullProcessImageNameW: b(kernel32, 'QueryFullProcessImageNameW', 'bool __stdcall QueryFullProcessImageNameW(intptr_t process, uint32 flags, _Out_ char16_t *name, _Inout_ uint32 *size)'),
      CloseHandle: b(kernel32, 'CloseHandle', 'bool __stdcall CloseHandle(intptr_t handle)'),
      // 失败原因诊断的核心：PostMessageW/SendMessageW 返回 0 时，
      // 只有 GetLastError 能区分「UIPI 拒绝(5)」「窗口已销毁(1400)」「消息队列满(1201)」等。
      GetLastError: b(kernel32, 'GetLastError', 'uint32 __stdcall GetLastError()'),

      // --- 合成输入（仅用于测试与显式降级路径）---
      SendInput: b(user32, 'SendInput', 'uint32 __stdcall SendInput(uint32 n, _In_ uint8_t *inputs, int size)'),
    };

    // 只有核心绑定（枚举 + 消息投递 + 光标）全都在，才认为 FFI 可用。
    const core = ['EnumWindows', 'PostMessageW', 'GetCursorPos', 'IsWindow', 'GetWindowTextW'];
    const missingCore = core.filter((name) => bound[name] === undefined);
    if (missingCore.length > 0) {
      bound = {
        reason: `core Win32 bindings unavailable: ${missingCore.join(', ')} (${failures.join(' | ')})`,
        failures,
      };
    }
  } catch (error) {
    bound = { reason: `Win32 binding failed: ${error?.message ?? String(error)}`, failures };
  }
  return bound;
}

/**
 * 供诊断使用：FFI 是否可用、绑定到了哪个 koffi、宿主/线程信息，
 * 以及**哪些单个函数绑定失败**（能力不完整的精确清单）。
 */
export function describeNative() {
  const loaded = loadWin32();
  if (loaded.reason !== undefined) {
    return {
      supported: false,
      reason: loaded.reason,
      failures: loaded.failures ?? [],
      pid: process.pid,
      platform: process.platform,
    };
  }
  return {
    supported: true,
    koffi: loaded.from,
    koffiVersion: loaded.koffi.version ?? undefined,
    pid: process.pid,
    parentPid: Number(process.ppid),
    threadId: Number(loaded.GetCurrentThreadId()),
    platform: process.platform,
    // 空数组 = 全部绑定成功；非空表示这些函数不可用，但其余功能正常。
    failures: loaded.failures ?? [],
  };
}

/**
 * 读取 UTF-16 字符串缓冲区。
 *
 * @param fn - 形如 `GetWindowTextW(hwnd, buf, max)` 的绑定函数。
 */
export function readWide(fn, hwnd, chars) {
  try {
    if (typeof fn !== 'function') return '';
    const buffer = Buffer.alloc(chars * 2);
    const length = fn(hwnd, buffer, chars);
    if (!Number.isFinite(length) || length <= 0) return '';
    return buffer.toString('utf16le', 0, length * 2);
  } catch {
    return '';
  }
}

/** 把 JS 字符串编码成 koffi 可用的 UTF-16 NUL 结尾缓冲区。 */
export function wideBuffer(text) {
  return Buffer.from(`${text}\0`, 'utf16le');
}

/**
 * 枚举窗口。回调返回 false 可提前停止。
 *
 * @param options.childrenOf - 传入 hwnd 时改为枚举其子窗口。
 */
export function enumWindows(visit, options = {}) {
  const loaded = loadWin32();
  if (loaded.reason !== undefined) return;
  // koffi 的回调原型按名字全局注册，同名重复声明会抛错，所以只声明一次。
  const proto = enumWindows.proto ??= loaded.koffi.pointer(
    loaded.koffi.proto('bool __stdcall DshVcuEnumProc(intptr_t hwnd, intptr_t lParam)'),
  );
  const callback = loaded.koffi.register((hwnd) => {
    try {
      return visit(Number(hwnd)) !== false;
    } catch {
      return true;
    }
  }, proto);
  try {
    if (options.childrenOf !== undefined) {
      loaded.EnumChildWindows(options.childrenOf, callback, 0);
    } else {
      loaded.EnumWindows(callback, 0);
    }
  } finally {
    try {
      loaded.koffi.unregister(callback);
    } catch {
      // 枚举结束后回调自动失效时忽略。
    }
  }
}

/** 读取窗口矩形，失败返回 undefined。 */
export function windowRect(loaded, hwnd) {
  try {
    const rect = Buffer.alloc(16);
    if (loaded.GetWindowRect(hwnd, rect) !== true) return undefined;
    const left = rect.readInt32LE(0);
    const top = rect.readInt32LE(4);
    const right = rect.readInt32LE(8);
    const bottom = rect.readInt32LE(12);
    return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  } catch {
    return undefined;
  }
}

/** 读取客户区矩形（相对客户区原点），失败返回 undefined。 */
export function clientRect(loaded, hwnd) {
  try {
    const rect = Buffer.alloc(16);
    if (loaded.GetClientRect(hwnd, rect) !== true) return undefined;
    const left = rect.readInt32LE(0);
    const top = rect.readInt32LE(4);
    const right = rect.readInt32LE(8);
    const bottom = rect.readInt32LE(12);
    return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  } catch {
    return undefined;
  }
}

/** 读取窗口所属进程 id。 */
export function windowPid(loaded, hwnd) {
  try {
    const buffer = Buffer.alloc(4);
    loaded.GetWindowThreadProcessId(hwnd, buffer);
    return buffer.readUInt32LE(0);
  } catch {
    return 0;
  }
}
