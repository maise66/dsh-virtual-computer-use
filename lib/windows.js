/**
 * 窗口发现与管理层。
 *
 * 职责：把"要操作哪个窗口"这件事变成一个稳定、可解释的句柄。
 *
 * 为什么优先用 hwnd 而不是标题：标题会随文档名、状态变化（"无标题 - 记事本" →
 * "a.txt - 记事本"），标题匹配只适合作为**发现**入口，一旦拿到 hwnd 就应该
 * 钉住它。所有操作 API 因此都接受 hwnd，并会在每次使用前 IsWindow 校验。
 */

import { enumWindows, loadWin32, readWide, windowPid, windowRect } from './native.js';

/** 读取窗口标题。 */
function titleOf(loaded, hwnd) {
  return readWide(loaded.GetWindowTextW, hwnd, 512);
}

/** 读取窗口类名。 */
function classOf(loaded, hwnd) {
  return readWide(loaded.GetClassNameW, hwnd, 256);
}

/**
 * 列出桌面上的顶层窗口。
 *
 * @param options.visibleOnly - 只返回可见窗口（默认 true）。
 * @param options.withTitleOnly - 只返回有标题的窗口（默认 false）。
 */
export function listWindows(options = {}) {
  const loaded = loadWin32();
  if (loaded.reason !== undefined) return { ok: false, reason: loaded.reason, windows: [] };

  const { visibleOnly = true, withTitleOnly = false } = options;
  const windows = [];
  enumWindows((hwnd) => {
    if (!Number.isInteger(hwnd) || hwnd === 0) return true;
    const visible = loaded.IsWindowVisible(hwnd) === true;
    if (visibleOnly && !visible) return true;
    const title = titleOf(loaded, hwnd);
    if (withTitleOnly && title === '') return true;
    const rect = windowRect(loaded, hwnd);
    windows.push({
      hwnd,
      title,
      className: classOf(loaded, hwnd),
      pid: windowPid(loaded, hwnd),
      visible,
      minimized: loaded.IsIconic(hwnd) === true,
      enabled: loaded.IsWindowEnabled(hwnd) === true,
      hung: loaded.IsHungAppWindow(hwnd) === true,
      rect: rect === undefined ? undefined : { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      area: rect === undefined ? 0 : rect.width * rect.height,
    });
    return true;
  });

  // 面积降序：通常最相关的大窗口排在前面。
  windows.sort((a, b) => b.area - a.area);
  return { ok: true, count: windows.length, windows };
}

/**
 * 按条件定位单个窗口。
 *
 * 支持同时用 title / className / pid / hwnd 过滤，全部条件取交集。
 * 命中多个时返回面积最大的那个（最可能是用户正在看的主窗口），
 * 并把其它候选一并返回，便于模型在选错时改选。
 *
 * @param query.title - 标题子串匹配（大小写不敏感）。
 * @param query.className - 类名精确匹配。
 * @param query.pid - 进程 id。
 * @param query.hwnd - 直接指定句柄（仍会校验有效性）。
 */
export function findWindow(query = {}) {
  const loaded = loadWin32();
  if (loaded.reason !== undefined) return { ok: false, reason: loaded.reason };

  // 直接给 hwnd：只校验，不做搜索。
  if (query.hwnd !== undefined && query.hwnd !== null) {
    const hwnd = Number(query.hwnd);
    if (!Number.isInteger(hwnd) || hwnd === 0) {
      return { ok: false, reason: `invalid hwnd: ${String(query.hwnd)}` };
    }
    if (loaded.IsWindow(hwnd) !== true) {
      return { ok: false, reason: `hwnd ${hwnd} is no longer a valid window (the app may have closed)` };
    }
    const rect = windowRect(loaded, hwnd);
    return {
      ok: true,
      window: {
        hwnd,
        title: titleOf(loaded, hwnd),
        className: classOf(loaded, hwnd),
        pid: windowPid(loaded, hwnd),
        visible: loaded.IsWindowVisible(hwnd) === true,
        minimized: loaded.IsIconic(hwnd) === true,
        rect: rect === undefined ? undefined : { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      },
    };
  }

  const listing = listWindows({ visibleOnly: query.includeHidden !== true });
  if (listing.ok !== true) return { ok: false, reason: listing.reason };

  const wantTitle = typeof query.title === 'string' && query.title !== '' ? query.title.toLowerCase() : undefined;
  const wantClass = typeof query.className === 'string' && query.className !== '' ? query.className : undefined;
  const wantPid = Number.isInteger(query.pid) ? query.pid : undefined;

  if (wantTitle === undefined && wantClass === undefined && wantPid === undefined) {
    return { ok: false, reason: 'no query given: supply at least one of title, className, pid, or hwnd' };
  }

  const matches = listing.windows.filter((w) => {
    if (wantTitle !== undefined && !w.title.toLowerCase().includes(wantTitle)) return false;
    if (wantClass !== undefined && w.className !== wantClass) return false;
    if (wantPid !== undefined && w.pid !== wantPid) return false;
    return true;
  });

  if (matches.length === 0) {
    return { ok: false, reason: 'no window matched the query', query: { title: query.title, className: query.className, pid: query.pid } };
  }

  const [best, ...others] = matches;
  return {
    ok: true,
    window: best,
    matchCount: matches.length,
    otherMatches: others.slice(0, 10).map((w) => ({ hwnd: w.hwnd, title: w.title, className: w.className, pid: w.pid })),
  };
}

/**
 * 取当前前台窗口。用于判断用户注意力在哪、以及"操作前后台是否被抢占"。
 */
export function foregroundWindow() {
  const loaded = loadWin32();
  if (loaded.reason !== undefined) return { ok: false, reason: loaded.reason };
  const hwnd = Number(loaded.GetForegroundWindow());
  if (hwnd === 0) return { ok: true, window: null, note: 'the desktop itself is foreground' };
  const rect = windowRect(loaded, hwnd);
  return {
    ok: true,
    window: {
      hwnd,
      title: titleOf(loaded, hwnd),
      className: classOf(loaded, hwnd),
      pid: windowPid(loaded, hwnd),
      rect: rect === undefined ? undefined : { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    },
  };
}

/**
 * 取窗口客户区的屏幕坐标矩形 + 客户区尺寸，供坐标换算使用。
 */
export function describeClientArea(hwnd) {
  const loaded = loadWin32();
  if (loaded.reason !== undefined) return { ok: false, reason: loaded.reason };
  const target = Number(hwnd);
  if (loaded.IsWindow(target) !== true) return { ok: false, reason: `hwnd ${target} is not a valid window` };

  const client = Buffer.alloc(16);
  if (loaded.GetClientRect(target, client) !== true) {
    return { ok: false, reason: 'GetClientRect failed' };
  }
  const point = Buffer.alloc(8);
  point.writeInt32LE(0, 0);
  point.writeInt32LE(0, 4);
  if (loaded.ClientToScreen(target, point) !== true) {
    return { ok: false, reason: 'ClientToScreen failed' };
  }
  return {
    ok: true,
    hwnd: target,
    clientOrigin: { x: point.readInt32LE(0), y: point.readInt32LE(4) },
    clientSize: {
      width: Math.max(0, client.readInt32LE(8) - client.readInt32LE(0)),
      height: Math.max(0, client.readInt32LE(12) - client.readInt32LE(4)),
    },
    windowRect: windowRect(loaded, target),
  };
}

/**
 * 读取窗口所属进程的可执行文件全路径。
 *
 * 用途：判断目标窗口是不是终端类程序（ConPTY/Windows Terminal 对窗口消息注入
 * 不可靠），从而提前给模型提示。读取失败返回 `{ ok:false, reason }` ——
 * 这在受保护进程上是正常情况（OpenProcess 会被拒绝），不是错误。
 */
export function processImagePath(pid) {
  const loaded = loadWin32();
  if (loaded.reason !== undefined) return { ok: false, reason: loaded.reason };
  const processId = Number(pid);
  if (!Number.isInteger(processId) || processId <= 0) {
    return { ok: false, reason: `invalid pid: ${String(pid)}` };
  }
  if (loaded.OpenProcess === undefined || loaded.QueryFullProcessImageNameW === undefined || loaded.CloseHandle === undefined) {
    return { ok: false, reason: 'process-query bindings are unavailable' };
  }

  // PROCESS_QUERY_LIMITED_INFORMATION = 0x1000：权限需求最低，够读映像路径。
  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  let handle;
  try {
    handle = loaded.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
    if (!handle || Number(handle) === 0) {
      return { ok: false, reason: `OpenProcess was refused for pid ${processId} (protected or elevated process)` };
    }
    const buffer = Buffer.alloc(1024 * 2);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(1024, 0);
    if (loaded.QueryFullProcessImageNameW(handle, 0, buffer, size) !== true) {
      return { ok: false, reason: 'QueryFullProcessImageNameW failed' };
    }
    const length = size.readUInt32LE(0);
    return { ok: true, path: buffer.toString('utf16le', 0, length * 2) };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  } finally {
    // 句柄必须关，否则长期运行会耗尽内核句柄。
    if (handle && Number(handle) !== 0) {
      try {
        loaded.CloseHandle(handle);
      } catch {
        // 关闭失败不改变结论。
      }
    }
  }
}

/**
 * 在窗口及其所有子窗口里按类名找控件（例如记事本的编辑区）。
 * 只做只读枚举，不改变任何状态。
 */
export function findChildByClass(parentHwnd, className) {
  const loaded = loadWin32();
  if (loaded.reason !== undefined) return { ok: false, reason: loaded.reason };
  const hits = [];
  const want = String(className);
  enumWindows((hwnd) => {
    if (classOf(loaded, hwnd) === want) hits.push(hwnd);
    return true;
  }, { childrenOf: Number(parentHwnd) });
  if (hits.length === 0) return { ok: false, reason: `no child of ${String(parentHwnd)} has class ${want}` };
  return { ok: true, hwnd: hits[0], all: hits, count: hits.length };
}

// ---------------------------------------------------------------------------
// 弹出菜单（右键上下文菜单）
// ---------------------------------------------------------------------------

/**
 * 标准 Win32 弹出菜单的窗口类名（TrackPopupMenu 创建的就是这个）。
 *
 * 这类菜单是**独立的顶层弹出窗口**，不属于原目标窗口的子窗口 —— 所以
 * "右键点击目标窗口"之后要操作的是**菜单窗口**，而不是原窗口。
 * 这是右键功能最容易搞错的地方。
 */
export const POPUP_MENU_CLASS = '#32768';

/** 弹出菜单的窗口类名候选（标准菜单 + 少数自绘菜单常见类名）。 */
const MENU_CLASS_CANDIDATES = ['#32768', '#32769', 'ToolbarWindow32'];

/**
 * 找出当前可见的弹出菜单窗口。
 *
 * 用途：
 *   1. 右键点击后确认菜单是否真的弹出来了；
 *   2. 拿到菜单窗口 hwnd，才能把后续的点击/按键投递给**菜单本身**。
 *
 * @returns `{ ok:true, menus:[{hwnd,className,rect,pid}] }`。
 *   没有可见菜单时返回 `ok:true` + 空数组 —— 这是正常状态（没弹菜单），
 *   不是错误，所以不当成 failure 处理。
 */
export function findPopupMenus() {
  const loaded = loadWin32();
  if (loaded.reason !== undefined) return { ok: false, reason: loaded.reason, menus: [] };

  const menus = [];
  enumWindows((hwnd) => {
    const cls = classOf(loaded, hwnd);
    if (!MENU_CLASS_CANDIDATES.includes(cls)) return true;
    if (loaded.IsWindowVisible(hwnd) !== true) return true;
    const rect = windowRect(loaded, hwnd);
    if (rect === undefined || rect.width <= 0 || rect.height <= 0) return true;
    menus.push({
      hwnd,
      className: cls,
      pid: windowPid(loaded, hwnd),
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      isStandardMenu: cls === POPUP_MENU_CLASS,
    });
    return true;
  });

  // 面积小的优先（菜单通常比主窗口小得多，避免把工具栏误判成菜单）
  menus.sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
  return { ok: true, count: menus.length, menus };
}

/**
 * 关闭当前可见的弹出菜单。
 *
 * 优先用向菜单窗口投递 ESC（实测对标准 Win32 菜单有效：菜单由系统的菜单循环
 * 处理按键，所以 ESC 能关掉它）。若投递后菜单仍在，再退回 WM_CANCELMODE。
 *
 * 注意：这里**不**使用 SetForegroundWindow 或真实键盘事件 —— 保持不抢焦点、
 * 不影响用户鼠标的原则。
 *
 * @returns `{ ok, closed, remaining, method }`。
 */
export function closePopupMenus() {
  const loaded = loadWin32();
  if (loaded.reason !== undefined) return { ok: false, reason: loaded.reason };

  const found = findPopupMenus();
  if (found.ok !== true) return found;
  if (found.menus.length === 0) return { ok: true, closed: 0, remaining: 0, method: 'none' };

  const WM_KEYDOWN = 0x0100;
  const WM_KEYUP = 0x0101;
  const WM_CANCELMODE = 0x001F;
  const VK_ESCAPE = 0x1B;
  let method = 'escape-post';

  for (const menu of found.menus) {
    try {
      loaded.PostMessageW(menu.hwnd, WM_KEYDOWN, VK_ESCAPE, 1);
      loaded.PostMessageW(menu.hwnd, WM_KEYUP, VK_ESCAPE, 0xC0000001);
    } catch {
      // 单个菜单投递失败不影响其它菜单。
    }
  }

  // PostMessage 是异步的，给菜单循环一点时间处理。
  const afterEscape = findPopupMenus();
  if (afterEscape.ok === true && afterEscape.menus.length > 0) {
    method = 'cancelmode';
    for (const menu of afterEscape.menus) {
      try {
        loaded.SendMessageW(menu.hwnd, WM_CANCELMODE, 0, 0);
      } catch {
        // 忽略单个失败。
      }
    }
  }

  const final = findPopupMenus();
  const remaining = final.ok === true ? final.menus.length : -1;
  return { ok: true, closed: found.menus.length - Math.max(0, remaining), remaining, method };
}
