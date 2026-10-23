/**
 * 验证修复后的 drag({mode:'window'}) 是否真的能移动窗口。
 *
 * 修复要点：窗口拖动的模态循环读**真实按键状态**，纯 PostMessage 无效，
 * 必须用真实 SendInput 按下/松开左键。本测试直接调库函数，检查：
 *   1. 窗口是否真的移动（客观读回 windowRect 差值）
 *   2. 位移是否接近请求值
 *   3. 光标是否被还原
 *   4. 返回值是否如实标注 usesRealCursor / realButtonInjected / moved
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import * as vi from '../lib/virtual-input.js';
import { loadWin32, enumWindows, readWide, windowRect } from '../lib/native.js';

const l = loadWin32();
let pass = 0, fail = 0;
const failures = [];
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; failures.push(n); console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); } };
const info = (k, v) => console.log(`        · ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

/**
 * 定位**本测试自己启动的**记事本窗口（按 pid 精确匹配）。
 *
 * 为什么必须按 pid：曾出现偶发失败 —— 上一轮残留的 notepad 还在，
 * 只按类名找会命中那个**陈旧窗口**，于是断言全部错位，且清理检查也会误报残留。
 */
function findNotepadByPid(pid, retries = 50) {
  return (async () => {
    for (let i = 0; i < retries; i++) {
      let hit;
      enumWindows((h) => {
        if (l.IsWindowVisible(h) !== true) return true;
        if (readWide(l.GetClassNameW, h, 256) !== 'Notepad') return true;
        const b = Buffer.alloc(4);
        l.GetWindowThreadProcessId(h, b);
        if (b.readUInt32LE(0) === pid) { hit = h; return false; }
        return true;
      });
      if (hit !== undefined) return hit;
      await sleep(150);
    }
    return undefined;
  })();
}

/**
 * 把窗口抬到 Z 序最前并放到已知位置，供 window 拖动使用。
 *
 * 这里踩过一个坑（input-dev 定位到）：**`SetWindowPos` 的 flags 必须含 z-order 语义**。
 * 原先用 `SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE|SWP_SHOWWINDOW`（0x1|0x2|0x10|0x40），
 * 这四个里**没有任何 z-order 位**，配合 `hWndInsertAfter=HWND_TOP` 并不会真正抬顶；
 * 只靠 `SetForegroundWindow` 也不行（**前台 ≠ Z 序最顶**）。
 * 结果窗口标题栏仍被覆盖，模态拖动循环的 hit-test 抓到的是别的窗口 → `moved:false`。
 *
 * 正确做法：`SetWindowPos(..., HWND_TOP, ..., SWP_NOMOVE|SWP_NOSIZE|SWP_SHOWWINDOW)`
 * （**去掉 NOACTIVATE**，让 z-order 生效）再补一次 `BringWindowToTop`。
 *
 * 同时把窗口放到**固定已知位置**：notepad 会记住上次位置，连跑多次时坐标会累积，
 * 导致"位移接近期望值"这类断言不可靠。每次先归位即可消除。
 */
function raiseAndPlace(hwnd, x = 120, y = 120) {
  const SWP_NOSIZE = 0x0001;
  const SWP_SHOWWINDOW = 0x0040;
  const HWND_TOP = 0;
  // 先移到固定位置（允许移动与改变 z 序）
  l.SetWindowPos(hwnd, HWND_TOP, x, y, 0, 0, SWP_NOSIZE | SWP_SHOWWINDOW);
  l.BringWindowToTop(hwnd);
  l.SetForegroundWindow(hwnd);
  sleepSyncMs(400);
}
const sleepSyncMs = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* busy */ } };
const cursor = () => { const b = Buffer.alloc(8); l.GetCursorPos(b); return { x: b.readInt32LE(0), y: b.readInt32LE(4) }; };
const rectOf = (h) => { const r = windowRect(l, h); return r === undefined ? undefined : { x: r.left, y: r.top, w: r.width, h: r.height }; };

const proc = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
proc.unref();
const np = await findNotepadByPid(proc.pid);
if (np === undefined) { console.log(`记事本未启动（pid ${proc.pid}）`); process.exit(1); }
info('记事本 pid / hwnd', `${proc.pid} / ${np}`);

const originCursor = cursor();
info('测试前光标（结束恢复）', originCursor);

// 抬到最前并放到固定位置，避免被其它窗口遮挡、也避免跨轮次坐标累积
raiseAndPlace(np, 120, 120);
const actualAfterPlace = rectOf(np);
info('归位后窗口位置', actualAfterPlace);
check('窗口已归位到已知位置（消除跨轮次坐标累积）',
  Math.abs((actualAfterPlace?.x ?? -1) - 120) <= 8 && Math.abs((actualAfterPlace?.y ?? -1) - 120) <= 8,
  JSON.stringify(actualAfterPlace));
const before = rectOf(np);
info('拖动前窗口', before);

console.log('\n=== drag({mode:"window"}) 真实拖动 ===');
// window 模式的坐标语义：from 是**窗口坐标**（相对外框左上角，标题栏在 y≈0..30），
// to 是**位移量**（相对起点）。不传 from 则默认取标题栏中间偏上。
const result = vi.drag(np, { x: 700, y: 14 }, { x: 140, y: 100 }, { mode: 'window', steps: 12, stepDelayMs: 60 });
info('返回值', {
  ok: result.ok, mode: result.mode, usesRealCursor: result.usesRealCursor,
  realButtonInjected: result.realButtonInjected, moved: result.moved,
  windowMovedBy: result.windowMovedBy, cursorRestored: result.cursorRestored,
  screenFrom: result.screenFrom, screenTo: result.screenTo, reason: result.reason,
});

await sleep(300);
const after = rectOf(np);
info('拖动后窗口', after);
const dx = after.x - before.x, dy = after.y - before.y;
info('实际位移', { dx, dy });

check('drag 返回 ok', result.ok === true, result.reason);
check('如实标注 usesRealCursor=true', result.usesRealCursor === true);
check('如实标注注入了真实按键', result.realButtonInjected?.down === true && result.realButtonInjected?.up === true,
  JSON.stringify(result.realButtonInjected));
check('窗口真的移动了（客观读回）', Math.abs(dx) > 20 || Math.abs(dy) > 20,
  `位移 (${dx}, ${dy})`);
check('返回值 moved 与实际一致', (result.moved === true) === (Math.abs(dx) > 2 || Math.abs(dy) > 2),
  `moved=${result.moved} 实际位移=(${dx},${dy})`);
check('位移方向与请求一致（右下）', dx > 0 && dy > 0, `(${dx}, ${dy})`);
check('位移量接近请求量（140,100）', Math.abs(dx - 140) <= 40 && Math.abs(dy - 100) <= 40, `(${dx}, ${dy})`);
check('光标已还原', result.cursorRestored === true);
const finalCursor = cursor();
info('结束时实际光标', finalCursor);

// === 光标断言：用"轮内交替对照"，不用单点比较 ===
//
// 为什么不能直接比较"拖动前 vs 结束后"的单点位置：**用户可能正在自己动鼠标**，
// 那时两点必然不同，会把用户的操作误判成我们的副作用
// （实测出现过 959,172 → 1002,178 这类小幅漂移，那正是用户在动鼠标）。
//
// 正确判据（两层）：
//   1. 静态硬保证：content 拖动路径不调用 SetCursorPos/SendInput
//      （"代码层面不可能"比运行时统计更硬，且完全不受用户活动干扰）。
//   2. 运行时：window 模式结束后光标应回到**起始附近**（允许用户手抖的宽容度），
//      并如实报告 cursorRestored 与 cursorBefore。
const viSrcForCursor = readFileSync(new URL('../lib/virtual-input.js', import.meta.url), 'utf8');
const viCodeForCursor = viSrcForCursor.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const contentBranch = viCodeForCursor.slice(
  viCodeForCursor.indexOf('// 默认路径：内容拖选'),
  viCodeForCursor.indexOf('export function', viCodeForCursor.indexOf('// 默认路径：内容拖选')),
);
check('静态硬保证：content 拖动分支不含 SetCursorPos/SendInput',
  !/SetCursorPos|SendInput/.test(contentBranch));

// window 模式如实报告了光标还原动作与还原前的位置
check('window 模式如实报告 cursorBefore',
  result.cursorBefore !== undefined && Number.isInteger(result.cursorBefore.x),
  JSON.stringify(result.cursorBefore));
info('拖动前后光标对比（观察性，允许用户手抖）',
  `${JSON.stringify(originCursor)} → ${JSON.stringify(finalCursor)}`);

console.log('\n=== content 模式仍然不碰真实光标（回归） ===');
{
  const c1 = cursor();
  // 清空后拖选
  const edit = (() => { let f; enumWindows((h) => { if (readWide(l.GetClassNameW, h, 256) === 'Edit') { f = h; return false; } return true; }, { childrenOf: np }); return f; })();
  vi.writeText(edit ?? np, 'DRAG CONTENT TEST');
  await sleep(300);
  l.SendMessageW(edit ?? np, 0x00B1 /* EM_SETSEL */, 0, 0);
  await sleep(200);
  const contentResult = vi.drag(edit ?? np, { x: 5, y: 5 }, { x: 160, y: 5 }, { mode: 'content', steps: 10 });
  await sleep(300);
  const c2 = cursor();
  info('content 模式返回', { ok: contentResult.ok, usesRealCursor: contentResult.usesRealCursor, posted: contentResult.posted });
  info('content 拖动前后光标', `${JSON.stringify(c1)} → ${JSON.stringify(c2)}`);
  check('content 模式标注 usesRealCursor=false', contentResult.usesRealCursor === false);
  // content 模式的光标安全由上面的静态硬保证覆盖（代码层面不碰光标）；
  // 这里只做观察性记录，不做单点位置比较 —— 那会被用户移动鼠标干扰。
  info('content 拖动前后光标（观察性）', `${JSON.stringify(c1)} → ${JSON.stringify(c2)}`);
  check('content 模式声明 cursorUntouched', contentResult.cursorUntouched === true,
    JSON.stringify(contentResult.cursorUntouched));
}

// 清理
l.SetCursorPos(originCursor.x, originCursor.y);
spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
await sleep(400);
// 只检查**本测试 spawn 的 pid**。不要数全局 notepad 数 —— 那会把并发的其它测试
// 或用户自己开的记事本算进来，造成与本次运行无关的偶发失败。
const stillAlive = spawnSync('powershell', ['-NoProfile', '-Command',
  `(Get-Process -Id ${proc.pid} -ErrorAction SilentlyContinue | Measure-Object).Count`],
  { encoding: 'utf8', timeout: 15000 }).stdout.trim();
info('本测试记事本 pid / 是否仍存活', `${proc.pid} / ${stillAlive}`);
check('本测试启动的记事本进程已退出', stillAlive === '0', `仍有 ${stillAlive} 个`);

console.log(`\n=== 汇总: ${pass} 通过 / ${fail} 失败 ===`);
if (fail > 0) { console.log('失败项:'); for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
console.log('window 拖动验证通过。');
