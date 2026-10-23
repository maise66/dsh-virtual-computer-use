/**
 * dsh-virtual-computer-use —— 虚拟输入层（鼠标 + 键盘窗口消息注入）。
 *
 * ## 核心设计目标：真实光标不动
 *
 * 除**显式的窗口拖动降级路径**外，全部输入都走 `PostMessageW` 把 WM_* 消息塞进
 * 目标窗口的消息队列，**绝不调用 `SendInput` / `mouse_event`**，也不靠移动光标
 * 来产生点击。因此：
 *   - 用户的物理鼠标可以并行操作，两者互不干扰；
 *   - 不会因为我们的动作而打断用户正在做的事；
 *   - 代价是：目标是"离屏渲染"级别的模拟，对某些控件不生效（见下）。
 *
 * 唯一的例外是 `drag(hwnd, from, to, { mode: 'window' })`：拖动窗口标题栏是
 * 窗口管理器的**模态循环**，它跟随真实光标，纯消息注入无效（实测）。该路径会
 * 移动真实光标，因此**必须显式选择**，并在返回值里标注 `usesRealCursor: true`。
 *
 * 本模块只 import 只读的 `lib/native.js`，不修改它。
 *
 * ## 已知局限（PostMessage 对以下目标常常无效，实测与共识）
 *
 *   1. **UWP / 打包应用**（设置、计算器、XAML Islands）：输入栈走
 *      CoreWindow/InputPane，WM_* 消息不进入其输入泵。→ 需降级路径。
 *   2. **更高完整性级别的窗口**（以管理员运行的程序）：UIPI 会丢弃来自低
 *      完整性进程的 PostMessage（PostMessageW 直接返回 false）。→ 只能提权。
 *   3. **Chromium/Electron 的部分控件**：渲染进程自有输入转发，主窗口的
 *      WM_MOUSE* 可能被忽略；浏览器内容区对 WM_CHAR 尤其不可靠。
 *   4. **DirectInput / 全屏游戏 / 远程桌面客户端**：轮询 *AsyncKeyState 而非
 *      消息队列，PostMessage 完全无效。
 *   5. **终端类窗口**（Windows Terminal / conhost）与 **IME 组合窗口**：
 *      前者走 ConPTY 自有输入通道，后者依赖真实焦点与 IME 状态。
 *   6. **窗口拖动（移动窗口本身）**：是窗口管理器的模态循环，纯 PostMessage
 *      不会移动窗口 —— 必须走 `drag({mode:'window'})` 的真实光标路径。
 *   7. 消息进的是**目标窗口的消息队列**，因此它必须有一条正在跑的消息循环；
 *      挂死（IsHungAppWindow）的窗口消息永远不会被处理。
 *
 * ## 关键局限：非字符按键语义不可靠（实测，必读）
 *
 * `PostMessage` 把消息直接塞进目标窗口队列，**绕过接收线程消息循环里的
 * `TranslateMessage`**。于是：
 *
 *   | 消息                          | 纯 PostMessage 下 | 原因 |
 *   |-------------------------------|-------------------|------|
 *   | `WM_CHAR`（字符、含中文/emoji）| **可靠**          | 窗口过程直接处理 |
 *   | `WM_MOUSE*`（鼠标）            | **可靠**          | 窗口过程直接处理 |
 *   | `WM_KEYDOWN` 的非字符语义      | **不可靠**        | 依赖 TranslateMessage |
 *   | `EM_*`（编辑控件消息）         | **可靠**          | 控件自身直接处理 |
 *
 * 真实 notepad 控制变量实测：
 *   - `pressKey(hwnd,'delete')` → 消息投递成功，**文本完全没变**；
 *   - `keyCombo(hwnd,'ctrl+a')` → 选区仍是 `{10,10}`，但内容多出一个 `"a"`，
 *     说明**修饰键没生效、`a` 被当普通字符插入了**；
 *   - `Home`/`End`/方向键 → 选区起止**永远等于插入点**，根本没有形成选区。
 *
 * 因此对**编辑控件**，凡涉及"选区 + 非字符键"的操作都应改走 `EM_*` 消息
 * （`EM_SETSEL` / `EM_REPLACESEL` / `EM_GETSEL`），这些由控件自身处理、不经
 * 消息循环翻译，实测全部可靠 —— 见 `selectAll()` / `replaceSelection()` /
 * `clearSelection()` / `edit()`。
 *
 * `pressKey`/`keyCombo` 的返回值**不会**用一个看起来成功的 `ok:true` 掩盖这件事：
 * 它们额外带 `reliability: 'low'|'medium'|'high'`、`degraded`、`note`、
 * `recommendedAlternative` 和 `measuredEvidence` 字段。`ok` 只表示**消息投递成功**，
 * 不等于目标真的执行了动作。
 *
 * ## 降级路径（会抢焦点 / 会动光标）
 *
 * `ensureTargetReady()` 默认只做非侵入操作（若最小化则 `ShowWindow(SW_RESTORE)`，
 * 再 `SetWindowPos(SWP_NOACTIVATE)` 抬 Z 序）。若确实需要真实前台化，必须显式
 * 传 `{ allowFocusSteal: true }`，此时会调用 `SetForegroundWindow` —— **这会抢走
 * 用户当前的焦点**，属于"会抢焦点"的降级路径，调用方必须明确知道。
 *
 * `pressKey(..., { foreground: true })` / `click(..., { foreground: true })` 同样
 * 属于降级路径：先抢焦点，再改用同步 `SendMessageW` 直接投递（绕过队列），用于
 * 目标窗口消息泵卡住或对 PostMessage 不敏感的场合。
 *
 * `drag(..., { mode: 'window' })` 属于"会动真实光标"的降级路径。
 *
 * ## 所有 API 绝不抛异常
 *
 * 每个公开函数返回结构化对象；失败时 `{ ok:false, reason }`。凡是成功投递了消息
 * 的动作都会带 `posted`（实际 PostMessageW 返回 true 的消息条数），便于审计。
 * 另有 `messagesPosted` 作为 `posted` 的别名，兼容两种读法。
 */

import {
  loadWin32,
  WM,
  MK,
  VK,
  SW,
  SWP,
  SB,
  HT,
  enumWindows,
  windowRect,
  clientRect,
  windowPid,
  readWide,
  describeNative,
} from './native.js';

/** 本模块内部使用的 Win32 常量（native.js 未导出的部分在此补齐，不改 native.js）。 */
const MSG = {
  ...WM,
  GETDLGCODE: 0x0087,
  KEYFIRST: 0x0100,
  KEYLAST: 0x0109,
  SYSCHAR_EXT: 0x0106,
};

/** MapVirtualKey 的映射类型。 */
const MAPVK = {
  VK_TO_VSC: 0, // 虚拟键码 → 扫描码
  VK_TO_VSC_EX: 3, // 扩展：0xE0/0xE1 前缀编码进高字节（用后需掩掉）
};

/** 需要 0xE0 前缀的扩展键。lParam 的 bit 24 必须置位，否则部分程序解析错误。 */
const EXTENDED_VKS = new Set([
  0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, // PGUP PGDN END HOME LEFT UP RIGHT DOWN
  0x2d, 0x2e, // INSERT DELETE
  0x5b, 0x5c, 0x5d, // LWIN RWIN APPS
  0x6f, // NUMPAD_DIVIDE
  0x90, // NUMLOCK
  0xa3, 0xa5, // RCONTROL / RMENU
]);

/**
 * 同一虚拟键码在主键盘/小键盘上扫描码不同的键，必须显式指定 extended。
 *
 * 最重要的一例：**VK_RETURN**。主键盘 Enter 的 lParam bit24 = 0、扫描码 0x1C；
 * 只有**小键盘 Enter** 才是扩展键。把主键盘 Enter 标成扩展键，会让记事本之类
 * 的编辑控件把它当成小键盘回车处理（实测会插错东西），所以这里按主键盘处理，
 * 小键盘回车请显式用 `{ extended: true }`。
 */
const NON_EXTENDED_OVERRIDES = new Set([0x0d]);

/** Alt 组合要走 WM_SYSKEY*，否则菜单加速键（Alt+F 等）不会生效。 */
const SYS_MODIFIER_VKS = new Set([VK.MENU]);

/** 修饰键 → 虚拟键码。 */
const MODIFIER_VKS = {
  ctrl: VK.CONTROL,
  control: VK.CONTROL,
  shift: VK.SHIFT,
  alt: VK.MENU,
  menu: VK.MENU,
  win: VK.LWIN,
  super: VK.LWIN,
  meta: VK.LWIN,
  cmd: VK.LWIN,
};

/** 名字 → 虚拟键码。键一律小写、去空格。 */
const NAMED_KEYS = {
  // 编辑键
  backspace: 0x08, back: 0x08, bs: 0x08,
  tab: 0x09,
  enter: 0x0d, return: 0x0d, cr: 0x0d, '\n': 0x0d, '\r': 0x0d,
  shift: 0x10,
  ctrl: 0x11, control: 0x11,
  alt: 0x12, menu: 0x12,
  pause: 0x13, break: 0x13,
  capslock: 0x14, caps: 0x14,
  esc: 0x1b, escape: 0x1b,
  space: 0x20, ' ': 0x20, spacebar: 0x20,
  pageup: 0x21, pgup: 0x21, prior: 0x21,
  pagedown: 0x22, pgdn: 0x22, next: 0x22,
  end: 0x23,
  home: 0x24,
  left: 0x25, arrowleft: 0x25,
  up: 0x26, arrowup: 0x26,
  right: 0x27, arrowright: 0x27,
  down: 0x28, arrowdown: 0x28,
  select: 0x29,
  print: 0x2a, printscreen: 0x2c, prtsc: 0x2c, snapshot: 0x2c,
  insert: 0x2d, ins: 0x2d,
  delete: 0x2e, del: 0x2e,
  help: 0x2f,
  // 修饰键（左右分开）
  lshift: 0xa0, rshift: 0xa1,
  lctrl: 0xa2, rctrl: 0xa3, lcontrol: 0xa2, rcontrol: 0xa3,
  lalt: 0xa4, ralt: 0xa5, lmenu: 0xa4, rmenu: 0xa5,
  lwin: 0x5b, rwin: 0x5c, lsuper: 0x5b, rsuper: 0x5c, lmeta: 0x5b, rmeta: 0x5c,
  apps: 0x5d, contextmenu: 0x5d, menu_key: 0x5d,
  // 锁
  numlock: 0x90, scrolllock: 0x91, scroll: 0x91,
  // 小键盘
  numpad0: 0x60, numpad1: 0x61, numpad2: 0x62, numpad3: 0x63, numpad4: 0x64,
  numpad5: 0x65, numpad6: 0x66, numpad7: 0x67, numpad8: 0x68, numpad9: 0x69,
  multiply: 0x6a, add: 0x6b, separator: 0x6c, subtract: 0x6d, decimal: 0x6e, divide: 0x6f,
  numpadmul: 0x6a, numpadadd: 0x6b, numpadsub: 0x6d, numpaddec: 0x6e, numpaddiv: 0x6f,
  // 标点（物理键，用虚拟键码；配合 shift 可出符号）
  semicolon: 0xba, equals: 0xbb, equal: 0xbb, comma: 0xbc, minus: 0xbd,
  period: 0xbe, dot: 0xbe, slash: 0xbf, backtick: 0xc0, grave: 0xc0,
  bracketleft: 0xdb, bracketright: 0xdd, backslash: 0xdc, quote: 0xde,
};

/** 一次性补齐 a-z / 0-9 / f1-f24。 */
for (let i = 0; i < 26; i += 1) {
  NAMED_KEYS[String.fromCharCode(97 + i)] = 0x41 + i;
}
for (let i = 0; i < 10; i += 1) {
  NAMED_KEYS[String(i)] = 0x30 + i;
}
for (let i = 1; i <= 24; i += 1) {
  NAMED_KEYS[`f${i}`] = 0x6f + i;
}

// ---------------------------------------------------------------------------
// 绑定层
// ---------------------------------------------------------------------------

/**
 * 本模块依赖 `lib/native.js` 的 `loadWin32()`。
 *
 * 该函数是单例、每个函数**独立** try/catch（单个绑定失败只记进 `loaded.failures`
 * 并返回 `undefined`），只有核心绑定全缺时才判定 FFI 不可用。所以这里直接
 * 消费即可，不做任何补绑——补绑会掩盖 native.js 的真实问题。
 *
 * 注：进程映像查询（OpenProcess / QueryFullProcessImageNameW）native.js 未向
 * 本模块的依赖面导出，因此 `probeWindow()` 的 `image` 字段通常为 `undefined`，
 * 敏感度启发式会自动跳过基于映像名的判断（详见 describeSensitivity）。
 * 映像名由调用方（tools 层）用 `windows.js` 的 `processImagePath(pid)` 组装，
 * **本模块不 import windows.js**，避免循环依赖。
 */

/** 内部：拿到绑定，或在不可用时抛一个带 dshReason 的错误。公开 API 全部包了 try。 */
function requireBindings() {
  const loaded = loadWin32();
  if (loaded.reason !== undefined) {
    const error = new Error(loaded.reason);
    error.dshReason = loaded.reason;
    throw error;
  }
  return loaded;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 把任意值规整成 32 位有符号整数。 */
function toInt32(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n) | 0;
}

/** 把任意值规整成无符号 32 位（用于 u32 参数，koffi 用 BigInt 也可）。 */
function toUint32(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n) >>> 0;
}

/** hwnd 规整成 number。koffi 的 intptr_t 默认以 number 回传（本机 64 位下仍在安全范围）。 */
function toHwnd(value) {
  return Number(value);
}

/**
 * 把客户区坐标打包成 lParam：`(y << 16) | x`，按**有符号 16 位**语义。
 *
 * Windows 真实做法就是这个：>32767 的坐标被折成负数，接收方用
 * `GET_X_LPARAM`（即 `(short)(lParam & 0xFFFF)`）还原。JS 里 `<<16` 天然丢高位，
 * 但用 `|` 会得到**有符号 32 位**结果，再被 koffi 当 intptr_t（64 位）传时，
 * 负数会符号扩展到 0xFFFFFFFFxxxxxxxx —— 这在 32 位 API 里是对的（低 32 位一致），
 * 所以这里显式 `| 0` 固化成 int32 再交给 koffi。
 *
 * @returns {{ lp: number, x: number, y: number, lx: number, ly: number }}
 */
export function packMouseLParam(x, y) {
  const cx = toInt32(x);
  const cy = toInt32(y);
  const low = (cx & 0xffff) >>> 0;
  const high = ((cy & 0xffff) >>> 0) << 16;
  const lp = (high | low) | 0; // int32，有符号
  // 用有符号 16 位还原，验证往返一致
  return {
    lp,
    x: cx,
    y: cy,
    lx: (lp << 16) >> 16,
    ly: lp >> 16,
  };
}

/** 从 lParam 反解，等价于 GET_X_LPARAM / GET_Y_LPARAM。 */
export function unpackMouseLParam(lp) {
  const v = toInt32(lp);
  return { x: (v << 16) >> 16, y: v >> 16 };
}

/**
 * 构造 WM_KEYDOWN/WM_KEYUP/WM_SYSKEYDOWN/WM_SYSKEYUP 的 lParam。
 *
 * 位域（MSDN 键盘输入 lParam）：
 *   bits  0-15  repeat count           → 1
 *   bits 16-23  scan code              → MapVirtualKeyW(vk, MAPVK_VK_TO_VSC)
 *   bit  24     extended key           → 方向键/Ins/Del/Home/End/PgUp/PgDn/...
 *   bits 25-28  reserved               → 0
 *   bit  29     context code (Alt 按下)→ 1 表示 Alt 处于按下状态
 *   bit  30     previous key state     → KEYUP 时必须为 1
 *   bit  31     transition state       → KEYUP 时为 1
 *
 * 全部用无符号算术构建，最后 `| 0` 固化 int32，避免 JS 位运算符号位踩坑。
 */
export function buildKeyLParam(vk, options = {}) {
  const { keyUp = false, altDown = false, extended, scanCode } = options;
  const code = toInt32(vk) & 0xff;
  let scan = scanCode;
  if (scan === undefined) {
    scan = scanCodeForVk(code);
  }
  const extendedBit = extended ?? (EXTENDED_VKS.has(code) && !NON_EXTENDED_OVERRIDES.has(code));

  let lp = 1; // repeat count = 1
  lp |= (toInt32(scan) & 0xff) << 16;
  if (extendedBit) lp |= 1 << 24;
  if (altDown) lp |= 1 << 29;
  if (keyUp) {
    lp |= 1 << 30; // previous key state
    lp |= 1 << 31; // transition state
  }
  return lp | 0;
}

/** 扫描码缓存（MapVirtualKeyW 很便宜，但缓存让代码更干净）。 */
const scanCache = new Map();

/** 取虚拟键码对应的扫描码；失败返回 0（合法：部分键无扫描码）。 */
export function scanCodeForVk(vk) {
  const code = toInt32(vk) & 0xff;
  if (scanCache.has(code)) return scanCache.get(code);
  let scan = 0;
  try {
    const loaded = requireBindings();
    if (loaded.MapVirtualKeyW !== undefined) {
      // 用 MAPVK_VK_TO_VSC(0)，不用 3：类型 3 会把 0xE0 前缀编码进高字节，
      // 而扩展位我们已单独用 lParam bit24 表达，混用会得到错误的扫描码。
      scan = Number(loaded.MapVirtualKeyW(code, MAPVK.VK_TO_VSC)) & 0xff;
    }
  } catch {
    scan = 0;
  }
  scanCache.set(code, scan);
  return scan;
}

/** 解析 key 名称 → 虚拟键码。返回 `{ ok, vk }` 或 `{ ok:false, reason }`。 */
export function resolveKey(name) {
  if (typeof name === 'number' && Number.isFinite(name)) {
    const vk = Math.trunc(name);
    if (vk < 0 || vk > 0xff) return { ok: false, reason: `virtual-key code out of range: ${vk}` };
    return { ok: true, vk, label: `vk:${vk}` };
  }
  if (typeof name !== 'string') {
    return { ok: false, reason: `key must be a string or number, got ${typeof name}` };
  }
  const raw = name;
  const normalized = name.trim().toLowerCase().replace(/\s+/g, '');
  if (normalized === '') return { ok: false, reason: 'empty key name' };

  // 单字符：字母/数字走 VK 表；其它单字符当作要打字的内容（WM_CHAR），不是按键。
  if (normalized.length === 1) {
    const hit = NAMED_KEYS[normalized];
    if (hit !== undefined) return { ok: true, vk: hit, label: normalized };
    // 用字符的 UTF-16 码点反查（只对 ASCII 有意义）
    const code = normalized.charCodeAt(0);
    if (code >= 0x20 && code < 0x7f) {
      const upper = normalized.toUpperCase();
      if (NAMED_KEYS[upper.toLowerCase()] !== undefined) {
        return { ok: true, vk: NAMED_KEYS[upper.toLowerCase()], label: raw };
      }
    }
    return {
      ok: false,
      reason: `"${raw}" is not a press-able key; it is a character — use writeText() for text`,
    };
  }

  // 显式虚拟键码字面量。约定：
  //   `vk:0x41` / `0x41` → 十六进制 0x41 = 65
  //   `vk:65`            → 十进制 65
  // 只在带前缀时生效，否则 "f5" 这类名字会被误当十六进制数。
  const hexMatch = /^(?:vk:)?0x([0-9a-f]+)$/.exec(normalized);
  if (hexMatch !== null) {
    const vk = Number.parseInt(hexMatch[1], 16);
    if (Number.isFinite(vk) && vk >= 0 && vk <= 0xff) return { ok: true, vk, label: raw };
    return { ok: false, reason: `virtual-key literal out of range (0x00-0xFF): ${raw}` };
  }
  const decMatch = /^vk:(\d+)$/.exec(normalized);
  if (decMatch !== null) {
    const vk = Number.parseInt(decMatch[1], 10);
    if (Number.isFinite(vk) && vk >= 0 && vk <= 0xff) return { ok: true, vk, label: raw };
    return { ok: false, reason: `virtual-key literal out of range (0-255): ${raw}` };
  }

  const hit = NAMED_KEYS[normalized];
  if (hit === undefined) {
    return { ok: false, reason: `unknown key name: "${raw}"` };
  }
  return { ok: true, vk: hit, label: normalized };
}

/**
 * 把 "ctrl+shift+a" / "enter" / "alt+tab" 解析成 `{ modifiers, keys }`。
 *
 * 规则：`+` 分隔；前导的修饰键名收集进 modifiers，其余作为主键（允许多个，
 * 按顺序依次按下/抬起，用于 alt+tab 这种"一次按一下"的语义）。
 */
export function parseKeySpec(spec) {
  let parts;
  if (Array.isArray(spec)) {
    parts = spec.map((item) => String(item));
  } else if (typeof spec === 'string') {
    // 按 '+' 切分。注意 "ctrl++"（想按加号键）会切成 ['ctrl','','']，
    // 空片段被丢弃后就没有主键了 —— 这是**故意**的：'+' 是分隔符，
    // 要按加号键请写 "ctrl+add"（小键盘加号）或 ['ctrl', 0xBB]（主键盘加号）。
    parts = spec.split('+').map((item) => item.trim()).filter((item) => item !== '');
  } else {
    return { ok: false, reason: `key spec must be a string or array, got ${typeof spec}` };
  }
  if (parts.length === 0) return { ok: false, reason: 'empty key spec' };

  const modifiers = [];
  const keys = [];
  for (const part of parts) {
    const lower = part.toLowerCase().replace(/\s+/g, '');
    const modifierVk = MODIFIER_VKS[lower];
    if (modifierVk !== undefined && keys.length === 0) {
      if (!modifiers.includes(modifierVk)) modifiers.push(modifierVk);
      continue;
    }
    const resolved = resolveKey(part);
    if (resolved.ok !== true) return resolved;
    keys.push(resolved.vk);
  }
  if (keys.length === 0) {
    return { ok: false, reason: `key spec "${spec}" has modifiers but no main key` };
  }
  return { ok: true, modifiers, keys };
}

/** 修饰键集合里是否有 Alt（决定走 SYSKEY* 还是 KEY*）。 */
function hasAlt(modifiers) {
  return modifiers.some((vk) => SYS_MODIFIER_VKS.has(vk));
}

/**
 * 走一遍修饰键的 VirtualKeyState，供调用方声明"调用期间修饰键被视为按下"。
 *
 * 关键诚实说明：`PostMessageW` **不修改真实的键盘状态表**，所以目标窗口在
 * 处理 WM_KEYDOWN(0x41) 时若去查 `GetKeyState(VK_CONTROL)`，看到的是**用户物理
 * 键盘的真实状态**，而不是我们模拟出来的。因此：
 *   - 对绝大多数程序（记事本、资源管理器、浏览器正文）无影响：它们用
 *     "WM_KEYDOWN 的 vk 是 A 且 lParam bit29/修饰键消息在前"来判断快捷键；
 *   - 对少数严格依赖 `GetKeyState` 的控件（部分老式 MFC 网格、某些游戏内
 *     UI）则可能判断失败。
 * 本模块把这一事实通过 `modifierStateNote` 字段显式暴露给调用方，不假装一致。
 */
function modifierStateNote(modifiers) {
  if (modifiers.length === 0) return undefined;
  const names = modifiers
    .map((vk) => {
      if (vk === VK.CONTROL) return 'Ctrl';
      if (vk === VK.SHIFT) return 'Shift';
      if (vk === VK.MENU) return 'Alt';
      if (vk === VK.LWIN) return 'Win';
      return `vk:${vk}`;
    })
    .join('+');
  return (
    `PostMessage does not alter the real keyboard state: while ${names} messages are posted, ` +
    'GetKeyState() inside the target still reports the user\'s physical keyboard. ' +
    'Programs that read the modifier from the WM_KEYDOWN sequence work; programs that poll ' +
    'GetKeyState() may not.'
  );
}

// ---------------------------------------------------------------------------
// 消息投递原语
// ---------------------------------------------------------------------------

/**
 * 统一的投递器。默认 `PostMessageW`（异步、不阻塞、不抢焦点）；
 * `mode:'send'` 时用 `SendMessageW`（同步、会阻塞直到目标处理完，用于降级路径）。
 */
function deliver(loaded, hwnd, message, wParam, lParam, mode) {
  const target = toHwnd(hwnd);
  const wp = toUint32(wParam);
  const lp = toInt32(lParam);
  if (mode === 'send') {
    const result = loaded.SendMessageW(target, message, wp, lp);
    return { sent: 1, posted: 0, lastResult: Number(result) };
  }
  const ok = loaded.PostMessageW(target, message, wp, lp);
  if (ok === true) {
    return { sent: 1, posted: 1, lastResult: 1 };
  }
  // 失败必须留下错误码：没有它只能写"UIPI or dead window"这种让人无法行动的话。
  const lastError = typeof loaded.GetLastError === 'function' ? Number(loaded.GetLastError()) : undefined;
  return { sent: 0, posted: 0, lastResult: 0, lastError, lastErrorText: describeWin32Error(lastError) };
}

/** 把常见 Win32 错误码翻译成一句能据此行动的话。 */
function describeWin32Error(code) {
  switch (code) {
    case 5:
      return 'ERROR_ACCESS_DENIED（UIPI 拒绝：目标窗口进程权限高于本进程）';
    case 6:
      return 'ERROR_INVALID_HANDLE（窗口句柄无效）';
    case 87:
      return 'ERROR_INVALID_PARAMETER（消息参数非法）';
    case 1201:
      return 'ERROR_MSG_QUEUE_FULL（目标消息队列已满，通常是目标线程卡死）';
    case 1400:
      return 'ERROR_INVALID_WINDOW_HANDLE（窗口已销毁）';
    case 1460:
      return 'ERROR_TIMEOUT';
    default:
      return code === undefined ? '未知（未取到 GetLastError）' : `Win32 错误 ${code}`;
  }
}

/** 累加器，让每个动作都能报出"实际投递了多少条"。 */
function createCounter() {
  return { posted: 0, failed: 0, sent: 0, messages: [], lastError: undefined, lastErrorText: undefined };
}

function record(counter, outcome, message, detail) {
  counter.posted += outcome.posted;
  counter.sent += outcome.sent;
  if (outcome.sent === 0) {
    counter.failed += 1;
    // 记住第一次失败的错误码，供 explainDeliveryFailure 给出可执行结论。
    if (counter.lastError === undefined && outcome.lastError !== undefined) {
      counter.lastError = outcome.lastError;
      counter.lastErrorText = outcome.lastErrorText;
    }
  }
  if (counter.messages.length < 64) {
    counter.messages.push({
      message: `0x${message.toString(16).padStart(4, '0')}`,
      ...detail,
      ok: outcome.sent > 0,
      ...(outcome.lastError === undefined ? {} : { lastError: outcome.lastError }),
    });
  }
}

/** 给所有成功结果补上 `messagesPosted` 别名，兼容两种读法。 */
function withAliases(result) {
  if (result !== null && typeof result === 'object' && typeof result.posted === 'number' && result.messagesPosted === undefined) {
    result.messagesPosted = result.posted;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 窗口查询与前置准备
// ---------------------------------------------------------------------------

/** 读窗口类名。 */
function classNameOf(loaded, hwnd) {
  return readWide((h, buf, max) => loaded.GetClassNameW(h, buf, max), hwnd, 256);
}

/** 读窗口标题。 */
function titleOf(loaded, hwnd) {
  try {
    if (loaded.GetWindowTextW === undefined) return '';
    const max = 1024;
    const buffer = Buffer.alloc(max * 2);
    const length = loaded.GetWindowTextW(hwnd, buffer, max);
    if (!Number.isFinite(length) || length <= 0) return '';
    return buffer.toString('utf16le', 0, length * 2);
  } catch {
    return '';
  }
}

/**
 * 目标进程可执行文件路径 —— 仅用于审计展示。
 *
 * native.js 未向本模块导出 OpenProcess / QueryFullProcessImageNameW / CloseHandle，
 * 因此这里在缺少绑定时直接返回 `undefined`（**不抛异常、不自行补绑**）。
 * 映像名由 tools 层用 windows.js 组装（本模块不 import windows.js，避免循环依赖）。
 */
function imageNameOf(loaded, pid) {
  try {
    const openProcess = loaded.OpenProcess;
    const queryName = loaded.QueryFullProcessImageNameW;
    const closeHandle = loaded.CloseHandle;
    if (openProcess === undefined || queryName === undefined || closeHandle === undefined) {
      return undefined;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const handle = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, toUint32(pid));
    if (handle === 0 || handle === null || handle === undefined) return undefined;
    try {
      const buffer = Buffer.alloc(1024 * 2);
      const size = Buffer.alloc(4);
      size.writeUInt32LE(1024, 0);
      if (queryName(handle, 0, buffer, size) !== true) return undefined;
      const chars = size.readUInt32LE(0);
      return buffer.toString('utf16le', 0, chars * 2);
    } finally {
      closeHandle(handle);
    }
  } catch {
    return undefined;
  }
}

/**
 * 目标窗口快照：一次性拿到调用方做决策需要的全部客观信息。
 *
 * @returns `{ ok:true, hwnd, className, title, pid, image, rect, client, visible, enabled,
 *            iconic, hung, foreground, isForeground, problems:[] }`
 *          或 `{ ok:false, reason }`。绝不抛异常。
 */
export function probeWindow(hwnd) {
  try {
    const loaded = requireBindings();
    const target = toHwnd(hwnd);
    if (!Number.isFinite(target) || target === 0) {
      return { ok: false, reason: `invalid hwnd: ${String(hwnd)}` };
    }
    if (loaded.IsWindow(target) !== true) {
      return { ok: false, reason: `hwnd ${target} is not a window (IsWindow=false)` };
    }
    const pid = windowPid(loaded, target);
    const problems = [];
    const visible = loaded.IsWindowVisible(target) === true;
    const enabled = loaded.IsWindowEnabled(target) === true;
    const iconic = loaded.IsIconic(target) === true;
    const hung = loaded.IsHungAppWindow !== undefined && loaded.IsHungAppWindow(target) === true;
    if (!visible) problems.push('window is not visible');
    if (!enabled) problems.push('window is disabled');
    if (iconic) problems.push('window is minimized');
    if (hung) problems.push('window is not responding (IsHungAppWindow)');
    return {
      ok: true,
      hwnd: target,
      className: classNameOf(loaded, target),
      title: titleOf(loaded, target),
      pid,
      image: imageNameOf(loaded, pid),
      rect: windowRect(loaded, target),
      client: clientRect(loaded, target),
      visible,
      enabled,
      iconic,
      hung,
      foreground: Number(loaded.GetForegroundWindow()),
      isForeground: Number(loaded.GetForegroundWindow()) === target,
      problems,
    };
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error) };
  }
}

/**
 * 探测目标窗口是否被 **UIPI** 挡住（目标进程权限高于本进程）。
 *
 * 背景：Windows 的 UIPI 会把低权限进程发给高权限窗口的窗口消息**静默丢弃**，
 * `PostMessageW` 返回 FALSE（GetLastError=5）。插件以前只回一句
 * "PostMessageW failed (UIPI or dead window)"，模型无法判断到底是窗口死了、
 * 还是目标程序以管理员身份运行 —— 于是反复重试，什么都做不成。
 *
 * 判定方式：用 `PROCESS_QUERY_LIMITED_INFORMATION` 尝试打开目标进程。
 * 同权限及以下一般能打开；打开失败（拒绝访问）基本就是目标进程处于更高完整性级别。
 * 这不是 100% 精确（受保护进程也会拒绝），所以字段名用 `likelyHigherIntegrity`
 * 并在文案里说清"可能"。
 */
export function probePrivilege(hwnd) {
  try {
    const loaded = requireBindings();
    const target = toHwnd(hwnd);
    if (loaded.IsWindow(target) !== true) {
      return { ok: false, reason: `hwnd ${target} 不是有效窗口（已关闭？）` };
    }
    const pid = windowPid(loaded, target);
    if (!Number.isFinite(pid) || pid === 0) {
      return { ok: false, reason: '无法取得目标窗口所属进程 pid' };
    }
    if (loaded.OpenProcess === undefined) {
      return { ok: false, pid, reason: 'OpenProcess 绑定不可用，无法判断权限' };
    }
    const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    let handle;
    try {
      handle = loaded.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    } catch (error) {
      return { ok: false, pid, reason: error?.dshReason ?? error?.message ?? String(error) };
    }
    const opened = Number(handle) !== 0;
    if (opened && loaded.CloseHandle !== undefined) {
      try {
        loaded.CloseHandle(handle);
      } catch {
        // 关句柄失败不影响判断。
      }
    }
    return {
      ok: true,
      pid,
      opened,
      likelyHigherIntegrity: opened === false,
      hint: opened === false
        ? `目标进程 pid=${pid} 拒绝访问：它很可能以管理员权限运行。UIPI 会丢弃低权限进程投递的窗口消息，`
          + `因此点击/输入不会有任何效果。解决办法：以同等或更高权限运行本体程序，`
          + `或让目标程序以普通权限重启。`
        : `目标进程 pid=${pid} 可以被本进程打开，权限层面不是拦截原因；`
          + `消息投递失败时更可能是窗口已销毁、控件自绘不响应消息，或控件需要真实输入。`,
    };
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error) };
  }
}

/**
 * 把一次失败投递的原因说清楚：优先给出**可执行结论**，而不是让调用方猜。
 *
 * 判定顺序：
 *   1. 有 Win32 错误码 → 按错误码直说（5=UIPI、1400=窗口没了、1201=目标卡死…）。
 *   2. 没有错误码 → 用权限探测区分「权限不够」与「控件不响应消息」。
 */
function explainDeliveryFailure(hwnd, counter) {
  const failedCount = typeof counter === 'number' ? counter : (counter?.failed ?? 0);
  const lastError = typeof counter === 'object' ? counter?.lastError : undefined;
  const lastErrorText = typeof counter === 'object' ? counter?.lastErrorText : undefined;
  const base = `PostMessageW 有 ${failedCount} 条消息没有投递成功（hwnd ${toHwnd(hwnd)}）。`;
  if (lastError !== undefined) {
    if (lastError === 5) {
      return `${base}Win32 错误 5（拒绝访问）：目标窗口所在进程的完整性级别高于本进程，`
        + 'UIPI 会丢弃低权限进程投递的窗口消息。请以相同或更高权限运行本体程序，'
        + '或让目标程序以普通权限重启。';
    }
    if (lastError === 1400 || lastError === 6) {
      return `${base}${lastErrorText ?? ''}：窗口句柄已失效，请重新 vcu_find_window 定位。`;
    }
    if (lastError === 1201) {
      return `${base}${lastErrorText ?? ''}：目标线程消息队列已满（多半是程序卡死/忙碌），`
        + '请先确认目标程序是否响应，再重试。';
    }
    return `${base}${lastErrorText ?? `Win32 错误 ${lastError}`}`;
  }
  const privilege = probePrivilege(hwnd);
  if (privilege.ok !== true) {
    return `${base}权限探测失败：${privilege.reason}`;
  }
  return `${base}${privilege.hint}`;
}

/**
 * 让目标窗口"尽量可接收输入"，且**默认不抢焦点**。
 *
 * 默认只做非侵入动作：
 *   - 最小化 → `ShowWindow(SW_RESTORE)`（恢复窗口，会改变可见状态但不改焦点）；
 *   - `SetWindowPos(HWND_TOP, SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE)` 抬 Z 序。
 *
 * @param options.allowFocusSteal - **降级路径**。为 true 时调用 `SetForegroundWindow`，
 *   **会抢走用户当前焦点**。返回结果里 `stoleFocus: true` 明确标注。
 * @param options.attachThreadInput - 配合 allowFocusSteal：先 AttachThreadInput 到
 *   目标线程，提高 SetForegroundWindow 成功率（Windows 前台锁限制）。
 */
export function ensureTargetReady(hwnd, options = {}) {
  const { allowFocusSteal = false, restore = true, raiseZ = true, attachThreadInput = true } = options;
  try {
    const loaded = requireBindings();
    const before = probeWindow(hwnd);
    if (before.ok !== true) return before;

    const actions = [];
    const target = before.hwnd;
    const foregroundBefore = before.foreground;

    if (restore && before.iconic === true && loaded.ShowWindow !== undefined) {
      const ok = loaded.ShowWindow(target, SW.RESTORE) === true;
      actions.push({ action: 'ShowWindow(SW_RESTORE)', ok, note: 'restored a minimized window' });
    }

    if (raiseZ && loaded.SetWindowPos !== undefined) {
      const HWND_TOP = 0;
      const flags = SWP.NOMOVE | SWP.NOSIZE | SWP.NOACTIVATE;
      const ok = loaded.SetWindowPos(target, HWND_TOP, 0, 0, 0, 0, flags) === true;
      actions.push({ action: 'SetWindowPos(HWND_TOP, NOACTIVATE)', ok, note: 'raises z-order without activation' });
    }

    let stoleFocus = false;
    if (allowFocusSteal === true && loaded.SetForegroundWindow !== undefined) {
      const currentThread = Number(loaded.GetCurrentThreadId !== undefined ? loaded.GetCurrentThreadId() : 0);
      const targetThread = Number(loaded.GetWindowThreadProcessId(target, Buffer.alloc(4)));
      let attached = false;
      if (attachThreadInput && currentThread !== 0 && targetThread !== 0 && loaded.AttachThreadInput !== undefined) {
        attached = loaded.AttachThreadInput(currentThread, targetThread, true) === true;
      }
      try {
        stoleFocus = loaded.SetForegroundWindow(target) === true;
      } finally {
        if (attached) loaded.AttachThreadInput(currentThread, targetThread, false);
      }
      actions.push({
        action: 'SetForegroundWindow',
        ok: stoleFocus,
        note: 'FOCUS-STEALING fallback: the user\'s previous window lost foreground',
      });
    }

    const after = probeWindow(target);
    return {
      ok: true,
      hwnd: target,
      ready: after.ok === true && after.visible === true && after.enabled === true && after.hung !== true,
      stoleFocus,
      focusWarning: stoleFocus
        ? 'ensureTargetReady stole the foreground window (allowFocusSteal:true). The user\'s active window changed.'
        : undefined,
      foregroundBefore,
      foregroundAfter: Number(loaded.GetForegroundWindow()),
      actions,
      probe: after,
      inputSensitiveCaveat: describeSensitivity(after),
    };
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error) };
  }
}

/**
 * 编辑控件消息（均可跨进程工作，EDITTEXT/RichEdit 通用）。
 *
 * 实测依据：裸 `WM_KEYDOWN` 依赖目标线程消息循环的 `TranslateMessage`，而
 * `PostMessage` 绕过了它；`EM_*` 由控件自身直接处理，所以可靠。
 */
const EM = {
  GETSEL: 0x00b0,
  SETSEL: 0x00b1,
  GETRECT: 0x00b2,
  SCROLLCARET: 0x00b7,
  GETLINECOUNT: 0x00ba,
  GETLINE: 0x00c4,
  REPLACESEL: 0x00c2,
  SETLIMITTEXT: 0x00c5,
  GETLIMITTEXT: 0x00d5,
  SETMODIFY: 0x00b9,
  GETMODIFY: 0x00b8,
  LINEFROMCHAR: 0x00c9,
  LINELENGTH: 0x00c3,
  GETFIRSTVISIBLELINE: 0x00ce,
  SETREADONLY: 0x00cf,
  UNDO: 0x00c7,
  WM_CLEAR: 0x0303,
  WM_COPY: 0x0301,
  WM_CUT: 0x0300,
  WM_PASTE: 0x0302,
};

/** 判定窗口是否为"可用 EM_* 消息操作"的编辑控件。 */
export function isEditControl(hwnd) {
  try {
    const loaded = requireBindings();
    const target = toHwnd(hwnd);
    if (loaded.IsWindow(target) !== true) return { ok: false, reason: `hwnd ${target} is not a window` };
    const className = classNameOf(loaded, target);
    const looksEditable = /^(Edit|RichEdit|RichEdit20W|RichEdit20A|RichEdit50W|RichEditD2DPT|RichEditD2D|TextInputHost)/i.test(className);
    // 用 EM_GETLINECOUNT 做一次**行为探测**：非编辑控件通常返回 0 或不响应。
    const lineCount = Number(loaded.SendMessageW(target, EM.GETLINECOUNT, 0, 0));
    const lineLength = Number(loaded.SendMessageW(target, EM.LINELENGTH, 0, 0));
    const probeOk = Number.isFinite(lineCount) || Number.isFinite(lineLength);
    return {
      ok: true,
      hwnd: target,
      className,
      looksEditable,
      lineCount: Number.isFinite(lineCount) ? lineCount : undefined,
      /**
       * 是否**看起来**能被 EM_* 可靠操作。类名匹配是主依据；行为探测作为佐证
       * （注意空编辑控件返回 lineCount=1，非编辑控件也可能返回 0，所以不单靠它）。
       */
      supportsEditMessages: looksEditable,
      probeOk,
    };
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error) };
  }
}

/** 读编辑控件当前选区。返回 `{ ok, start, end }`；非编辑控件返回 `{ok:false}`。 */
export function getSelection(hwnd) {
  try {
    const loaded = requireBindings();
    const info = isEditControl(hwnd);
    if (info.ok !== true) return info;
    if (info.supportsEditMessages !== true) {
      return { ok: false, reason: `hwnd ${info.hwnd} (class "${info.className}") is not an edit control; EM_* messages do not apply`, className: info.className };
    }
    const packed = Number(loaded.SendMessageW(info.hwnd, EM.GETSEL, 0, 0));
    return {
      ok: true,
      hwnd: info.hwnd,
      start: packed & 0xffff,
      end: (packed >>> 16) & 0xffff,
      collapsed: (packed & 0xffff) === ((packed >>> 16) & 0xffff),
      className: info.className,
    };
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error) };
  }
}

/**
 * **可靠全选** —— 走 `EM_SETSEL(0, -1)`，而不是 Ctrl+A 组合键。
 *
 * 这是本模块对编辑控件的**首选**全选路径：实测 notepad 选区从 `{10,10}` 变成
 * `{0,10}`，而 `keyCombo(hwnd,'ctrl+a')` 选区完全不动（且会误插一个 'a'）。
 *
 * @returns `{ ok, start, end, verified, method:'EM_SETSEL' }`
 *          `verified` 是通过 `EM_GETSEL` **回读确认**选区真的覆盖了内容长度。
 */
export function selectAll(hwnd, options = {}) {
  try {
    const loaded = requireBindings();
    const info = isEditControl(hwnd);
    if (info.ok !== true) return info;
    if (info.supportsEditMessages !== true) {
      return {
        ok: false,
        reason: `hwnd ${info.hwnd} (class "${info.className}") is not an edit control; EM_SETSEL does not apply`,
        className: info.className,
        fallback: "use keyCombo(hwnd,'ctrl+a') and expect degraded reliability (see pressKey.reliability)",
        degraded: true,
      };
    }
    // EM_SETSEL(start, end)：end=-1 表示"一直到文本末尾"。
    loaded.SendMessageW(info.hwnd, EM.SETSEL, 0, -1);
    const selection = getSelection(info.hwnd);
    const length = Number(loaded.SendMessageW(info.hwnd, MSG.GETTEXTLENGTH, 0, 0));
    const verified = selection.ok === true && Number.isFinite(length)
      && selection.start === 0 && (selection.end === length || length === 0);
    return withAliases({
      ok: true,
      hwnd: info.hwnd,
      method: 'EM_SETSEL',
      start: selection.start,
      end: selection.end,
      textLength: Number.isFinite(length) ? length : undefined,
      verified,
      posted: 0,
      sent: 1,
      className: info.className,
      note: 'select-all performed with EM_SETSEL (reliable), not with the Ctrl+A key combination',
    });
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error) };
  }
}

/**
 * **可靠替换选区** —— 走 `EM_REPLACESEL(TRUE, text)`。
 *
 * `text` 为空串即"删除当前选区"（可靠的清空）。
 * 未指定 `start`/`end` 时使用当前选区；指定时先 `EM_SETSEL(start,end)` 再替换。
 *
 * 字符串通过 `koffi.address()` 以**裸地址**传给目标进程 —— 实测跨进程可写入，
 * 因为 `EM_REPLACESEL` 是控件直接处理的消息。
 *
 * @returns `{ ok, before, after, changed, verified, ... }`
 */
export function replaceSelection(hwnd, text, options = {}) {
  try {
    const loaded = requireBindings();
    const info = isEditControl(hwnd);
    if (info.ok !== true) return info;
    if (info.supportsEditMessages !== true) {
      return {
        ok: false,
        reason: `hwnd ${info.hwnd} (class "${info.className}") is not an edit control; EM_REPLACESEL does not apply`,
        className: info.className,
        fallback: 'use writeText() for characters, or pressKey() accepting degraded reliability',
        degraded: true,
      };
    }
    if (typeof text !== 'string') {
      return { ok: false, reason: `text must be a string, got ${typeof text}` };
    }

    if (options.start !== undefined || options.end !== undefined) {
      const start = toInt32(options.start ?? 0);
      const end = options.end === undefined ? -1 : toInt32(options.end);
      loaded.SendMessageW(info.hwnd, EM.SETSEL, start, end);
    }

    const selectionBefore = getSelection(info.hwnd);
    const lengthBefore = Number(loaded.SendMessageW(info.hwnd, MSG.GETTEXTLENGTH, 0, 0));

    const payload = Buffer.from(`${text}\0`, 'utf16le');
    const address = Number(loaded.koffi.address(payload));
    // wParam = TRUE：控件应把此操作记入撤销栈，使之可被用户 Ctrl+Z 撤销。
    const result = Number(loaded.SendMessageW(info.hwnd, EM.REPLACESEL, options.addToUndo === false ? 0 : 1, address));

    const lengthAfter = Number(loaded.SendMessageW(info.hwnd, MSG.GETTEXTLENGTH, 0, 0));
    const expectedDelta = text.length - (selectionBefore.ok === true
      ? Math.max(0, selectionBefore.end - selectionBefore.start)
      : 0);
    const changed = Number.isFinite(lengthBefore) && Number.isFinite(lengthAfter);
    const verified = changed && (lengthAfter - lengthBefore) === expectedDelta;

    return withAliases({
      ok: true,
      hwnd: info.hwnd,
      method: 'EM_REPLACESEL',
      text,
      selectionBefore: selectionBefore.ok === true ? { start: selectionBefore.start, end: selectionBefore.end } : undefined,
      lengthBefore: Number.isFinite(lengthBefore) ? lengthBefore : undefined,
      lengthAfter: Number.isFinite(lengthAfter) ? lengthAfter : undefined,
      expectedDelta,
      actualDelta: changed ? lengthAfter - lengthBefore : undefined,
      verified,
      posted: 0,
      sent: 1,
      className: info.className,
      rawResult: Number.isFinite(result) ? result : undefined,
    });
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error) };
  }
}

/**
 * **可靠的清空/删除选区** —— `EM_REPLACESEL(TRUE, "")`。
 *
 * 实验证明这是唯一能可靠清空编辑控件的方法：`Delete` 键经 PostMessage 发出去
 * 会返回成功但什么都不删（详见本文件顶部 EM_* 的说明）。
 */
export function clearSelection(hwnd, options = {}) {
  try {
    const loaded = requireBindings();
    const info = isEditControl(hwnd);
    if (info.ok !== true) return info;
    if (info.supportsEditMessages !== true) {
      return {
        ok: false,
        reason: `hwnd ${info.hwnd} (class "${info.className}") is not an edit control; EM_REPLACESEL does not apply`,
        className: info.className,
        degraded: true,
      };
    }
    // 先确保选区非空：options.selectAll 时全选；否则用当前选区。
    let selection = getSelection(info.hwnd);
    if (options.selectAll === true || (selection.ok === true && selection.collapsed === true && options.requireNonEmpty === true)) {
      const all = selectAll(info.hwnd);
      if (all.ok !== true) return all;
      selection = getSelection(info.hwnd);
    }
    const replaced = replaceSelection(info.hwnd, '', options);
    if (replaced.ok !== true) return replaced;
    return {
      ...replaced,
      operation: 'clearSelection',
      selectionBeforeClear: selection.ok === true ? { start: selection.start, end: selection.end } : undefined,
      clearedChars: replaced.selectionBefore !== undefined
        ? replaced.selectionBefore.end - replaced.selectionBefore.start
        : undefined,
    };
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error) };
  }
}

/**
 * 读写编辑控件内容的统一入口。
 *
 * `op` 取值：
 *   - `'read'`             → 读全文（走 EM_GETLINE）
 *   - `'write'`            → 写入文本（走 writeText 的 WM_CHAR 路径，可靠）
 *   - `'selectAll'`        → 可靠全选
 *   - `'replaceSelection'` → 替换选区（`text` 为空即删除）
 *   - `'clear'`            → 可靠清空（`selectAll` + `replaceSelection('')`）
 *   - `'append'`           → 追加到末尾
 *   - `'selection'`        → 只读选区
 */
export function edit(hwnd, op, text, options = {}) {
  try {
    switch (op) {
      case 'read':
        return readTextViaMessages(hwnd, options);
      case 'selection':
        return getSelection(hwnd);
      case 'selectAll':
        return selectAll(hwnd, options);
      case 'replaceSelection':
        return replaceSelection(hwnd, text ?? '', options);
      case 'clear':
        return clearSelection(hwnd, { ...options, selectAll: options.selectAll !== false });
      case 'append': {
        const selected = selectAll(hwnd, options);
        if (selected.ok !== true) return selected;
        // 全选后把光标摺到末尾（EM_SETSEL(-1,-1) 语义由 length..length 表达）
        const loaded = requireBindings();
        const length = Number(loaded.SendMessageW(selected.hwnd, MSG.GETTEXTLENGTH, 0, 0));
        loaded.SendMessageW(selected.hwnd, EM.SETSEL, length, length);
        return writeText(selected.hwnd, text ?? '', options);
      }
      case 'write':
        return writeText(hwnd, text ?? '', options);
      default:
        return {
          ok: false,
          reason: `unknown edit op: ${String(op)} (use read|write|selectAll|replaceSelection|clear|append|selection)`,
        };
    }
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error) };
  }
}

/**
 * 根据窗口快照给出"PostMessage 是否可能生效"的诚实评估。
 * 这是启发式判断，不是保证。
 *
 * 另外会检测**是否为编辑控件**（决定能不走可靠的 EM_* 路径），以及给出
 * `wmKeydownReliability` —— 提醒调用方 `WM_KEYDOWN` 类按键在纯 PostMessage 下
 * 普遍不可靠（绕过 TranslateMessage），字符走 WM_CHAR 才可靠。
 */
export function describeSensitivity(probe) {
  if (probe?.ok !== true) return { likely: 'unknown', reasons: ['no probe data'] };
  const reasons = [];
  let likely = 'yes';
  const cls = String(probe.className ?? '');
  const image = String(probe.image ?? '').toLowerCase();

  if (probe.hung === true) {
    reasons.push('window is hung: posted messages will not be pumped');
    likely = 'no';
  }
  if (probe.enabled === false) {
    reasons.push('window is disabled: input messages are ignored');
    likely = 'no';
  }
  if (/ApplicationFrameWindow|Windows\.UI\.Core\.CoreWindow|WindowsUIView/.test(cls)) {
    reasons.push('UWP/XAML window: input goes through CoreWindow, WM_* injection is unreliable');
    likely = 'unlikely';
  }
  if (/Intermediate D3D Window|Chrome_WidgetWin/.test(cls)) {
    reasons.push('Chromium/Electron content surface: renderer owns input routing, WM_MOUSE* may be ignored');
    if (likely === 'yes') likely = 'unlikely';
  }
  if (/CASCADIA|ConsoleWindowClass/.test(cls)) {
    reasons.push('terminal host: input flows through ConPTY, WM_CHAR injection is unreliable');
    if (likely === 'yes') likely = 'unlikely';
  }
  if (/^(cmd|powershell|pwsh|windowsterminal|conhost)\.exe$/.test(image.split('\\').pop() ?? '')) {
    reasons.push('terminal-backed host process');
    if (likely === 'yes') likely = 'unlikely';
  }

  // 编辑控件识别：决定是否有可靠的 EM_* 路径可用。
  let editControl = false;
  try {
    const info = isEditControl(probe.hwnd);
    editControl = info.ok === true && info.supportsEditMessages === true;
  } catch {
    editControl = false;
  }
  if (editControl) {
    reasons.push('edit control detected: EM_SETSEL/EM_REPLACESEL/EM_GETLINE are available and reliable for ' +
      'selection, replacement and reading — prefer them over Ctrl+A/Delete/arrows');
  }

  return {
    likely,
    reasons,
    editControl,
    editControlApi: editControl
      ? ['selectAll', 'replaceSelection', 'clearSelection', 'getSelection', 'readTextViaMessages', 'edit']
      : [],
    /**
     * WM_CHAR（字符）与 WM_MOUSE*（鼠标）由窗口过程直接处理 → 可靠。
     * WM_KEYDOWN 的非字符语义依赖消息循环的 TranslateMessage → 纯 PostMessage 下不可靠。
     */
    messageReliability: {
      wmChar: 'reliable',
      wmMouse: 'reliable',
      wmKeydownNonCharacter: 'unreliable',
      wmKeydownWhy: 'PostMessage bypasses the receiving thread\'s TranslateMessage; measured on real notepad, ' +
        'Delete/Home/End/arrows/Ctrl+A were accepted but had no effect',
    },
  };
}

// ---------------------------------------------------------------------------
// 坐标
// ---------------------------------------------------------------------------

/**
 * 客户区坐标 → 屏幕坐标。
 * @returns `{ ok, x, y }` 或 `{ ok:false, reason }`
 */
export function clientToScreen(hwnd, x, y) {
  try {
    const loaded = requireBindings();
    const buffer = Buffer.alloc(8);
    buffer.writeInt32LE(toInt32(x), 0);
    buffer.writeInt32LE(toInt32(y), 4);
    if (loaded.ClientToScreen(toHwnd(hwnd), buffer) !== true) {
      return { ok: false, reason: `ClientToScreen failed for hwnd ${hwnd}` };
    }
    return { ok: true, x: buffer.readInt32LE(0), y: buffer.readInt32LE(4) };
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error) };
  }
}

/** 屏幕坐标 → 客户区坐标。 */
export function screenToClient(hwnd, x, y) {
  try {
    const loaded = requireBindings();
    const buffer = Buffer.alloc(8);
    buffer.writeInt32LE(toInt32(x), 0);
    buffer.writeInt32LE(toInt32(y), 4);
    if (loaded.ScreenToClient(toHwnd(hwnd), buffer) !== true) {
      return { ok: false, reason: `ScreenToClient failed for hwnd ${hwnd}` };
    }
    return { ok: true, x: buffer.readInt32LE(0), y: buffer.readInt32LE(4) };
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error) };
  }
}

/**
 * 把调用方给的坐标统一成**目标窗口客户区坐标**。
 *
 * - `space:'client'`（默认）：原样使用（语义就是"相对目标窗口客户区"）。
 * - `space:'screen'`：ScreenToClient 转换。
 * - `space:'window'`：相对窗口外框，减去客户区在窗口内的偏移。
 *
 * 历史兼容：老调用方写的是 `{ client: true }`，因为默认已是 client，等价于不传。
 */
export function normalizePoint(hwnd, x, y, options = {}) {
  const space = options.space ?? 'client';
  if (space === 'client') {
    return { ok: true, x: toInt32(x), y: toInt32(y), space: 'client' };
  }
  if (space === 'screen') {
    const converted = screenToClient(hwnd, x, y);
    if (converted.ok !== true) return converted;
    return { ok: true, x: converted.x, y: converted.y, space: 'client', from: 'screen' };
  }
  if (space === 'window') {
    const screen = clientToScreen(hwnd, 0, 0);
    if (screen.ok !== true) return screen;
    const rect = probeWindow(hwnd);
    if (rect.ok !== true) return rect;
    // 客户区原点在屏幕上的位置（screen）减去窗口左上角在屏幕上的位置（rect.left/top）
    // 就是客户区相对窗口外框的偏移。窗口坐标 = 客户区坐标 + 该偏移。
    const offsetX = screen.x - rect.rect.left;
    const offsetY = screen.y - rect.rect.top;
    return {
      ok: true,
      x: toInt32(x) + offsetX,
      y: toInt32(y) + offsetY,
      space: 'client',
      from: 'window',
      offset: { x: offsetX, y: offsetY },
    };
  }
  return { ok: false, reason: `unknown coordinate space: ${String(space)}` };
}

// ---------------------------------------------------------------------------
// 当前修饰键状态
// ---------------------------------------------------------------------------

/** 在 lParam/位域与 wParam 中反映"此刻用户真实按下的修饰键"。 */
function realModifierState(loaded) {
  let mk = 0;
  const pressed = [];
  try {
    if (loaded.GetAsyncKeyState !== undefined) {
      const query = (vk, flag, name) => {
        const state = Number(loaded.GetAsyncKeyState(vk));
        // 高位 0x8000 = 当前物理按下。这保证我们的 wParam 与用户真实键盘一致，
        // 目标程序若用 GetKeyState(MK_*) 判断修饰键，看到的与用户所见相同。
        if ((state & 0x8000) !== 0) {
          mk |= flag;
          pressed.push(name);
        }
      };
      query(VK.SHIFT, MK.SHIFT, 'shift');
      query(VK.CONTROL, MK.CONTROL, 'ctrl');
      query(0x04, 0, 'mbutton'); // VK_MBUTTON
      query(VK.MENU ?? 0x12, 0, 'alt');
    }
  } catch {
    // 读不到真实键盘状态时按"无修饰键"处理；这只影响 wParam 的修饰位，不影响主键投递。
  }
  return { mk, pressed, altDown: pressed.includes('alt') };
}

// ---------------------------------------------------------------------------
// 鼠标
// ---------------------------------------------------------------------------

const BUTTONS = {
  left: { down: MSG.LBUTTONDOWN, up: MSG.LBUTTONUP, dbl: MSG.LBUTTONDBLCLK, flag: MK.LBUTTON },
  right: { down: MSG.RBUTTONDOWN, up: MSG.RBUTTONUP, dbl: MSG.RBUTTONDBLCLK, flag: MK.RBUTTON },
  middle: { down: MSG.MBUTTONDOWN, up: MSG.MBUTTONUP, dbl: MSG.MBUTTONDBLCLK, flag: MK.MBUTTON },
};

/** 鼠标消息的可选行为。 */
const DEFAULT_TIMING = { moveSettleMs: 0, clickHoldMs: 0, doubleClickMs: 0, afterMs: 0 };

function sleepSync(ms) {
  const delay = toInt32(ms);
  if (delay <= 0) return;
  // 用 Atomics.wait 做同步睡眠，比忙等精确且不占 CPU。
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, delay);
}

/**
 * 移动虚拟鼠标（只投递 WM_MOUSEMOVE，**不动真实光标**）。
 *
 * @param hwnd - 目标窗口
 * @param x,y - 默认是**客户区坐标**
 * @param options.space - 'client'（默认）| 'screen' | 'window'
 * @param options.deliver - 'post'（默认）| 'send'（同步，降级路径）
 * @param options.button - 移动时报告的按键状态：'none'|'left'|'right'|'middle'
 * @returns `{ ok, posted, x, y, screen:{x,y}, lParam }`
 */
export function move(hwnd, x, y, options = {}) {
  const counter = createCounter();
  try {
    const loaded = requireBindings();
    const probe = probeWindow(hwnd);
    if (probe.ok !== true) return probe;
    const point = normalizePoint(probe.hwnd, x, y, options);
    if (point.ok !== true) return point;

    const mode = options.deliver === 'send' ? 'send' : 'post';
    const packed = packMouseLParam(point.x, point.y);
    const real = realModifierState(loaded);
    let wParam = real.mk;
    const button = options.button;
    if (button !== undefined && BUTTONS[button] !== undefined) wParam |= BUTTONS[button].flag;

    const outcome = deliver(loaded, probe.hwnd, MSG.MOUSEMOVE, wParam, packed.lp, mode);
    record(counter, outcome, MSG.MOUSEMOVE, { x: packed.x, y: packed.y, kind: 'mousemove' });

    const screen = clientToScreen(probe.hwnd, packed.x, packed.y);
    return withAliases({
      ok: counter.posted > 0 || counter.sent > 0,
      hwnd: probe.hwnd,
      posted: counter.posted,
      sent: counter.sent,
      failed: counter.failed,
      x: packed.x,
      y: packed.y,
      space: 'client',
      screen: screen.ok === true ? { x: screen.x, y: screen.y } : undefined,
      lParam: packed.lp,
      cursorUntouched: true,
      messages: counter.messages,
      reason: counter.failed > 0 ? explainDeliveryFailure(probe.hwnd, counter) : undefined,
    });
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error), posted: counter.posted };
  }
}

/**
 * 虚拟鼠标点击。
 *
 * 投递序列（POST 模式下）：`WM_MOUSEMOVE` → `WM_LBUTTONDOWN` → `WM_LBUTTONUP`，
 * 双击时中间再补 `WM_LBUTTONDBLCLK`。
 *
 * **绝不调用 SetCursorPos / SendInput** —— 真实光标保持不动。
 *
 * @param options.button - 'left'（默认）| 'right' | 'middle'
 * @param options.count - 点击次数；`2` 等价于双击（与 e2e 调用约定一致）
 * @param options.double - 是否双击（投递 LBUTTONDBLCLK）；`count:2` 会自动置位
 * @param options.space - 'client'（默认）| 'screen' | 'window'
 * @param options.deliver - 'post'（默认，不抢焦点）| 'send'（同步，降级路径）
 * @param options.foreground - **会抢焦点**。true 时先 ensureTargetReady({allowFocusSteal:true})
 *                            再改用 SendMessage 同步投递。
 * @param options.holdMs - down 与 up 之间的等待（默认 0）
 * @returns `{ ok, posted, sequence:[...], x, y, screen, cursorUntouched, ... }`
 */
export function click(hwnd, x, y, options = {}) {
  const counter = createCounter();
  try {
    const loaded = requireBindings();
    const buttonName = options.button ?? 'left';
    const button = BUTTONS[buttonName];
    if (button === undefined) {
      return { ok: false, reason: `unknown mouse button: ${String(buttonName)} (use left|right|middle)` };
    }
    const probe = probeWindow(hwnd);
    if (probe.ok !== true) return probe;
    const point = normalizePoint(probe.hwnd, x, y, options);
    if (point.ok !== true) return point;

    const foreground = options.foreground === true;
    let mode = options.deliver === 'send' ? 'send' : 'post';
    let focus = undefined;
    if (foreground) {
      focus = ensureTargetReady(probe.hwnd, { allowFocusSteal: true });
      mode = 'send';
    }

    const holdMs = options.holdMs ?? DEFAULT_TIMING.clickHoldMs;
    const doubleMs = options.doubleClickMs ?? DEFAULT_TIMING.doubleClickMs;
    // `count:2` 等价于双击 —— e2e 测试用 { count: 2 } 表达双击，这里两者都支持。
    const isDouble = options.double === true || toInt32(options.count ?? 1) >= 2;
    const packed = packMouseLParam(point.x, point.y);
    const base = realModifierState(loaded).mk;
    const sequence = [];

    const send = (message, extraFlag) => {
      const outcome = deliver(loaded, probe.hwnd, message, base | (extraFlag ?? 0), packed.lp, mode);
      record(counter, outcome, message, { x: packed.x, y: packed.y, kind: 'mouse' });
      sequence.push({ message: `0x${message.toString(16).padStart(4, '0')}`, ok: outcome.sent > 0 });
    };

    send(MSG.MOUSEMOVE, 0);
    if (isDouble) {
      // 双击语义：DOWN/UP/DOWN(DBLCLK)/UP —— Windows 用 DBLCLK 替代第二次 DOWN。
      send(button.down, button.flag);
      sleepSync(holdMs);
      send(button.up, 0);
      sleepSync(doubleMs);
      send(button.dbl, button.flag);
      sleepSync(holdMs);
      send(button.up, 0);
    } else {
      send(button.down, button.flag);
      if (holdMs > 0) sleepSync(holdMs);
      send(button.up, 0);
    }

    const screen = clientToScreen(probe.hwnd, packed.x, packed.y);
    const settle = options.settleMs ?? 0;
    if (settle > 0) sleepSync(settle);
    return withAliases({
      ok: counter.failed === 0,
      hwnd: probe.hwnd,
      button: buttonName,
      double: isDouble,
      posted: counter.posted,
      sent: counter.sent,
      failed: counter.failed,
      x: packed.x,
      y: packed.y,
      space: 'client',
      screen: screen.ok === true ? { x: screen.x, y: screen.y } : undefined,
      lParam: packed.lp,
      sequence,
      deliver: mode,
      cursorUntouched: true,
      stoleFocus: focus !== undefined ? focus.stoleFocus : false,
      focusWarning: focus?.focusWarning,
      messages: counter.messages,
      reason: counter.failed > 0 ? explainDeliveryFailure(probe.hwnd, counter) : undefined,
    });
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error), posted: counter.posted };
  }
}

/**
 * **拖拽**（按住左键从 from 拖到 to）。两种模式，语义差别很大：
 *
 * ### `mode:'content'`（默认）—— 纯消息，真实光标不动
 *
 * `WM_LBUTTONDOWN` → 多段 `WM_MOUSEMOVE`（wParam 带 `MK_LBUTTON`）→ `WM_LBUTTONUP`。
 * 用于**在控件内部**拖选文本/拖画选区。实测有效（记事本）：
 *   - 同列上下拖 → 选中 16 字；
 *   - 跨行斜拖 → 选中 58 字；
 *   - 反向（右下→左上）拖动同样正确选中。
 * 全程 `posted` 消息驱动，**真实光标不动**，`usesRealCursor:false`。
 *
 * 中间拆成多段 MOUSEMOVE 是必须的：编辑控件按"鼠标经过的字符位置"累积选区，
 * 只发一跳（从 from 直接到 to）在跨行/反向时选区会算错。
 *
 * ### `mode:'window'` —— **会移动真实光标**（降级路径）
 *
 * 拖动窗口标题栏由窗口管理器接管，是**模态循环**，它跟随**真实光标**而不是消息。
 * 实测（四组对照）：只发 `WM_NCLBUTTONDOWN(HTCAPTION)` 消息**不会移动窗口**；
 * 即使配合 `SetWindowPos(HWND_TOP)` / `SetForegroundWindow` / `BringWindowToTop`
 * 抬顶也**不动**；唯一有效的是「移动真实光标 + 注入**真实**鼠标按键」
 * （实测位移精确等于请求值，例如请求 (140,100) 就位移 (140,100)）。
 * 原因：该模态循环读的是系统的**真实按键状态**，不看消息队列里的按键。
 *
 * 因此本模式必须：
 *   `SetCursorPos(标题栏起点)` → `SendInput(LEFTDOWN)` → 分步移动光标 → `SendInput(LEFTUP)`
 *
 * 返回值标注 `usesRealCursor:true`；默认 `restoreCursor:true` 在结束时把光标
 * **放回拖拽前的位置**，把对用户的干扰降到最低（但拖拽期间光标确实会动）。
 *
 * #### 前提条件：目标标题栏必须在 Z 序最前且未被遮挡
 *
 * 模态循环按**真实光标下最顶层的窗口**做 hit-test。若目标标题栏被别的窗口
 * （尤其全屏置顶程序）盖住，循环抓到的是那个遮挡窗口，目标不会移动 ——
 * 此时本函数会**如实**返回 `moved:false`（不会谎报成功）。
 *
 * 调用方遇到 `moved:false` 时应先抬顶再重试：
 * `SetWindowPos(hwnd, HWND_TOP, x, y, 0, 0, SWP_NOSIZE|SWP_SHOWWINDOW)`
 * 再 `BringWindowToTop(hwnd)`。
 * 注意：`SetForegroundWindow` **不足够**（前台 ≠ Z 序最顶），
 * 且 `SWP_NOACTIVATE` 之类组合若不含 z-order 位也不会真正抬顶。
 *
 * @param from - `{x, y}`（默认客户区坐标）
 * @param to - `{x, y}`（默认客户区坐标）
 * @param options.mode - 'content'（默认）| 'window'
 * @param options.steps - 中间 MOUSEMOVE 段数（默认按距离自适应，2..24）
 * @param options.stepDelayMs - 每段之间的等待（默认 0）
 * @param options.restoreCursor - 仅 window 模式：结束时还原光标位置（默认 true）
 */
export function drag(hwnd, from, to, options = {}) {
  const counter = createCounter();
  try {
    const loaded = requireBindings();
    const probe = probeWindow(hwnd);
    if (probe.ok !== true) return probe;

    const mode = options.mode === 'window' ? 'window' : 'content';
    const base = realModifierState(loaded).mk;
    const sequence = [];

    // 注意：content 模式按**客户区坐标**解释 from/to（配合 space 选项）；
    // window 模式按**窗口坐标**解释，因为标题栏在客户区之上（属非客户区），
    // 且把 to 当作**位移量**。两者的坐标系不同，所以归一化要分开做 ——
    // 见 window 分支里的详细说明。
    if (mode !== 'window') {
      const start = normalizePoint(probe.hwnd, from?.x ?? 0, from?.y ?? 0, options);
      if (start.ok !== true) return start;
      const end = normalizePoint(probe.hwnd, to?.x ?? 0, to?.y ?? 0, options);
      if (end.ok !== true) return end;
      // content 模式：把归一化结果写回局部变量供后续使用。
      options = { ...options };
      from = { x: start.x, y: start.y };
      to = { x: end.x, y: end.y };
    }

    // 段数按距离自适应：太短的距离拆多段没意义，太长则要够密才能让控件正确累积选区。
    const distance = mode === 'window'
      ? Math.hypot(toInt32(to?.x ?? 0), toInt32(to?.y ?? 0))
      : Math.hypot((to.x ?? 0) - (from.x ?? 0), (to.y ?? 0) - (from.y ?? 0));
    const steps = Math.max(2, Math.min(24, toInt32(options.steps ?? Math.ceil(distance / 4)) || 2));
    const stepDelay = options.stepDelayMs ?? 0;

    const recordStep = (message, wParam, lParam, extra) => {
      const outcome = deliver(loaded, probe.hwnd, message, wParam, lParam, 'post');
      record(counter, outcome, message, { kind: 'drag', ...extra });
      sequence.push({ message: `0x${message.toString(16).padStart(4, '0')}`, ok: outcome.sent > 0, ...extra });
    };

    if (mode === 'window') {
      // ---------------------------------------------------------------------
      // 降级路径：窗口拖动必须跟随真实光标。这里会在拖拽期间真正移动光标。
      // 注意：本分支是该文件里**唯一**会移动光标的地方，且只在调用方显式
      // 传 { mode:'window' } 时才会走到。
      // ---------------------------------------------------------------------
      const setCursorPos = loaded.SetCursorPos;
      const moveCursor = typeof setCursorPos === 'function'
        ? (sx, sy) => { try { setCursorPos(toInt32(sx), toInt32(sy)); return true; } catch { return false; } }
        : undefined;
      if (moveCursor === undefined) {
        return {
          ok: false,
          reason: 'window drag requires the SetCursorPos binding, which native.js did not provide',
          mode,
        };
      }

      // 坐标语义修正（这里踩过一个坑，务必保留说明）：
      //
      // window 模式抓的是**标题栏**，而标题栏在客户区**之上**（属非客户区）。
      // 所以 from/to 在这里必须按**窗口坐标**理解（y=0 就是窗口外框顶边），
      // 不能用客户区坐标 —— 否则像 {x:200,y:12} 会被 clientToScreen 映到
      // 编辑区里（客户区 y=12 在标题栏下方），hit-test 返回 HTCLIENT，
      // 模态拖动循环永远不会启动。实测确认：用客户区坐标 → 窗口纹丝不动；
      // 用窗口坐标（窗口顶边 +14px）→ 位移精确等于请求值。
      //
      // 因此 window 模式下：
      //   - 传了 from/to  → 按窗口坐标（相对外框左上角）解释
      //   - 没传 from     → 默认取标题栏中间偏上（外框顶边 +titleBarOffset）
      const windowTopLeft = probe.rect === undefined
        ? undefined
        : { x: probe.rect.left, y: probe.rect.top };
      if (windowTopLeft === undefined) {
        return { ok: false, reason: 'cannot read the window rect needed for window drag', mode };
      }
      const titleBarOffset = Number.isFinite(options.titleBarOffset) ? options.titleBarOffset : 14;
      const screenStart = {
        x: windowTopLeft.x + (from === undefined ? Math.floor((probe.rect.width ?? 0) / 2) : toInt32(from.x)),
        y: windowTopLeft.y + (from === undefined ? titleBarOffset : toInt32(from.y)),
      };
      // to 是**位移量**语义：传 {x,y} 视为相对起点的偏移，便于"把窗口向右下拖 N 像素"。
      const screenEnd = {
        x: screenStart.x + (to === undefined ? 0 : toInt32(to.x)),
        y: screenStart.y + (to === undefined ? 0 : toInt32(to.y)),
      };

      // 合法性提示：起点若不在标题栏，模态循环不会启动。这里做一次自查并在
      // 返回值里如实报告，避免"静默什么都没发生"。
      const hitAtStart = () => {
        try {
          return Number(loaded.SendMessageW(probe.hwnd, MSG.NCHITTEST, 0,
            (((screenStart.y & 0xffff) << 16) | (screenStart.x & 0xffff)) >>> 0));
        } catch { return undefined; }
      };
      const hitCode = hitAtStart();
      const HT_CAPTION = 2;
      if (hitCode !== undefined && hitCode !== HT_CAPTION) {
        return {
          ok: false,
          mode,
          reason: `the window-drag start point (screen ${screenStart.x},${screenStart.y}) is not on the `
            + `title bar: WM_NCHITTEST returned ${hitCode} instead of ${HT_CAPTION} (HTCAPTION). `
            + 'Pass from:{x,y} in WINDOW coordinates (y=0 is the window outer top edge), '
            + 'or raise titleBarOffset.',
          hitTest: hitCode,
          screenStart,
        };
      }

      // 记住拖拽前的光标位置，结束后还原，尽量少干扰用户。
      const origin = cursorPosition();
      const cursorBefore = origin.ok === true ? { x: origin.x, y: origin.y } : undefined;

      // ⚠ 关键实测结论（本机四组对照，务必保留）：
      //
      //   A. SetWindowPos(HWND_TOP) + PostMessage(WM_NCLBUTTONDOWN,HTCAPTION)  → 窗口不动
      //   B. SetForegroundWindow + BringWindowToTop + 同上                      → 窗口不动
      //   C. A+B 组合 + 同上                                                    → 窗口不动
      //   D. SetCursorPos + **真实 SendInput 左键按住** + 移动光标 + 松开       → **位移精确 (150,110) = 期望值**
      //
      // 结论：窗口拖动是窗口管理器的**模态循环**，它同时需要
      //   (1) 真实光标位置（决定窗口拖到哪），
      //   (2) **真实的鼠标按键状态**（决定循环何时开始/结束）。
      // 只发 `WM_NCLBUTTONDOWN` 消息**不够** —— 模态循环不看消息队列里的按键，
      // 而读系统的真实按键状态。这就是 A/B/C 全部失败、只有 D 成功的原因。
      //
      // 所以 window 模式必须走真实 SendInput。这是本插件里唯一动用它的地方，
      // 返回值里以 `usesRealCursor:true` + `warning` 显式标注。
      const INPUT_MOUSE = 0;
      const MOUSEEVENTF_LEFTDOWN = 0x0002;
      const MOUSEEVENTF_LEFTUP = 0x0004;
      /** 构造并投递一条真实鼠标按键事件（x64 下 INPUT 结构 40 字节）。 */
      const sendRealMouseButton = (down) => {
        // 结构布局：type(4)+pad(4)+MOUSEINPUT{dx,dy,mouseData,dwFlags,time,dwExtraInfo}
        const SIZE = 40;
        const buf = Buffer.alloc(SIZE);
        buf.writeUInt32LE(INPUT_MOUSE, 0);
        buf.writeInt32LE(0, 8);   // dx
        buf.writeInt32LE(0, 12);  // dy
        buf.writeUInt32LE(0, 16); // mouseData
        buf.writeUInt32LE(down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP, 20);
        buf.writeUInt32LE(0, 24); // time
        buf.writeBigUInt64LE(0n, 32); // dwExtraInfo
        try {
          const ok = loaded.SendInput(1, buf, SIZE);
          return ok === 1;
        } catch {
          return false;
        }
      };

      // 先把真实光标放到标题栏上的起点，再按下真实左键（顺序不能反：
      // 按下时鼠标必须已经在标题栏上，否则抓取的是别的窗口/部位）。
      moveCursor(screenStart.x, screenStart.y);
      sleepSync(60);
      const buttonDown = sendRealMouseButton(true);
      if (options.keepPressed !== true) {
        // 用真实按键而非消息：模态循环读的是系统按键状态。
      }
      sleepSync(60);

      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        const sx = Math.round(screenStart.x + (screenEnd.x - screenStart.x) * t);
        const sy = Math.round(screenStart.y + (screenEnd.y - screenStart.y) * t);
        moveCursor(sx, sy);
        if (stepDelay > 0) sleepSync(stepDelay);
      }
      sleepSync(60);

      const buttonUp = sendRealMouseButton(false);
      // 兜底：若窗口没结束拖动（极少见），补一条消息帮助它提交。
      const packedEnd = packMouseLParam(screenEnd.x, screenEnd.y);
      recordStep(MSG.MOUSEMOVE, base, packedEnd.lp, { phase: 'settle', screen: true });

      // 窗口的最终位置是**异步提交**的（模态循环退出后才落到 WM_WINDOWPOSCHANGED）。
      // 所以要在松开之后轮询一小段时间读回矩形，否则会读到拖动途中的旧值，
      // 误报 moved:false —— 实测就是这样错过了一次成功的拖动。
      const readMoved = () => {
        // 注意 native.js 的签名是 windowRect(loaded, hwnd) —— 必须传 loaded，
        // 只传 hwnd 会得到 undefined（这个坑实测导致 moved 误报 false）。
        const after = windowRect(loaded, probe.hwnd);
        if (after === undefined || probe.rect === undefined) return undefined;
        return { x: after.left - probe.rect.left, y: after.top - probe.rect.top };
      };
      let movedBy = readMoved();
      const settleDeadline = Date.now() + (Number.isFinite(options.settleMs) ? options.settleMs : 1200);
      while (Date.now() < settleDeadline) {
        if (movedBy !== undefined && (Math.abs(movedBy.x) > 2 || Math.abs(movedBy.y) > 2)) break;
        sleepSync(80);
        const next = readMoved();
        if (next !== undefined) movedBy = next;
      }

      let cursorRestored;
      if (options.restoreCursor !== false && cursorBefore !== undefined) {
        sleepSync(60);
        cursorRestored = moveCursor(cursorBefore.x, cursorBefore.y);
      }

      const movedX = movedBy?.x;
      const movedY = movedBy?.y;
      const moved = movedX !== undefined && movedY !== undefined
        && (Math.abs(movedX) > 2 || Math.abs(movedY) > 2);

      return withAliases({
        ok: counter.failed === 0 && (buttonDown || buttonUp),
        hwnd: probe.hwnd,
        mode,
        // window 模式：from 是窗口坐标下的起点，to 是位移量（相对起点）。
        windowFrom: { x: from?.x, y: from?.y },
        windowDelta: { x: to?.x, y: to?.y },
        screenFrom: { x: screenStart.x, y: screenStart.y },
        screenTo: { x: screenEnd.x, y: screenEnd.y },
        steps,
        posted: counter.posted,
        sent: counter.sent,
        failed: counter.failed,
        sequence,
        cursorUntouched: false,
        usesRealCursor: true,
        /** 真实鼠标按键是否成功注入（窗口拖动的必要条件）。 */
        realButtonInjected: { down: buttonDown, up: buttonUp },
        /** 窗口是否真的移动了（客观读回，不是"消息投递成功"）。 */
        moved,
        windowMovedBy: movedX === undefined ? undefined : { x: movedX, y: movedY },
        cursorBefore,
        cursorRestored: cursorRestored === true,
        /**
         * 明确警告：这是会动真实光标的降级路径。
         * 实测依据：窗口拖动是窗口管理器的模态循环，它读系统的**真实按键状态**与
         * 光标位置；纯 PostMessage（含 WM_NCLBUTTONDOWN + HTCAPTION）无效。
         */
        warning: 'window-drag mode moves the REAL cursor AND injects a real mouse button: '
          + 'dragging a window title bar is a modal window-manager loop that reads the physical '
          + 'cursor and real button state, so posted messages alone do nothing (verified by '
          + 'controlled experiment: PostMessage-only failed, real SendInput moved the window exactly '
          + 'as requested). The cursor is restored afterwards unless restoreCursor:false.',
        messages: counter.messages,
        reason: counter.failed > 0 ? explainDeliveryFailure(probe.hwnd, counter) : undefined,
      });
    }

    // ---------------------------------------------------------------------
    // 默认路径：内容拖选，纯消息，真实光标不动。
    // ---------------------------------------------------------------------
    // 此处的 from/to 已在函数开头归一化过（客户区坐标），它们是权威值。
    const start = from;
    const end = to;
    const packedStart = packMouseLParam(start.x, start.y);
    const packedEnd = packMouseLParam(end.x, end.y);

    recordStep(MSG.MOUSEMOVE, base, packedStart.lp, { phase: 'enter', x: start.x, y: start.y });
    // wParam 必须带 MK_LBUTTON，否则控件认为是"移动"而不是"拖选"。
    recordStep(MSG.LBUTTONDOWN, base | MK.LBUTTON, packedStart.lp, { phase: 'down', x: start.x, y: start.y });

    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const mx = Math.round(start.x + (end.x - start.x) * t);
      const my = Math.round(start.y + (end.y - start.y) * t);
      recordStep(MSG.MOUSEMOVE, base | MK.LBUTTON, packMouseLParam(mx, my).lp, { phase: 'move', x: mx, y: my });
      if (stepDelay > 0) sleepSync(stepDelay);
    }

    recordStep(MSG.MOUSEMOVE, base | MK.LBUTTON, packedEnd.lp, { phase: 'final', x: end.x, y: end.y });
    recordStep(MSG.LBUTTONUP, base, packedEnd.lp, { phase: 'up', x: end.x, y: end.y });

    return withAliases({
      ok: counter.failed === 0,
      hwnd: probe.hwnd,
      mode,
      from: { x: start.x, y: start.y },
      to: { x: end.x, y: end.y },
      steps,
      posted: counter.posted,
      sent: counter.sent,
      failed: counter.failed,
      sequence,
      cursorUntouched: true,
      usesRealCursor: false,
      note: 'content drag uses posted messages only (WM_LBUTTONDOWN + MK_LBUTTON WM_MOUSEMOVE + WM_LBUTTONUP); ' +
        'the real cursor does not move',
      messages: counter.messages,
      reason: counter.failed > 0 ? explainDeliveryFailure(probe.hwnd, counter) : undefined,
    });
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error), posted: counter.posted };
  }
}

/**
 * 滚轮。`delta` 单位是 WHEEL_DELTA 的倍数（正=上滚/放大，负=下滚）。
 * `WM_MOUSEWHEEL` 的 lParam 与其它鼠标消息不同：它是**屏幕坐标**，wParam 高字是
 * 有符号的 delta 低字是有符号的按键状态。
 *
 * @param options.horizontal - true 时发 WM_MOUSEHWHEEL
 */
export function scroll(hwnd, delta, options = {}) {
  const counter = createCounter();
  try {
    const loaded = requireBindings();
    const probe = probeWindow(hwnd);
    if (probe.ok !== true) return probe;
    const x = options.x ?? Math.floor((probe.client?.width ?? 0) / 2);
    const y = options.y ?? Math.floor((probe.client?.height ?? 0) / 2);
    const point = normalizePoint(probe.hwnd, x, y, options);
    if (point.ok !== true) return point;

    const screen = clientToScreen(probe.hwnd, point.x, point.y);
    if (screen.ok !== true) return screen;

    const WHEEL_DELTA = options.wheelDelta ?? 120;
    const notches = toInt32(delta);
    const wparamDelta = toInt32(notches * WHEEL_DELTA);
    const real = realModifierState(loaded);
    const message = options.horizontal === true ? MSG.MOUSEHWHEEL : MSG.MOUSEWHEEL;
    const mode = options.foreground === true ? 'send' : (options.deliver === 'send' ? 'send' : 'post');

    // wParam = (delta << 16) | keyState —— 高字是**有符号** delta。
    const wParam = (((wparamDelta & 0xffff) << 16) | (real.mk & 0xffff)) >>> 0;
    const packed = packMouseLParam(screen.x, screen.y); // 注意：屏幕坐标
    const outcome = deliver(loaded, probe.hwnd, message, wParam, packed.lp, mode);
    record(counter, outcome, message, { delta: notches, screen: { x: screen.x, y: screen.y }, kind: 'wheel' });

    return withAliases({
      ok: counter.failed === 0,
      hwnd: probe.hwnd,
      delta: notches,
      wheelDelta: wparamDelta,
      posted: counter.posted,
      sent: counter.sent,
      failed: counter.failed,
      x: point.x,
      y: point.y,
      screen: { x: screen.x, y: screen.y },
      wParam,
      lParam: packed.lp,
      horizontal: options.horizontal === true,
      cursorUntouched: true,
      messages: counter.messages,
      note: 'WM_MOUSEWHEEL carries screen coordinates in lParam (unlike other mouse messages)',
      reason: counter.failed > 0 ? explainDeliveryFailure(probe.hwnd, counter) : undefined,
    });
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error), posted: counter.posted };
  }
}

/**
 * **按行/页滚动** —— `WM_VSCROLL` / `WM_HSCROLL` + `SB.LINEUP/LINEDOWN/PAGEUP/PAGEDOWN`。
 *
 * 为什么需要它：滚轮（`scroll()`）的粒度由**控件自己**决定，实测记事本滚一格
 * 可能跳十几行、甚至一滚到底，无法预测。而 `SB_LINEUP/LINEDOWN` 实测**每次恰好
 * 滚一行**，`PAGEUP/PAGEDOWN` 恰好一页 —— 需要精确滚动时应该用这个而不是滚轮。
 *
 * @param options.direction - 'up'（默认）| 'down' | 'left' | 'right'
 *                            注意左/右会改用 WM_HSCROLL，上/下用 WM_VSCROLL
 * @param options.unit - 'line'（默认）| 'page'
 * @param options.times - 重复次数（默认 1）
 * @param options.target - 'self'（默认，发给 hwnd 自身）| 某个子窗口 hwnd
 */
export function scrollLines(hwnd, options = {}) {
  const counter = createCounter();
  try {
    const loaded = requireBindings();
    const probe = probeWindow(hwnd);
    if (probe.ok !== true) return probe;
    const target = options.target !== undefined ? toHwnd(options.target) : probe.hwnd;

    const direction = String(options.direction ?? 'up').toLowerCase();
    const unit = String(options.unit ?? 'line').toLowerCase();
    const times = Math.max(1, toInt32(options.times ?? 1) || 1);

    const vertical = direction === 'up' || direction === 'down';
    let code;
    if (vertical) {
      if (unit === 'page') code = direction === 'up' ? SB.PAGEUP : SB.PAGEDOWN;
      else code = direction === 'up' ? SB.LINEUP : SB.LINEDOWN;
    } else if (direction === 'left' || direction === 'right') {
      if (unit === 'page') code = direction === 'left' ? SB.PAGEUP : SB.PAGEDOWN;
      else code = direction === 'left' ? SB.LINEUP : SB.LINEDOWN;
    } else {
      return { ok: false, reason: `unknown direction: ${String(options.direction)} (use up|down|left|right)` };
    }

    const message = vertical ? MSG.VSCROLL : MSG.HSCROLL;
    // WM_VSCROLL/WM_HSCROLL 的 lParam 含义：
    //   0        → 消息发给窗口自身，作用于其标准滚动条
    //   子窗口句柄 → 作用于该子控件的滚动条
    const lParam = target === probe.hwnd ? 0 : target;
    const sequence = [];
    for (let i = 0; i < times; i += 1) {
      const outcome = deliver(loaded, target, message, code, lParam, 'post');
      record(counter, outcome, message, { code, direction, unit, kind: 'scrollline' });
      sequence.push({ message: `0x${message.toString(16).padStart(4, '0')}`, code, ok: outcome.sent > 0 });
      if (options.delayMs > 0) sleepSync(options.delayMs);
    }

    return withAliases({
      ok: counter.failed === 0,
      hwnd: probe.hwnd,
      target,
      direction,
      unit,
      times,
      scrollCode: code,
      posted: counter.posted,
      sent: counter.sent,
      failed: counter.failed,
      sequence,
      cursorUntouched: true,
      messages: counter.messages,
      note: 'WM_VSCROLL/WM_HSCROLL with SB_LINEUP/LINEDOWN scroll exactly one line per message ' +
        '(measured), unlike WM_MOUSEWHEEL whose granularity is chosen by the control',
      reason: counter.failed > 0 ? explainDeliveryFailure(target, counter) : undefined,
    });
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error), posted: counter.posted };
  }
}

// ---------------------------------------------------------------------------
// 键盘
// ---------------------------------------------------------------------------

/**
 * 投递一段文字：逐 UTF-16 码元发 `WM_CHAR`（你键入什么，目标就收到什么）。
 *
 * **代理对处理**：emoji 等 BMP 外字符在 UTF-16 里是 2 个码元（高位代理 +
 * 低位代理）。Windows 控件收到的本来就是这两个独立的 WM_CHAR，我们再拼回
 * UTF-16 后就是正确的 emoji。本函数**按码元逐个投递**（不是按码点合并成一条），
 * 这正是真实键盘的行为；`codeUnits` 字段会报告实际投递的码元数。
 *
 * `\r\n` / `\n` 一律投递给目标的 `\r`(0x0D)，因为编辑控件把 0x0D 当作换行。
 * `\t` 直接投 0x09（WM_CHAR 的 Tab 在多数控件里就是插入制表符/切焦点）。
 *
 * @param options.deliver - 'post'（默认）| 'send'
 * @param options.foreground - **会抢焦点**，配合 send 使用
 * @param options.perCharDelayMs - 每字符之间的等待（默认 0）
 * @param options.normalizeNewlines - 默认 true，把 \r\n 折成单 \r
 */
export function writeText(hwnd, text, options = {}) {
  const counter = createCounter();
  try {
    const loaded = requireBindings();
    const probe = probeWindow(hwnd);
    if (probe.ok !== true) return probe;
    if (typeof text !== 'string') {
      return { ok: false, reason: `text must be a string, got ${typeof text}` };
    }

    const normalize = options.normalizeNewlines !== false;
    const payload = normalize ? text.replace(/\r\n/g, '\r') : text;
    const foreground = options.foreground === true;
    let mode = options.deliver === 'send' ? 'send' : 'post';
    let focus;
    if (foreground) {
      focus = ensureTargetReady(probe.hwnd, { allowFocusSteal: true });
      mode = 'send';
    }

    const delay = options.perCharDelayMs ?? 0;
    let codeUnits = 0;
    let replaced = 0;
    for (let i = 0; i < payload.length; i += 1) {
      let unit = payload.charCodeAt(i);
      if (unit === 0x0a) {
        unit = 0x0d;
        replaced += 1;
      }
      const outcome = deliver(loaded, probe.hwnd, MSG.CHAR, unit, 1, mode);
      record(counter, outcome, MSG.CHAR, { char: unit, kind: 'char' });
      codeUnits += 1;
      if (delay > 0) sleepSync(delay);
    }

    return withAliases({
      ok: counter.failed === 0 && payload.length > 0,
      hwnd: probe.hwnd,
      length: text.length,
      codeUnits,
      replacedNewlines: replaced,
      posted: counter.posted,
      sent: counter.sent,
      failed: counter.failed,
      deliver: mode,
      cursorUntouched: true,
      stoleFocus: focus !== undefined ? focus.stoleFocus : false,
      focusWarning: focus?.focusWarning,
      messages: counter.messages,
      reason: payload.length === 0
        ? 'empty text: nothing posted'
        : (counter.failed > 0 ? explainDeliveryFailure(probe.hwnd, counter) : undefined),
    });
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error), posted: counter.posted };
  }
}

/**
 * 判断某个虚拟键码是否属于"依赖消息循环 TranslateMessage、纯 PostMessage 下
 * 不可靠"的一类。
 *
 * `WM_CHAR` 能表达的**可打印字符**（字母/数字/符号）本身可靠 —— 但那是走
 * `writeText()` 的 WM_CHAR 路径。**作为按键**发 WM_KEYDOWN 时，只有
 * "目标只关心按键本身"的场景才可靠。
 *
 * 实测可靠：无（`WM_KEYDOWN` 单发在 notepad 上对 Delete/Home/End/方向键全部无效）。
 * 实测不可靠：所有"编辑语义/导航/快捷键"类按键。
 */
function classifyKeyReliability(vk, modifiers) {
  const CODES = {
    0x08: 'Backspace', 0x09: 'Tab', 0x0d: 'Enter', 0x1b: 'Escape', 0x20: 'Space',
    0x21: 'PageUp', 0x22: 'PageDown', 0x23: 'End', 0x24: 'Home',
    0x25: 'Left', 0x26: 'Up', 0x27: 'Right', 0x28: 'Down',
    0x2d: 'Insert', 0x2e: 'Delete', 0x2c: 'PrintScreen',
  };
  const name = CODES[vk];
  const isFunctionKey = vk >= 0x70 && vk <= 0x87;
  const hasModifier = modifiers.length > 0;

  // 编辑/导航语义键 —— 实测在纯 PostMessage 下无效（选区不变、内容不变）。
  const editingSemantics = name !== undefined
    && ['Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
      'Left', 'Right', 'Up', 'Down', 'Insert'].includes(name);

  if (editingSemantics) {
    return {
      reliability: 'low',
      degraded: true,
      why: `WM_KEYDOWN for ${name} is posted directly into the target's message queue, bypassing ` +
        'the receiving thread\'s TranslateMessage. Measured on real notepad: the message is accepted ' +
        '(PostMessageW returns true) but nothing happens — the selection never moves and no text changes.',
      measuredEvidence: 'notepad: Delete/Home/End/arrows posted successfully yet text and EM_GETSEL were unchanged',
      recommended: 'use the EM_* edit-control API instead (selectAll / replaceSelection / clearSelection / edit)',
    };
  }

  if (hasModifier) {
    return {
      reliability: 'low',
      degraded: true,
      why: 'Shortcut combinations sent as posted WM_KEYDOWN rely on real keyboard state and on the ' +
        'target\'s TranslateMessage/accelerator handling, neither of which PostMessage provides. ' +
        'Measured on real notepad: Ctrl+A inserted a literal "a" and did NOT select anything.',
      measuredEvidence: 'notepad: keyCombo(ctrl+a) left EM_GETSEL at {10,10} and appended the character "a"',
      recommended: 'for edit controls use selectAll()/replaceSelection() (EM_SETSEL/EM_REPLACESEL), which are reliable',
    };
  }

  if (isFunctionKey) {
    return {
      reliability: 'medium',
      degraded: false,
      why: 'Function keys are usually handled directly by the target window procedure, so they post more ' +
        'reliably than editing keys. This is not true for menu accelerators or apps that filter on focus.',
      recommended: 'verify the effect where possible',
    };
  }

  if (name === 'Escape') {
    return {
      reliability: 'medium',
      degraded: false,
      why: 'Escape is typically handled by the window procedure (dialogs, popups) but may be ignored by ' +
        'the focused control in some apps.',
      recommended: 'verify the effect where possible',
    };
  }

  return {
    reliability: 'low',
    degraded: true,
    why: 'Generic posted WM_KEYDOWN/WM_KEYUP does not go through TranslateMessage and does not update real ' +
      'keyboard state, so many applications will not interpret it as a real key press.',
    recommended: 'prefer writeText() for characters and the EM_* API for edit controls',
  };
}

/**
 * 按下+抬起一个键（或一个组合）。
 *
 * 组合顺序（这是要求的语义）：
 *   修饰键按下 → 主键按下 → 主键抬起 → 修饰键抬起（逆序释放）
 * 有 Alt 时自动走 `WM_SYSKEYDOWN/UP`（Windows 菜单加速键依赖它），lParam 的
 * bit29（context code）同时置位。
 *
 * `GetKeyState` 一致性：见 `modifierStateNote` —— PostMessage **不**改真实键盘
 * 状态表，所以目标内部 GetKeyState 看到的仍是用户的物理键盘。结果里
 * `modifierStateNote` 会把这点明确写给调用方。
 *
 * **可靠性**：返回值的 `ok` 只表示消息投递成功。非字符键/快捷键请读
 * `reliability` / `degraded` / `note` —— 见 `classifyKeyReliability`。
 *
 * @param key - "ctrl+a" | "enter" | "f5" | "alt+tab" | ['ctrl','shift','s'] | 虚拟键码数字
 * @param options.times - 重复次数（默认 1）
 * @param options.deliver - 'post'（默认）| 'send'
 * @param options.foreground - **会抢焦点**，配合 send 使用
 */
export function pressKey(hwnd, key, options = {}) {
  const counter = createCounter();
  try {
    const loaded = requireBindings();
    const probe = probeWindow(hwnd);
    if (probe.ok !== true) return probe;

    const spec = parseKeySpec(key);
    if (spec.ok !== true) return spec;

    const times = Math.max(1, toInt32(options.times ?? 1) || 1);
    const holdMs = options.holdMs ?? 0;
    const foreground = options.foreground === true;
    let mode = options.deliver === 'send' ? 'send' : 'post';
    let focus;
    if (foreground) {
      focus = ensureTargetReady(probe.hwnd, { allowFocusSteal: true });
      mode = 'send';
    }

    const sequence = [];
    const alt = hasAlt(spec.modifiers);

    // ---------------------------------------------------------------------
    // 可靠性评估：`ok:true` 只表示"消息投递成功了"，**不等于目标真的执行了动作**。
    // 见本文件顶部关于 TranslateMessage 的说明。这里把真相显式暴露给调用方，
    // 避免模型看到一个 ok:true 就以为操作生效。
    // ---------------------------------------------------------------------
    const reliability = classifyKeyReliability(spec.keys[0], spec.modifiers);
    const chain = spec.keys.map((vk) => classifyKeyReliability(vk, spec.modifiers));
    const worst = chain.some((item) => item.reliability === 'low')
      ? 'low'
      : (chain.some((item) => item.reliability === 'medium') ? 'medium' : 'high');
    const reliabilitySummary = { ...reliability, reliability: worst };

    const emit = (message, vk, keyUp, altDown) => {
      const lp = buildKeyLParam(vk, { keyUp, altDown });
      const outcome = deliver(loaded, probe.hwnd, message, vk, lp, mode);
      record(counter, outcome, message, { vk, keyUp, extended: EXTENDED_VKS.has(vk), kind: 'key' });
      sequence.push({ message: `0x${message.toString(16).padStart(4, '0')}`, vk, keyUp, lParam: lp, ok: outcome.sent > 0 });
    };

    const downMsg = (alt ? MSG.SYSKEYDOWN : MSG.KEYDOWN);
    const upMsg = (alt ? MSG.SYSKEYUP : MSG.KEYUP);

    for (let round = 0; round < times; round += 1) {
      // 1) 修饰键按下（正序：Ctrl→Shift→Alt）
      for (const vk of spec.modifiers) {
        const isAlt = SYS_MODIFIER_VKS.has(vk);
        emit(isAlt ? MSG.SYSKEYDOWN : MSG.KEYDOWN, vk, false, alt);
      }
      // 2) 主键按下 → 抬起
      for (const vk of spec.keys) {
        emit(downMsg, vk, false, alt);
        if (holdMs > 0) sleepSync(holdMs);
        emit(upMsg, vk, true, alt);
      }
      // 3) 修饰键抬起（逆序）
      for (const vk of [...spec.modifiers].reverse()) {
        const isAlt = SYS_MODIFIER_VKS.has(vk);
        emit(isAlt ? MSG.SYSKEYUP : MSG.KEYUP, vk, true, alt);
      }
    }

    return withAliases({
      ok: counter.failed === 0,
      // 语义澄清：ok 只代表"消息投递成功"，不代表目标真的响应了。
      // 请读 reliability / degraded / note 判断这次按键是否**可能真的生效**。
      delivered: counter.failed === 0,
      effectVerified: false,
      reliability: reliabilitySummary.reliability,
      degraded: reliabilitySummary.degraded === true,
      note: reliabilitySummary.why,
      recommendedAlternative: reliabilitySummary.recommended,
      measuredEvidence: reliabilitySummary.measuredEvidence,
      hwnd: probe.hwnd,
      key: typeof key === 'string' ? key : undefined,
      modifiers: spec.modifiers,
      virtualKeys: spec.keys,
      times,
      posted: counter.posted,
      sent: counter.sent,
      failed: counter.failed,
      deliver: mode,
      usesSysKeys: alt,
      sequence,
      cursorUntouched: true,
      stoleFocus: focus !== undefined ? focus.stoleFocus : false,
      focusWarning: focus?.focusWarning,
      modifierStateNote: modifierStateNote(spec.modifiers),
      messages: counter.messages,
      reason: counter.failed > 0
        ? explainDeliveryFailure(probe.hwnd, counter)
        : (reliabilitySummary.degraded === true
          ? `messages were delivered but this key path is unreliable with PostMessage: ${reliabilitySummary.why}`
          : undefined),
    });
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error), posted: counter.posted };
  }
}

/**
 * 修饰键组合的显式 API（语义上等同 pressKey，但入参是"修饰键数组 + 主键"）。
 *
 * @param keys - 主键，字符串或数组（按顺序各按一次，例如 alt+tab 的 ['tab','tab']）
 * @param modifiers - ['ctrl'] | ['ctrl','shift'] | 'ctrl+a' 形式也行
 */
export function keyCombo(hwnd, keys, modifiers = [], options = {}) {
  try {
    const modList = Array.isArray(modifiers)
      ? modifiers
      : (typeof modifiers === 'string' && modifiers.trim() !== ''
        ? modifiers.split('+').map((item) => item.trim()).filter((item) => item !== '')
        : []);
    const keyList = Array.isArray(keys) ? keys : [keys];
    if (keyList.length === 0) return { ok: false, reason: 'keyCombo requires at least one main key' };

    const spec = [...modList, ...keyList];
    const result = pressKey(hwnd, spec, options);
    if (result.ok !== true && result.reason !== undefined && result.posted === undefined) return result;

    // 组合键的可靠性取决于"主键 + 是否带修饰键"。
    const parsed = parseKeySpec(spec);
    const mainVk = parsed.ok === true ? parsed.keys[0] : 0;
    const reliability = classifyKeyReliability(mainVk, parsed.ok === true ? parsed.modifiers : []);

    // 给编辑控件的显式指引：快捷键在纯 PostMessage 下不可靠，EM_* 才可靠。
    let editHint;
    const editInfo = isEditControl(hwnd);
    if (editInfo.ok === true && editInfo.supportsEditMessages === true) {
      const lower = spec.map((item) => String(item).toLowerCase());
      if (lower.includes('ctrl') && lower.includes('a')) {
        editHint = 'on this edit control prefer selectAll(hwnd) (EM_SETSEL) — it is verified reliable, unlike Ctrl+A';
      } else if (lower.includes('ctrl') && (lower.includes('x') || lower.includes('v') || lower.includes('c'))) {
        editHint = 'on this edit control prefer replaceSelection(hwnd, text) / edit(hwnd,"read") — EM_* is verified reliable';
      }
    }

    return {
      ...result,
      modifiersResolved: result.modifiers,
      mainKeysResolved: result.virtualKeys,
      spec: spec.join('+'),
      reliability: reliability.reliability,
      degraded: reliability.degraded === true,
      note: reliability.why,
      recommendedAlternative: editHint ?? reliability.recommended,
      measuredEvidence: reliability.measuredEvidence,
      editControlDetected: editInfo.ok === true ? editInfo.supportsEditMessages === true : undefined,
    };
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error) };
  }
}

/**
 * 直接按键名数组解析（不投递），供调用方预检。
 */
export function explainKey(key) {
  try {
    const spec = parseKeySpec(key);
    if (spec.ok !== true) return spec;
    return {
      ok: true,
      input: typeof key === 'string' ? key : undefined,
      modifiers: spec.modifiers,
      virtualKeys: spec.keys,
      scanCodes: spec.keys.map((vk) => scanCodeForVk(vk)),
      extended: spec.keys.map((vk) => EXTENDED_VKS.has(vk)),
      usesSysKeys: hasAlt(spec.modifiers),
      modifierStateNote: modifierStateNote(spec.modifiers),
    };
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error) };
  }
}

// ---------------------------------------------------------------------------
// 回读 / 断言辅助（主要给测试与审计用）
// ---------------------------------------------------------------------------

/**
 * 用消息回读控件文本。
 *
 * **跨进程 `WM_GETTEXT` 读不到，这不是 bug 而是 Windows 的地址空间语义**：
 * `WM_GETTEXT` 的 lParam 是**指向接收缓冲区的指针**，缓冲区在**我们**的地址空间
 * 里，而消息由**目标进程**处理 —— 目标写入自己地址空间里的同一个数值地址，
 * 不会回写到我们的缓冲区。koffi 层也会直接拒绝传 Buffer
 * （`Unexpected Uint8Array value, expected number`）。
 *
 * 因此本函数只走**真正跨进程可用**的路线：`EM_GETLINE`（EDIT/RichEdit 支持，
 * 内部由 Windows 特殊搬运）。对非编辑控件**诚实地返回失败**，绝不假成功。
 *
 * 也**绝不用窗口标题当替代品**：标题只反映首行内容，且目标程序通常会给它加
 * `*`（未保存标记）—— 实测 notepad 写入成功后标题是 `"*无标题 - 记事本"`，
 * 看起来像失败其实写入是成功的。用弱信号替代真断言比直接失败更危险。
 *
 * @returns `{ ok, text, method, reason }`
 */
export function readTextViaMessages(hwnd, options = {}) {
  try {
    const loaded = requireBindings();
    const maxChars = toInt32(options.maxChars ?? 8192) || 8192;
    const target = toHwnd(hwnd);
    if (loaded.IsWindow(target) !== true) {
      return { ok: false, reason: `hwnd ${target} is not a window` };
    }

    const attempts = [];
    const ownPid = process.pid;
    const targetPid = windowPid(loaded, target);
    const sameProcess = targetPid === ownPid;

    // 路线 1：同进程 GetWindowTextW（缓冲区直接就在正确的地址空间里）。
    if (sameProcess && loaded.GetWindowTextW !== undefined) {
      const title = titleOf(loaded, target);
      attempts.push('own-process GetWindowTextW');
      if (title !== '') return { ok: true, text: title, method: 'GetWindowTextW(own-process)', attempts };
    }

    // 路线 2：EM_GETLINE —— 对 EDIT/RichEdit 跨进程可用（唯一可靠的跨进程路线）。
    const lineCountRaw = Number(loaded.SendMessageW(target, EM.GETLINECOUNT, 0, 0));
    const textLengthRaw = Number(loaded.SendMessageW(target, MSG.GETTEXTLENGTH, 0, 0));
    attempts.push(`EM_GETLINECOUNT=${lineCountRaw}`, `WM_GETTEXTLENGTH=${textLengthRaw}`);

    if (Number.isFinite(lineCountRaw) && lineCountRaw > 0 && lineCountRaw < 100000) {
      const lines = [];
      let total = 0;
      for (let index = 0; index < lineCountRaw && index < 20000; index += 1) {
        const line = readEditLine(loaded, target, index, EM.GETLINE, Math.min(maxChars, 8192));
        if (line === undefined) { lines.length = 0; break; }
        lines.push(line);
        total += line.length;
        if (total > maxChars) break;
      }
      if (lines.length > 0) {
        const text = lines.join('\r\n');
        return {
          ok: true,
          text,
          method: 'EM_GETLINE',
          lineCount: lineCountRaw,
          reportedLength: Number.isFinite(textLengthRaw) ? textLengthRaw : undefined,
          lengthConsistent: Number.isFinite(textLengthRaw) ? (textLengthRaw === text.length) : undefined,
          attempts,
        };
      }
    }

    // 路线 3：同进程 WM_GETTEXT（缓冲区直接就是目标进程的地址空间）。
    if (sameProcess) {
      const buffer = Buffer.alloc(maxChars * 2);
      const copied = Number(loaded.SendMessageW(target, MSG.GETTEXT, maxChars, buffer));
      attempts.push(`same-process WM_GETTEXT -> ${copied}`);
      if (Number.isFinite(copied) && copied > 0) {
        return { ok: true, text: buffer.toString('utf16le', 0, copied * 2), method: 'WM_GETTEXT(same-process)', attempts };
      }
    }

    return {
      ok: false,
      reason:
        'cannot read text from another process through messages: WM_GETTEXT needs a pointer into ' +
        'the TARGET process address space (koffi rejects passing our Buffer, and the target could not ' +
        'write back to it anyway), and EM_GETLINE is only implemented by EDIT/RichEdit controls. ' +
        'Use the UIAutomation route (uia.js) or read the value from inside the target process. ' +
        'Note: a window title is NOT a substitute (it reflects only the first line and adds an unsaved marker).',
      attempts,
      verifiedHint: 'window-title round-trip is unreliable: notepad showed "*无标题 - 记事本" right after a successful write',
    };
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error) };
  }
}

/**
 * 跨进程读 EDIT/RichEdit 的第 N 行。
 *
 * EM_GETLINE 是**少数跨进程可用的编辑控件消息**：调用方把"本行最多接收多少字符"
 * 写进缓冲区的头两个字节（一个 WORD 容量），控件把该行字符回送进同一块缓冲区。
 *
 * 回送布局（**本机实测**，notepad 的 Edit 控件）：
 *   - 行文本从**字节偏移 0** 开始，容量 WORD 被覆盖；
 *   - 返回值 = 实际写入的字符数 N（不含 NUL）；
 *   - 位置 `N*2` 处是结尾 NUL，但**其后两个字节保留着调用方原先写的容量高字节**
 *     （实测写入 "ABCDE" 后 buffer 为 `41 00 42 00 43 00 44 00 45 00 6f 37`），
 *     所以**必须按返回的 N 截断**，不能靠扫描 NUL 来定长度。
 *
 * 两个曾经的错误实现（均已修正，记录在此避免回归）：
 *   1. 从**偏移 2** 读 → 丢掉首字符（"ABCDE" 读成 "BCDE"）；
 *   2. 用"缓冲区首字声明的计数 − 1"当字符数 → 首字已被文本覆盖（这里是 0x0041
 *      = 'A'），若 <255 就会算出 64（"A"−1）之类的垃圾长度。
 *
 * koffi 的 `intptr_t` 不接受 Buffer，所以先用 `koffi.address()` 取裸地址再当整数传。
 *
 * @returns 行文本；不成功返回 undefined。
 */
function readEditLine(loaded, hwnd, index, emGetLine, maxChars) {
  try {
    const koffiAddress = typeof loaded.koffi?.address === 'function' ? loaded.koffi.address : undefined;
    if (koffiAddress === undefined) return undefined;
    const capacity = Math.min(maxChars, 8192);
    const buffer = Buffer.alloc((capacity + 1) * 2);
    buffer.writeUInt16LE(capacity, 0);
    const address = Number(koffiAddress(buffer));
    if (!Number.isFinite(address) || address === 0) return undefined;
    const copied = Number(loaded.SendMessageW(hwnd, emGetLine, index, address));
    if (!Number.isFinite(copied) || copied <= 0) return undefined;
    const chars = Math.min(copied, capacity);
    return buffer.toString('utf16le', 0, chars * 2);
  } catch {
    return undefined;
  }
}

/**
 * 枚举目标窗口的直接子控件（用于找到 EDIT 控件做回读）。
 * @returns `{ ok, children:[{hwnd,className,pid,title,rect}] }`
 */
export function childWindows(hwnd) {
  try {
    requireBindings();
    const children = [];
    enumWindows((child) => {
      const probe = probeWindow(child);
      if (probe.ok === true) {
        children.push({
          hwnd: child,
          className: probe.className,
          pid: probe.pid,
          title: probe.title,
          rect: probe.rect,
          client: probe.client,
          visible: probe.visible,
        });
      }
      return true;
    }, { childrenOf: toHwnd(hwnd) });
    return { ok: true, children };
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error) };
  }
}

/**
 * 递归枚举全部后代控件（含嵌套层级），用于找深层 EDIT 控件。
 * @returns `{ ok, descendants:[{hwnd,className,depth}] }`
 */
export function descendantWindows(hwnd, options = {}) {
  try {
    requireBindings();
    const maxDepth = toInt32(options.maxDepth ?? 8) || 8;
    const descendants = [];
    const walk = (parent, depth) => {
      if (depth > maxDepth) return;
      const level = childWindows(parent);
      if (level.ok !== true) return;
      for (const child of level.children) {
        descendants.push({ hwnd: child.hwnd, className: child.className, pid: child.pid, title: child.title, depth });
        walk(child.hwnd, depth + 1);
      }
    };
    walk(toHwnd(hwnd), 1);
    return { ok: true, descendants, count: descendants.length };
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error) };
  }
}

/** 读真实光标位置（只读，绝不修改）。 */
export function cursorPosition() {
  try {
    const loaded = requireBindings();
    const buffer = Buffer.alloc(8);
    if (loaded.GetCursorPos(buffer) !== true) {
      return { ok: false, reason: 'GetCursorPos failed' };
    }
    return { ok: true, x: buffer.readInt32LE(0), y: buffer.readInt32LE(4) };
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error) };
  }
}

/**
 * 自检：本模块是否可用、绑到哪、关键函数是否齐。
 * 宿主/诊断面板可以直接调这个。
 *
 * `missingBindings` 来自 native.js 自己的 `failures` 数组（每个函数独立 try/catch），
 * 再与"本模块必需的函数"求交集，便于判断虚拟输入层能否工作。
 */
export function describeVirtualInput() {
  try {
    const native = describeNative();
    const loaded = loadWin32();
    if (loaded.reason !== undefined) {
      return { ok: false, reason: loaded.reason, native };
    }

    const required = [
      'PostMessageW', 'SendMessageW', 'GetCursorPos', 'MapVirtualKeyW',
      'GetKeyState', 'GetAsyncKeyState', 'ClientToScreen', 'ScreenToClient',
      'IsWindow', 'IsWindowVisible', 'IsWindowEnabled', 'IsIconic',
      'IsHungAppWindow', 'GetForegroundWindow', 'GetWindowThreadProcessId',
      'SetForegroundWindow', 'ShowWindow', 'SetWindowPos', 'AttachThreadInput',
      'GetClassNameW', 'GetWindowTextW', 'GetCurrentThreadId',
    ];
    const missingBindings = required.filter((name) => loaded[name] === undefined);
    const optional = [
      'OpenProcess', 'QueryFullProcessImageNameW', 'CloseHandle', // 仅用于审计展示
      'GetWindowTextLengthW', 'GetFocus', 'GetWindowLongPtrW', 'UpdateWindow', 'InvalidateRect',
      'GetSystemMetrics', 'BringWindowToTop', 'ToUnicodeEx', 'GetKeyboardLayout',
      'SetCursorPos', // 仅 drag({mode:'window'}) 的降级路径需要
    ];
    const missingOptional = optional.filter((name) => loaded[name] === undefined);

    return {
      ok: missingBindings.length === 0,
      ready: missingBindings.length === 0,
      native,
      koffi: loaded.from,
      nativeBindingFailures: loaded.failures ?? [],
      missingBindings,
      missingOptionalBindings: missingOptional,
      api: Object.keys(PUBLIC_API),
      capabilities: {
        mouseMessages: true,
        keyboardMessages: true,
        unicodeText: true,
        surrogatePairs: true,
        cursorIsNotMoved: true,
        contentDrag: true,
        windowDrag: loaded.SetCursorPos !== undefined,
        scrollByLine: true,
        editControlMessages: true,
      },
      limits: {
        uwp: 'UWP/XAML windows ignore injected WM_* input',
        elevated: 'UIPI blocks PostMessageW into higher-integrity processes (PostMessageW returns false)',
        chromiumContent: 'Chromium/Electron content surfaces may ignore WM_MOUSE*/WM_CHAR',
        directInput: 'DirectInput / fullscreen games / RDP clients poll *AsyncKeyState and ignore messages',
        terminals: 'Windows Terminal / conhost route input through ConPTY',
        realKeyState: 'PostMessageW does not change the real keyboard state table (GetKeyState stays physical)',
        translateMessage:
          'PostMessage bypasses the receiving thread\'s TranslateMessage. WM_CHAR and WM_MOUSE* are handled ' +
          'directly by the window procedure and are reliable; non-character WM_KEYDOWN semantics ' +
          '(Delete/Home/End/arrows/Backspace and shortcut combos) are NOT. Measured on real notepad: ' +
          'Delete/Home/End/arrows did nothing and Ctrl+A inserted a literal "a" instead of selecting. ' +
          'For edit controls use the EM_* API (selectAll/replaceSelection/clearSelection/edit) instead.',
        windowDrag:
          'dragging a window by its title bar is a modal window-manager loop that follows the physical ' +
          'cursor; posted messages alone do NOT move the window (measured). drag({mode:"window"}) therefore ' +
          'moves the real cursor and is the only path in this module that does so.',
        crossProcessReadback:
          'WM_GETTEXT cannot read across processes (its lParam must point into the target address space); ' +
          'only EM_GETLINE works, and only for EDIT/RichEdit. General readback needs UIAutomation.',
        processImage: 'process image name is unavailable when native.js omits OpenProcess/QueryFullProcessImageNameW',
      },
      reason: missingBindings.length > 0
        ? `native.js is missing required bindings: ${missingBindings.join(', ')}`
        : undefined,
    };
  } catch (error) {
    return { ok: false, reason: error?.dshReason ?? error?.message ?? String(error) };
  }
}

/** 公开 API 清单（供诊断与文档）。 */
export const PUBLIC_API = {
  // 查询
  probeWindow, describeSensitivity, describeVirtualInput, childWindows, descendantWindows, isEditControl,
  // 前置准备
  ensureTargetReady,
  // 坐标
  clientToScreen, screenToClient, normalizePoint, packMouseLParam, unpackMouseLParam,
  // 鼠标
  click, move, scroll, drag, scrollLines,
  // 键盘
  writeText, pressKey, keyCombo, explainKey, resolveKey, parseKeySpec, buildKeyLParam, scanCodeForVk,
  // 编辑控件可靠路径（EM_*）
  edit, selectAll, replaceSelection, clearSelection, getSelection,
  // 回读
  readTextViaMessages, cursorPosition,
};

export default PUBLIC_API;
