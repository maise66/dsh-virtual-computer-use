/**
 * 右键菜单 + 滚轮 的工具层端到端验证。
 *
 * 覆盖用户新增的两条要求：
 *   - 模拟鼠标右键（返回上下文菜单可被识别、可被选中、可被关闭）
 *   - 鼠标滚轮上下滚动（真实改变可见内容，不是只投递消息）
 *
 * 判据用**客观状态**（EM_GETFIRSTVISIBLELINE 行号、菜单窗口是否存在），
 * 不用"消息投递成功"这种弱信号。
 */
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadWin32, enumWindows, readWide } from '../lib/native.js';
import * as vi from '../lib/virtual-input.js';
import { findPopupMenus, closePopupMenus } from '../lib/windows.js';
import { buildTools } from '../lib/tools.js';
import { OperationTracker } from '../lib/tracker.js';

const loaded = loadWin32();
let pass = 0, fail = 0;
const failures = [];
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; failures.push(n); console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); } };
const info = (l, v) => console.log(`        · ${l}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

/**
 * 光标"未被移动"的稳健判据。
 *
 * 为什么不能用单点前后对比：**用户可能正在自己动鼠标**，那时前后两点必然不同，
 * 会把用户的操作误判成我们的副作用（实测出现过 844,85 → 909,238 这种假阳性）。
 *
 * 判据：**静态硬保证** —— 滚动/右键路径都不调用 SetCursorPos/SendInput，
 * "代码层面不可能"比任何运行时统计都硬，且完全不受用户活动干扰。
 */
const fsMod = await import('node:fs');
const viSrc = fsMod.readFileSync(new URL('../lib/virtual-input.js', import.meta.url), 'utf8');
const viCode = viSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const defaultPathsClean = ['click', 'move', 'scroll', 'scrollLines'].every((fn) => {
  const s = viCode.indexOf(`export function ${fn}`);
  if (s < 0) return true;
  const e = viCode.indexOf('export function', s + 20);
  const body = viCode.slice(s, e < 0 ? undefined : e);
  return !/SetCursorPos|SendInput/.test(body);
});

/**
 * 定位**本测试自己启动的**记事本窗口。
 *
 * 为什么必须按 pid 过滤：曾出现偶发失败 —— 上一轮测试残留的 notepad 还在，
 * 而只按类名找会命中那个**陈旧窗口**（已被 taskkill 掉、或尚未就绪），
 * 于是右键菜单弹在了一个不该操作的对象上，后续断言全崩。
 * 按 spawn 返回的 pid 精确定位即可消除这种跨轮次干扰。
 */
function findNotepadByPid(pid, retries = 50) {
  return (async () => {
    for (let i = 0; i < retries; i++) {
      let hit;
      enumWindows((h) => {
        if (loaded.IsWindowVisible(h) !== true) return true;
        if (readWide(loaded.GetClassNameW, h, 256) !== 'Notepad') return true;
        const b = Buffer.alloc(4);
        loaded.GetWindowThreadProcessId(h, b);
        if (b.readUInt32LE(0) === pid) { hit = h; return false; }
        return true;
      });
      if (hit !== undefined) return hit;
      await sleep(150);
    }
    return undefined;
  })();
}
function findEditChild(parent) { let f; enumWindows((h) => { if (readWide(loaded.GetClassNameW, h, 256) === 'Edit') { f = h; return false; } return true; }, { childrenOf: parent }); return f; }

console.log('══════════════════════════════════════════════════════');
console.log('  右键菜单 + 滚轮 工具层端到端验证');
console.log('══════════════════════════════════════════════════════\n');

const proc = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
proc.unref();
if (proc.pid === undefined) { console.log('FATAL: spawn 未返回 pid'); process.exit(1); }
const notepad = await findNotepadByPid(proc.pid);
if (notepad === undefined) { console.log(`FATAL: 未找到 pid ${proc.pid} 的记事本窗口`); process.exit(1); }
const edit = findEditChild(notepad) ?? notepad;
info('本测试的记事本 pid/hwnd', `${proc.pid} / ${notepad}`);
info('记事本 / 编辑控件', `${notepad} / ${edit}`);

// 写入足够多行，供滚动验证。
//
// 两个夹具坑（都有实测依据）：
//   1. 行数太少（80 行）而一屏能显示约 49 行 → 滚动只有"顶/底"两个状态、没有中间
//      位置，读数看起来"没反应"。现在写 400 行，视口占比足够小。
//   2. **行太长会折行**，折行后"行"的计数与预期不符（EM_GETFIRSTVISIBLELINE
//      按显示行算）。所以每行保持简短，确保 1 行文本 = 1 显示行。
const rows = [];
for (let i = 1; i <= 400; i++) rows.push(`R${String(i).padStart(3, '0')}`);
vi.writeText(edit, rows.join('\r\n'));
await sleep(700);

// 构造真实的工具环境（用假的 tracker，但真工具函数）
const tracker = new OperationTracker({ lingerMs: 100 });
const deps = {
  virtualInput: vi,
  tracker,
  resetAbort: async () => {},
  status: () => ({ ok: true, summary: 'test' }),
};
const tools = buildTools(deps);
const tool = (name) => tools.find((t) => t.name === name);
const call = async (name, args) => tool(name).execute(args, {});

// EM_GETFIRSTVISIBLELINE 是判断"内容真的滚动了"的客观依据
const EM_GETFIRSTVISIBLELINE = 0x00CE;
const EM_SETSEL = 0x00B1;
const EM_SCROLLCARET = 0x00B7;
const firstVisibleLine = () => Number(loaded.SendMessageW(edit, EM_GETFIRSTVISIBLELINE, 0, 0));

/**
 * 把编辑控件的视图**稳定地**归位到一个"有双向余量"的中间位置。
 *
 * 踩过的坑与结论（都有实测数据）：
 *
 *   1. `EM_LINESCROLL(0,-9999)` 在内容不足一屏时"看着没生效"；不可靠。
 *   2. **插入点会把视图钉住**：caret 在末尾时向上滚会被立刻拉回底部
 *      （实测 +120 反而继续向下 233→269→306），方向看起来完全反了。
 *   3. **锚点不能贴两端**。贴顶时"+120 向上"无处可去（读数 0→0）；
 *      贴底时"-120 向下"无处可去（读数 369→369）。断言必须从**中间**出发。
 *      —— 这正是先前偶发失败的真正原因：我最初只把视图推离顶端 5 行，
 *      而滚轮一格跳约 80 行，于是第二次同向滚动必然撞到底端。
 *   4. **写入后视图需要时间稳定**：刚写完多行文本时 `EM_SCROLLCARET` 未必立刻到顶
 *      （实测前两轮读到 28/360，第三轮起才稳定为 0）。
 *
 * 最终策略：归顶 → 等稳定 → 用 `EM_LINESCROLL(0, N)` 推到**文档中段**，
 * 使上下两个方向都有充足余量。
 */
const anchorView = async () => {
  loaded.SendMessageW(edit, EM_SETSEL, 0, 0);
  loaded.SendMessageW(edit, EM_SCROLLCARET, 0, 0);
  await sleep(650);
  // 推到文档中段（400 行文本的中段），保证上下都有很大的滚动余量。
  // 不用固定小数（如 5），因为滚轮一格可能跳几十行，贴顶会立刻到底。
  const lineCount = Number(loaded.SendMessageW(edit, 0x00BA /* EM_GETLINECOUNT */, 0, 0));
  const mid = Math.max(5, Math.floor((Number.isFinite(lineCount) && lineCount > 0 ? lineCount : 400) / 2));
  loaded.SendMessageW(edit, 0x00B6 /* EM_LINESCROLL */, 0, mid);
  await sleep(450);
  return firstVisibleLine();
};

// =========================================================================
console.log('【1】滚轮上下滚动（客观判据：首行可见行号变化）\n');
// =========================================================================
{
  // 滚轮粒度由控件决定（实测一格可能跳十几行甚至半屏），所以断言只关心**方向**。
  //
  // 关键：**每一步都要重新锚定 caret**。实测发现滚轮本身会让 caret 跟随视图移动
  // （caret 从 0 变成 1590 之类），而 caret 的位置又会影响下一次滚动的起点，
  // 于是"连续两步同向"的轨迹会因状态漂移而不可比 —— 这就是曾经偶发失败的原因。
  // 每一步都先 EM_SETSEL(0,0) 归位再滚，方向判据就稳定了
  // （实测 5 轮连续验证：-120 → 递增、+120 → 递减到 0，全部正确）。
  const anchoredScroll = async (delta) => {
    const before = await anchorView();
    const r = await call('vcu_scroll', { hwnd: edit, delta, x: 40, y: 40 });
    await sleep(550);
    return { before, after: firstVisibleLine(), result: r };
  };

  const down1 = await anchoredScroll(-120);
  info('锚定后 delta=-120', `${down1.before} → ${down1.after}`);
  const down2 = await anchoredScroll(-120);
  info('锚定后 delta=-120 复现', `${down2.before} → ${down2.after}`);
  // 判据：每一步都**不减少**（方向正确），且至少有一次真的增加。
  // 允许某次"已是底端、无处可去"而保持不变 —— 那是正确行为，不是失败。
  const downOk = down1.after >= down1.before && down2.after >= down2.before
    && (down1.after > down1.before || down2.after > down2.before);
  check('vcu_scroll(delta<0) 向下：FVL 不减少且至少一次增加',
    downOk, `${down1.before}→${down1.after} / ${down2.before}→${down2.after}`);

  const up1 = await anchoredScroll(120);
  info('锚定后 delta=+120', `${up1.before} → ${up1.after}`);
  const up2 = await anchoredScroll(120);
  info('锚定后 delta=+120 复现', `${up2.before} → ${up2.after}`);
  const upOk = up1.after <= up1.before && up2.after <= up2.before
    && (up1.after < up1.before || up2.after < up2.before);
  check('vcu_scroll(delta>0) 向上：FVL 不增加且至少一次减少',
    upOk, `${up1.before}→${up1.after} / ${up2.before}→${up2.after}`);

  check('双向滚动方向相反（证明 delta 符号真的控制方向）',
    downOk && upOk,
    `向下 ${down1.before}→${down1.after} / 向上 ${up1.before}→${up1.after}`);
  check('vcu_scroll 报告的投递计数非零',
    (down1.result.messagesPosted ?? down1.result.posted ?? 0) > 0);
}
// 滚轮也不能动真实光标
{
  const c1 = vi.cursorPosition();
  await call('vcu_scroll', { hwnd: edit, delta: -120 });
  await sleep(200);
  const c2 = vi.cursorPosition();
  // 不做单点前后比较（会被用户移动鼠标污染）。光标的"未被移动"由静态硬保证覆盖：
  // scroll 函数体不含 SetCursorPos/SendInput，代码层面不可能移动光标。
  info('滚轮前后光标（观察性，允许用户手抖）', `${JSON.stringify(c1)} → ${JSON.stringify(c2)}`);
  check('静态硬保证：滚轮路径不含 SetCursorPos/SendInput（代码层面不移动光标）', defaultPathsClean);
}

// -------------------------------------------------------------------------
// 逐行精确滚动（WM_VSCROLL）：这是比滚轮更可控的路径，断言"每次恰好一行"
// -------------------------------------------------------------------------
console.log('\n【1b】逐行精确滚动 vcu_scroll_lines（WM_VSCROLL）\n');
{
  // 逐行滚动要向下 5 行再向上 5 行回到原点，所以基准必须**靠近顶部**
  // （否则向上 5 行没有余量）。这里用 setsel(0,0)+SCROLLCARET 归顶并等待稳定。
  loaded.SendMessageW(edit, EM_SETSEL, 0, 0);
  loaded.SendMessageW(edit, EM_SCROLLCARET, 0, 0);
  await sleep(650);
  const base = firstVisibleLine();
  info('基准 FVL', base);

  const down5 = await call('vcu_scroll_lines', { hwnd: edit, direction: 'down', unit: 'line', times: 5 });
  info('vcu_scroll_lines(down ×5)', down5.summary);
  await sleep(400);
  const afterDown = firstVisibleLine();
  info('下滚 5 行后 FVL', afterDown);
  check('逐行向下 5 次：FVL 恰好 +5（每消息一行）', afterDown - base === 5, `${base} → ${afterDown}`);

  const up5 = await call('vcu_scroll_lines', { hwnd: edit, direction: 'up', unit: 'line', times: 5 });
  info('vcu_scroll_lines(up ×5)', up5.summary);
  await sleep(400);
  const afterUp = firstVisibleLine();
  info('上滚 5 行后 FVL', afterUp);
  check('逐行向上 5 次：FVL 恰好回到基准', afterUp === base, `${afterDown} → ${afterUp}（基准 ${base}）`);

  // 翻页也应生效
  const pageDown = await call('vcu_scroll_lines', { hwnd: edit, direction: 'down', unit: 'page', times: 1 });
  await sleep(400);
  const afterPage = firstVisibleLine();
  info('翻页后 FVL', afterPage);
  check('翻页滚动生效', afterPage > afterUp, `${afterUp} → ${afterPage}`);
  check('scroll_lines 报告的投递计数非零', (down5.messagesPosted ?? down5.posted ?? 0) > 0);
}

// =========================================================================
console.log('\n【2】右键弹出上下文菜单\n');
// =========================================================================
{
  const beforeMenus = findPopupMenus();
  info('右键前可见菜单数', beforeMenus.menus.length);

  const rc = await call('vcu_right_click', { hwnd: edit, x: 40, y: 20 });
  info('vcu_right_click', rc.summary);
  check('vcu_right_click 成功投递', rc.ok === true, rc.reason);
  check('vcu_right_click 报告菜单已弹出', rc.menuAppeared === true,
    `menuAppeared=${rc.menuAppeared}`);
  const menus = findPopupMenus();
  info('检测到的菜单', menus.menus.map((m) => ({ hwnd: m.hwnd, cls: m.className, rect: m.rect })));
  check('windows.js 能检测到弹出菜单窗口', menus.menus.length > 0);
  if (menus.menus.length > 0) {
    check('检测到的菜单是标准 Win32 菜单类名 #32768',
      menus.menus.some((m) => m.className === '#32768'), menus.menus.map((m) => m.className).join(','));
  }

  // 工具层：vcu_popup_menu
  const pm = await call('vcu_popup_menu', {});
  info('vcu_popup_menu', pm.summary);
  check('vcu_popup_menu 报告菜单存在', pm.ok === true && pm.count > 0, `count=${pm.count}`);
}

// =========================================================================
console.log('\n【3】点击菜单项（投递给菜单窗口自身）\n');
// =========================================================================
{
  const menus = findPopupMenus();
  if (menus.menus.length > 0) {
    const menuHwnd = menus.menus[0].hwnd;
    const rect = menus.menus[0].rect;
    info('目标菜单', { hwnd: menuHwnd, rect });
    // 点击菜单里第一项（菜单客户区靠上的位置）
    const itemClick = await call('vcu_click', { hwnd: menuHwnd, x: Math.round(rect.width / 2), y: 12 });
    info('点击菜单项', itemClick.summary);
    check('向菜单窗口投递点击成功', itemClick.ok === true, itemClick.reason);
    await sleep(500);
    const after = findPopupMenus();
    info('点击后剩余菜单数', after.menus.length);
    check('点击菜单项后菜单关闭（说明选择被处理）', after.menus.length === 0,
      `remaining=${after.menus.length}`);
  } else {
    check('菜单存在以便点击（前置条件）', false, '未检测到菜单');
  }
}

// =========================================================================
console.log('\n【4】关闭菜单（ESC 投递给菜单窗口）\n');
// =========================================================================
{
  // 重新弹一次
  await call('vcu_right_click', { hwnd: edit, x: 60, y: 30 });
  const opened = findPopupMenus();
  info('重新弹出的菜单数', opened.menus.length);
  check('菜单重新弹出（前置条件）', opened.menus.length > 0);

  const closed = await call('vcu_close_menu', {});
  info('vcu_close_menu', closed.summary);
  check('vcu_close_menu 成功', closed.ok === true, closed.reason);
  const after = findPopupMenus();
  info('关闭后剩余菜单数', after.menus.length);
  check('菜单已关闭', after.menus.length === 0, `remaining=${after.menus.length}`);
  check('vcu_close_menu 报告的 remaining 与实际一致', closed.remaining === after.menus.length,
    `reported=${closed.remaining} actual=${after.menus.length}`);
}

// =========================================================================
console.log('\n【5】无菜单时的幂等/降级行为\n');
// =========================================================================
{
  const none = await call('vcu_close_menu', {});
  check('没有菜单时 close_menu 返回 ok 而非报错', none.ok === true, JSON.stringify(none));
  const pm = await call('vcu_popup_menu', {});
  check('没有菜单时 popup_menu 返回 ok + count=0', pm.ok === true && pm.count === 0, JSON.stringify(pm));
}

// =========================================================================
console.log('\n【6】右键不移动真实光标 / 不抢焦点\n');
// =========================================================================
{
  const c1 = vi.cursorPosition();
  const fg1 = Number(loaded.GetForegroundWindow());
  const rc = await call('vcu_right_click', { hwnd: edit, x: 80, y: 40 });
  await sleep(300);
  const c2 = vi.cursorPosition();
  info('右键前后光标', `${JSON.stringify(c1)} → ${JSON.stringify(c2)}`);
  info('右键前后前台', `${fg1} → ${Number(loaded.GetForegroundWindow())}`);
  // 同样不做单点比较。右键（click 的 button:'right'）走的是纯消息路径，
  // 由静态硬保证覆盖：click 函数体不含 SetCursorPos/SendInput。
  check('静态硬保证：右键路径不含 SetCursorPos/SendInput（代码层面不移动光标）', defaultPathsClean);
  check('右键后工具如实报告 cursorUnchanged', rc.cursorUnchanged === true, `cursorUnchanged=${rc.cursorUnchanged}`);
  await call('vcu_close_menu', {});
}

// 清理
closePopupMenus();
const killedPid = proc.pid;
spawnSync('taskkill', ['/PID', String(killedPid), '/T', '/F'], { stdio: 'ignore' });
await sleep(400);
// 只检查**本测试启动的那个 pid** 是否还在。不要去数全局 notepad 进程数 ——
// 那会把并发的其它测试（或用户自己开的记事本）算进来，造成无关的偶发失败。
const stillAlive = (() => {
  try {
    const out = spawnSync('powershell', ['-NoProfile', '-Command',
      `(Get-Process -Id ${killedPid} -ErrorAction SilentlyContinue | Measure-Object).Count`],
      { encoding: 'utf8', timeout: 15000 }).stdout.trim();
    return out;
  } catch { return 'unknown'; }
})();
info('本测试记事本 pid', killedPid);
info('该进程是否仍存活', stillAlive);
check('本测试启动的记事本进程已退出', stillAlive === '0', `仍有 ${stillAlive} 个`);

console.log('\n══════════════════════════════════════════════════════');
console.log(`  汇总: ${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} 项`);
console.log('══════════════════════════════════════════════════════');
if (fail > 0) { console.log('\n失败项:'); for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
console.log('\n右键菜单 + 滚轮 验证全部通过。');
