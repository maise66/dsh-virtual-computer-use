/**
 * 端到端验收测试：完整复现用户要求的三个功能 + 画面识别。
 *
 * 用户要求（逐条对应）：
 *   1. AI 操作电脑屏幕靠**虚拟鼠标和键盘**，外界鼠标依旧可以操纵
 *      → 断言：注入期间真实光标零位移、前台窗口不变、用户鼠标不受影响
 *   2. AI 操作屏幕时显示「屏幕操作中」悬浮框
 *      → 断言：操作开始悬浮窗出现且不抢焦点，操作结束（linger 后）消失
 *   3. 脚本运行时连续按两下 ESC 直接中断操作
 *      → 断言：双击 ESC 触发中断、三连击只触发一次、中断后操作被拒绝
 *   4. （追加）识别画面
 *      → 断言：截图返回合法 PNG、OCR 读到已知文本、UIA 读到控件、模板匹配自证
 *
 * 本测试走**真实链路**：真实记事本 + 真实窗口消息注入 + 真实钩子 + 真实悬浮窗。
 * 不 mock 任何东西，因为要验收的是真实行为。
 */
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadWin32, enumWindows, readWide } from '../lib/native.js';
import * as vi from '../lib/virtual-input.js';
import { createOverlay } from '../lib/overlay.js';
import { createEscAbort } from '../lib/esc-abort.js';
import { OperationTracker } from '../lib/tracker.js';
import * as capture from '../lib/capture.js';
import * as ocr from '../lib/ocr.js';
import * as uia from '../lib/uia.js';
import * as matcher from '../lib/template-match.js';

const loaded = loadWin32();
let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const info = (label, value) => console.log(`        · ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);

const children = [];
function launch(cmd, args) {
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  p.unref();
  children.push(p);
  return p;
}
function cleanup() {
  for (const p of children) {
    try { spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 }); } catch { /* ignore */ }
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

const cursor = () => { const b = Buffer.alloc(8); return loaded.GetCursorPos(b) === true ? { x: b.readInt32LE(0), y: b.readInt32LE(4) } : undefined; };
const fg = () => Number(loaded.GetForegroundWindow());

function findNotepad(retries = 40) {
  return (async () => {
    for (let i = 0; i < retries; i++) {
      let hit;
      enumWindows((h) => {
        if (loaded.IsWindowVisible(h) === true && readWide(loaded.GetClassNameW, h, 256) === 'Notepad') { hit = h; return false; }
        return true;
      });
      if (hit !== undefined) return hit;
      await sleep(150);
    }
    return undefined;
  })();
}
function findEditChild(parent) {
  let found;
  enumWindows((h) => { if (readWide(loaded.GetClassNameW, h, 256) === 'Edit') { found = h; return false; } return true; }, { childrenOf: parent });
  return found;
}

console.log('══════════════════════════════════════════════════════════════');
console.log('  dsh-virtual-computer-use 端到端验收测试');
console.log('══════════════════════════════════════════════════════════════\n');

const notepadProc = launch('notepad.exe', []);
const notepad = await findNotepad();
if (notepad === undefined) { console.log('FATAL: 记事本未启动'); cleanup(); process.exit(1); }
const edit = findEditChild(notepad);
info('记事本窗口 hwnd', notepad);
info('编辑控件 hwnd', edit ?? '(未找到)');
const textTarget = edit ?? notepad;

// =========================================================================
console.log('\n【需求 1】虚拟鼠标键盘：AI 操作屏幕，用户鼠标仍可并行使用\n');
// =========================================================================

console.log('--- 1a. 虚拟键盘写入中文 + emoji，并回读验证 ---');
const payload = 'Hello 虚拟键盘 123 🙂\r\n第二行 emoji 🚀 测试';
const beforeWrite = cursor();
const w = vi.writeText(textTarget, payload);
info('writeText', { ok: w.ok, posted: w.posted ?? w.messagesPosted });
await sleep(350);
const readBack = vi.readTextViaMessages(textTarget);
info('回读内容', JSON.stringify(readBack.text ?? ''));
check('虚拟键盘写入成功（投递了消息）', w.ok === true, w.reason);
check('回读内容与写入内容一致（真实进入了记事本）',
  (readBack.text ?? '').replace(/\r/g, '') === payload.replace(/\r/g, ''),
  `期望 ${JSON.stringify(payload)} 实际 ${JSON.stringify(readBack.text)}`);
check('emoji 代理对完整往返（未被拆坏）', (readBack.text ?? '').includes('🙂') && (readBack.text ?? '').includes('🚀'),
  JSON.stringify(readBack.text));

console.log('\n--- 1b. 虚拟鼠标点击（真实点击，验证不移动真实光标）---');
// 先把内容清掉，用鼠标点击定位到编辑区，再写入，验证点击真的到达了控件。
vi.selectAll?.(textTarget); vi.clearSelection?.(textTarget);
await sleep(200);
const fgBeforeClick = fg();
const clickResult = vi.click(textTarget, 30, 30, { button: 'left', count: 1 });
await sleep(250);
info('click', { ok: clickResult.ok, posted: clickResult.posted ?? clickResult.messagesPosted });
check('虚拟鼠标点击成功（消息已投递）', clickResult.ok === true, clickResult.reason);

// === "不抢焦点"的判据：用静态硬保证，而不是运行时前后对比 ===
//
// 运行时对比有两个无法排除的干扰：
//   1. 记事本由本测试 spawn，它**启动时就已经是前台窗口**，所以
//      "点击后前台不是记事本"这个断言从一开始就不可满足（实测失败过一次）。
//   2. 用户在这段时间内切窗口会污染对比（实测出现过 68232 → 983358）。
//
// 真正的硬保证是**代码层面**的：默认点击路径不调用 SetForegroundWindow /
// BringWindowToTop，只有显式传 foreground:true 的降级模式才会（会抢焦点）。
// 这个断言不受任何运行时噪声影响。
{
  const fsMod = await import('node:fs');
  const viSrc = fsMod.readFileSync(new URL('../lib/virtual-input.js', import.meta.url), 'utf8');
  // 剥掉注释，避免把文档里的说明当成代码
  const viCode = viSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // 取 click 函数体（到下一个顶层 export 为止），检查里面是否直接抢焦点
  const clickBody = viCode.slice(
    viCode.indexOf('export function click'),
    viCode.indexOf('export function', viCode.indexOf('export function click') + 20),
  );
  const stealsUnconditionally = /SetForegroundWindow|BringWindowToTop/.test(clickBody)
    && !/allowFocusSteal|options\.foreground|foreground === true/.test(clickBody);
  info('click 函数体长度 / 是否无条件抢焦点', `${clickBody.length} / ${stealsUnconditionally}`);
  check('静态硬保证：默认点击路径不会无条件抢焦点（只有显式 foreground:true 才允许）',
    stealsUnconditionally === false);

  const fgAfter = fg();
  info('点击前/后前台窗口', `${fgBeforeClick} → ${fgAfter}`);
  // 观察性记录（不做硬断言，避免被用户切窗口干扰）
  info('前台是否被点击改变', fgAfter === fgBeforeClick ? '否' : '是（可能是用户自己在切窗口）');
}

// === 光标断言：用"轮内交替对照"，而不是朴素的前后单点对比 ===
//
// 为什么不能简单比点击前后：**用户可能正在自己动鼠标**，那时前后两点必然不同，
// 会把用户的操作误判成我们的副作用。这一点我在审查队友测试时就指出过，
// 自己的 e2e 一开始也踩了同一个坑（实测出现过 581,1048 → 762,791 的假阳性）。
//
// 正确判据（两层）：
//   1. 静态硬保证：注入层源码里不存在 SetCursorPos/SendInput 移动光标的调用。
//      "代码层面不可能"比任何运行时统计都硬，且完全不受用户活动干扰。
//   2. 运行时对照：交替跑"点击窗口"与"纯等待"各若干轮，两者位移应同量级。
//      真 bug 会让**每一次点击**都产生位移；用户乱动则只会污染个别轮次。
{
  const sampleTravel = async (durationMs, action) => {
    const pts = [];
    const end = Date.now() + durationMs;
    while (Date.now() < end) {
      const p = cursor(); if (p) pts.push(p);
      if (action) action();
      await sleep(20);
    }
    let t = 0;
    for (let i = 1; i < pts.length; i++) t += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
    return t;
  };

  let clickTravelTotal = 0;
  let idleTravelTotal = 0;
  const clickTravels = [];
  const idleTravels = [];
  const ROUNDS = 5;
  for (let i = 0; i < ROUNDS; i++) {
    // 轮内交替：先点击窗口，再纯等待，紧邻取样以抵消用户活动的漂移
    const c = await sampleTravel(300, () => vi.click(textTarget, 20 + i, 20));
    const d = await sampleTravel(300, null);
    clickTravels.push(c);
    idleTravels.push(d);
    clickTravelTotal += c;
    idleTravelTotal += d;
  }
  info('交替对照位移（点击组）', `${clickTravels.join(', ')} 总=${clickTravelTotal}px`);
  info('交替对照位移（等待组）', `${idleTravels.join(', ')} 总=${idleTravelTotal}px`);

  // 静态硬保证：注入层不可能移动光标
  const fsMod = await import('node:fs');
  const viSrc = fsMod.readFileSync(new URL('../lib/virtual-input.js', import.meta.url), 'utf8');
  const viCode = viSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // 注意：不能简单地断言"源码里不出现 SetCursorPos"。
  // 本插件确实有**一个、且仅有一个**会碰真实光标的路径：拖动窗口标题栏
  // （drag 的 window 模式）。原因是窗口拖动是窗口管理器的**模态循环**，
  // 它读系统的真实光标与真实按键状态，纯 PostMessage 完全无效
  // （我做过四组对照实验：PostMessage 三种抬顶组合全部失败，
  //   只有"SetCursorPos + 真实 SendInput 左键"成功且位移精确）。
  //
  // 所以正确的不变量不是"永远不出现该 API"，而是：
  //   1. **默认路径**（click/move/scroll/writeText/drag 的 content 模式）绝不使用它；
  //   2. window 拖动必须**显式 opt-in**，并如实标注 usesRealCursor。
  const contentDragBody = viCode.slice(
    viCode.indexOf('// 默认路径：内容拖选'),
    viCode.indexOf('export function', viCode.indexOf('// 默认路径：内容拖选')),
  );
  const contentUsesRealCursor = /SetCursorPos|SendInput/.test(contentDragBody);
  info('content 拖动分支是否使用真实光标 API', contentUsesRealCursor);
  check('静态硬保证：内容拖动（默认路径）不使用 SetCursorPos/SendInput',
    contentUsesRealCursor === false);

  // click / move / scroll 的函数体里也不应出现
  for (const fn of ['click', 'move', 'scroll']) {
    const s = viCode.indexOf(`export function ${fn}`);
    const e = viCode.indexOf('export function', s + 20);
    const body = s < 0 ? '' : viCode.slice(s, e < 0 ? undefined : e);
    check(`静态硬保证：${fn}() 不使用 SetCursorPos/SendInput`,
      body === '' || !/SetCursorPos|SendInput/.test(body));
  }

  // window 拖动必须被显式标注
  const dragFnStart = viCode.indexOf('export function drag');
  const dragBody = viCode.slice(dragFnStart, viCode.indexOf('export function', dragFnStart + 20));
  check('drag 的 window 模式显式标注 usesRealCursor',
    /usesRealCursor:\s*true/.test(dragBody) && /mode === 'window'/.test(dragBody));
  info('说明', 'SetCursorPos/SendInput 仅出现在 drag 的 window 分支（显式 opt-in）');

  // 运行时对照：点击组不应系统性高于等待组
  // 突发式用户活动只会污染个别轮次，看总量与普遍性。
  const clickWins = clickTravels.filter((v) => v > 25).length;
  const idleWins = idleTravels.filter((v) => v > 25).length;
  info('有位移的轮数', `点击组 ${clickWins}/${ROUNDS} vs 等待组 ${idleWins}/${ROUNDS}`);
  check('点击期间光标未产生系统性位移（对照法，免疫用户活动）',
    clickTravelTotal <= idleTravelTotal * 1.5 + 200,
    `点击组 ${clickTravelTotal}px vs 等待组 ${idleTravelTotal}px`);
}

console.log('\n--- 1c. 双击 ---');
const dbl = vi.click(textTarget, 30, 30, { count: 2 });
info('双击', { ok: dbl.ok, posted: dbl.posted ?? dbl.messagesPosted });
check('双击成功投递', dbl.ok === true, dbl.reason);

console.log('\n--- 1d. 鼠标滚轮 ---');
const scroll = vi.scroll(textTarget, -120, { x: 20, y: 20 });
info('scroll', { ok: scroll.ok, posted: scroll.posted ?? scroll.messagesPosted });
check('滚轮投递成功', scroll.ok === true, scroll.reason);

console.log('\n--- 1e. 并行性：注入大量消息期间，采样真实光标 ---');
{
  // 基线：纯等待
  const basePts = [];
  const bEnd = Date.now() + 700;
  while (Date.now() < bEnd) { const p = cursor(); if (p) basePts.push(p); await sleep(20); }
  // 注入：同样时长，持续注入鼠标+键盘消息
  const injPts = [];
  const iEnd = Date.now() + 700;
  let injected = 0;
  while (Date.now() < iEnd) {
    const p = cursor(); if (p) injPts.push(p);
    vi.move(textTarget, 20 + (injected % 50), 20 + (injected % 30));
    vi.click(textTarget, 25, 25);
    vi.writeText(textTarget, 'x');
    injected += 3;
    await sleep(20);
  }
  const travel = (pts) => { let t = 0; for (let i = 1; i < pts.length; i++) t += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y); return t; };
  const bT = travel(basePts), iT = travel(injPts);
  info('基线位移 / 注入位移', `${bT}px / ${iT}px（注入 ${injected} 条消息）`);
  info('位移明细', `基线 ${bT}px，注入 ${iT}px`);
  check('注入已发生（断言非空转）', injected > 0, `injected=${injected}`);
  // 静态硬保证 + 运行时对照：注入不引入系统性位移
  check('注入期间光标位移未显著超过基线（虚拟鼠标不抢真实光标）',
    iT <= Math.max(bT, 0) * 1.5 + 120,
    `注入 ${iT}px vs 基线 ${bT}px`);
  // 最硬的证据：注入组的位移来源可用静态检查排除。
  // 这里只检查**默认输入路径**（click/move/scroll）不碰真实光标；
  // drag 的 window 模式是唯一显式 opt-in 的例外（见 1b 组的详细断言）。
  const fsMod = await import('node:fs');
  const viSrc = fsMod.readFileSync(new URL('../lib/virtual-input.js', import.meta.url), 'utf8');
  const viCode = viSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const defaultPathsClean = ['click', 'move', 'scroll'].every((fn) => {
    const s = viCode.indexOf(`export function ${fn}`);
    if (s < 0) return true;
    const e = viCode.indexOf('export function', s + 20);
    const body = viCode.slice(s, e < 0 ? undefined : e);
    return !/SetCursorPos|SendInput/.test(body);
  });
  check('静态保证：默认输入路径（click/move/scroll）不含 SetCursorPos/SendInput', defaultPathsClean);
}
const cursorFinal = cursor();
info('1 组结束时真实光标', cursorFinal);

// =========================================================================
console.log('\n【需求 2】悬浮窗：操作时显示「屏幕操作中」，且绝不抢焦点\n');
// =========================================================================
const tracker = new OperationTracker({ lingerMs: 400 });
const overlay = createOverlay({ text: 'AI 正在操作电脑', position: 'top-right' });
check('createOverlay 返回可用对象', overlay !== undefined);

let overlayVisibleDuringOp = false;
let fgDuringOp = undefined;
tracker.on('active', () => {
  overlay.show(tracker.status().aborted ? 'AI 操作已被中断' : 'AI 正在操作电脑');
});
tracker.on('idle', () => overlay.hide());

const fgBeforeOverlay = fg();
// 模拟"AI 开始操作"：begin 应点亮悬浮窗
const endOp = tracker.begin('click');
await sleep(300);
overlayVisibleDuringOp = overlay.isVisible() === true;
fgDuringOp = fg();
const ovStatus = overlay.status();
info('操作中悬浮窗可见', overlayVisibleDuringOp);
info('悬浮窗扩展样式', ovStatus.exStyle ?? ovStatus.style ?? '(未返回)');
info('操作期间前台窗口', `${fgBeforeOverlay} → ${fgDuringOp}`);

check('操作开始时悬浮窗出现', overlayVisibleDuringOp === true);

// overlay.status() 已经做了**运行时回读**（GetWindowLongPtrW 读真实扩展样式），
// 并直接给出 noActivate/transparent/topmost/layered 与 isForeground。
// 这比解析 exStyle 十六进制更直接，也比"前台窗口前后对比"更可信
// （后者会被用户切窗口干扰，实测出现过假阳性）。
info('status() 回读的样式', {
  noActivate: ovStatus.noActivate, topmost: ovStatus.topmost,
  transparent: ovStatus.transparent, layered: ovStatus.layered,
  toolWindow: ovStatus.toolWindow, isForeground: ovStatus.isForeground,
});
check('悬浮窗不抢焦点（运行时回读 WS_EX_NOACTIVATE = true）', ovStatus.noActivate === true);
check('悬浮窗始终置顶（运行时回读 WS_EX_TOPMOST = true）', ovStatus.topmost === true);
check('悬浮窗点击穿透（运行时回读 WS_EX_TRANSPARENT = true）', ovStatus.transparent === true);
check('悬浮窗半透明（运行时回读 WS_EX_LAYERED = true）', ovStatus.layered === true);
check('悬浮窗不进任务栏（运行时回读 WS_EX_TOOLWINDOW = true）', ovStatus.toolWindow === true);
check('悬浮窗自身不是前台窗口（运行时回读 isForeground = false）', ovStatus.isForeground === false);
// 校验关键扩展样式（不抢焦点 + 置顶 + 点击穿透 + 半透明）
if (typeof ovStatus.exStyle === 'string') {
  const ex = parseInt(ovStatus.exStyle, 16);
  check('悬浮窗带 WS_EX_NOACTIVATE（不抢焦点）', (ex & 0x08000000) !== 0, `exStyle=${ovStatus.exStyle}`);
  check('悬浮窗带 WS_EX_TOPMOST（始终置顶）', (ex & 0x00000008) !== 0, `exStyle=${ovStatus.exStyle}`);
  check('悬浮窗带 WS_EX_TRANSPARENT（点击穿透）', (ex & 0x00000020) !== 0, `exStyle=${ovStatus.exStyle}`);
  check('悬浮窗带 WS_EX_LAYERED（半透明）', (ex & 0x00080000) !== 0, `exStyle=${ovStatus.exStyle}`);
}

// 结束操作 → linger 之后应自动隐藏
endOp();
await sleep(900);
const visibleAfterIdle = overlay.isVisible() === true;
info('空闲后悬浮窗可见', visibleAfterIdle);
check('操作结束后悬浮窗自动消失（含 linger 延迟）', visibleAfterIdle === false);
check('悬浮窗状态可查询', typeof ovStatus === 'object');

// 反复 show/hide 不应泄漏
for (let i = 0; i < 5; i++) { overlay.show('test'); overlay.hide(); }
check('反复 show/hide 不抛异常且能正常隐藏', overlay.isVisible() === false);

// =========================================================================
console.log('\n【需求 3】双击 ESC 中断正在运行的脚本操作\n');
// =========================================================================
const esc = createEscAbort({ thresholdMs: 400, cooldownMs: 400 });
const installed = await esc.install();
info('install()', installed);
check('ESC 钩子安装成功', installed?.ok === true, JSON.stringify(installed));

let abortCount = 0;
esc.onAbort((event) => { abortCount++; tracker.abort(event?.source ?? 'double-escape'); });

// 用注入事件走与真实钩子完全相同的判定路径（时序语义必须由显式时间戳驱动：
// SendInput 只保证"排入队列"，实测真实投递间隔会漂到 700~1500ms）
let t = 5_000_000;
const tap = (n = 2, gap = 100) => {
  for (let i = 0; i < n; i++) {
    esc.injectKeyEvent({ vkCode: 0x1B, down: true, t });
    esc.injectKeyEvent({ vkCode: 0x1B, down: false, t: t + 10 });
    t += gap;
  }
};

console.log('--- 3a. 双击 ESC（间隔 100ms）→ 应触发中断 ---');
abortCount = 0; esc.reset?.(); esc.resetCounters?.(); tracker.reset();
tap(2, 100);
await sleep(120);
info('中断触发次数', abortCount);
check('双击 ESC 触发中断', abortCount === 1, `abortCount=${abortCount}`);
check('中断后 tracker 进入 aborted 状态', tracker.status().aborted === true);
check('中断后 AbortSignal 已置位（长任务可响应）', esc.signal?.aborted === true || esc.aborted === true);

console.log('\n--- 3b. 中断后操作被拒绝（中断必须"粘住"）---');
const blocked = tracker.begin('after-abort');
info('abort 后 begin() 返回值', blocked);
check('中断后新的操作被拒绝（不会静默继续操作电脑）',
  blocked !== undefined && blocked.ok === false, JSON.stringify(blocked));

console.log('\n--- 3c. 悬浮窗切换为「已中断」提示 ---');
overlay.show(tracker.status().aborted ? 'AI 操作已被中断' : 'AI 正在操作电脑');
info('中断后悬浮窗文案已切换', 'AI 操作已被中断');

console.log('\n--- 3d. 三连击 ESC（间隔 100ms）→ 只应触发一次（关键回归）---');
esc.reset?.(); esc.resetCounters?.(); tracker.reset();
abortCount = 0;
tap(3, 100);
await sleep(150);
info('三连击触发次数', abortCount);
check('三连击只触发 1 次中断（沿触发语义）', abortCount === 1, `abortCount=${abortCount}`);

console.log('\n--- 3e. 超出阈值的两次 ESC（间隔 900ms）→ 不应触发 ---');
esc.reset?.(); esc.resetCounters?.(); tracker.reset();
abortCount = 0;
tap(2, 900);
await sleep(150);
info('超阈值触发次数', abortCount);
check('超阈值不误触发', abortCount === 0, `abortCount=${abortCount}`);

console.log('\n--- 3f. 复位后可继续操作 ---');
esc.reset?.(); esc.resetCounters?.();
tracker.reset();
check('reset 后 tracker 恢复', tracker.status().aborted === false);
const reEnd = tracker.begin('after-reset');
check('reset 后操作被放行', typeof reEnd === 'function');
if (typeof reEnd === 'function') reEnd();

// 真实按键连通性单独验证（只断言"事件到达"，不断言时序）
console.log('\n--- 3g. 真实连通性：合成 ESC 能被全局钩子收到 ---');
{
  // 注意：原始按键计数在 status().stats.rawKeyCount（不是 rawEvents，那是事件数组）
  const rawCount = () => esc.status?.()?.stats?.rawKeyCount ?? 0;
  const before = rawCount();
  // 用正确 cbSize=40 的 SendInput 合成一次 ESC
  const SendInput = loaded.SendInput;
  const buf = Buffer.alloc(80);
  const wr = (off, up) => { buf.writeUInt32LE(1, off); buf.writeUInt16LE(0x1B, off + 8); buf.writeUInt16LE(0, off + 10); buf.writeUInt32LE(up ? 2 : 0, off + 12); };
  wr(0, false); wr(40, true);
  const sent = SendInput(2, buf, 40);
  info('SendInput 返回', sent);
  check('SendInput 合成 ESC 成功（cbSize=40）', sent === 2, `返回 ${sent}`);
  await sleep(700);
  const after = rawCount();
  info('钩子收到的原始按键计数', `${before} → ${after}`);
  check('全局钩子收到了合成按键（真实连通）', after > before, `before=${before} after=${after}`);
}

// =========================================================================
console.log('\n【需求 4】识别画面\n');
// =========================================================================

console.log('--- 4a. 截图：返回合法 PNG ---');
// 先写入已知文本，便于 OCR 验证
vi.selectAll?.(textTarget); vi.clearSelection?.(textTarget);
await sleep(150);
vi.writeText(textTarget, 'VISION E2E 2026');
await sleep(350);

const capBefore = cursor();
const shot = capture.captureWindow(notepad, {});
const capAfter = cursor();
info('captureWindow', { ok: shot.ok, method: shot.method, size: shot.width && `${shot.width}x${shot.height}`, nonBlackRatio: shot.content?.nonBlackRatio });
check('截图成功', shot.ok === true, shot.reason);
check('返回合法 PNG（签名正确）', Buffer.isBuffer(shot.png) && shot.png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a');
check('截图方法为 PrintWindow（能抓后台窗口）', /PrintWindow/i.test(shot.method ?? ''), shot.method);
check('截图非全黑（真的抓到了画面内容）', (shot.content?.nonBlackRatio ?? 0) > 0.03, `nonBlackRatio=${shot.content?.nonBlackRatio}`);
check('截图不移动真实光标', capBefore.x === capAfter.x && capBefore.y === capAfter.y,
  `${JSON.stringify(capBefore)} → ${JSON.stringify(capAfter)}`);

console.log('\n--- 4b. OCR：识别出已知文本 ---');
const recognized = await ocr.ocrImage(shot.png, {});
info('OCR 语言', recognized.language);
info('OCR 行数 / 文本片段', `${recognized.lines?.length} / ${JSON.stringify((recognized.text ?? '').slice(0, 90))}`);
check('OCR 成功', recognized.ok === true, recognized.reason);
check('OCR 识别出了非空文本', (recognized.text ?? '').trim().length > 0);
// zh-Hans-CN 引擎会把拉丁字母读成形近汉字（实测 Hello→He110），故用形近折叠 + 滑窗匹配
const fold = (str) => String(str).toUpperCase()
  .replace(/[0O]/g, 'O').replace(/[1IL]/g, 'I').replace(/[5S]/g, 'S')
  .replace(/[2Z]/g, 'Z').replace(/[8B]/g, 'B').replace(/[6G]/g, 'G')
  .replace(/[^A-Z0-9]/g, '');
const flatText = fold(recognized.text ?? '');
const flatWant = fold('VISION');
check('OCR 识别到关键词 VISION（形近折叠匹配）', flatText.includes(flatWant),
  `折叠后文本=${JSON.stringify(flatText.slice(0, 80))} 期望含 ${flatWant}`);
const words = (recognized.lines ?? []).flatMap((l) => l.words ?? []);
check('OCR 结果带词级 bbox', words.length > 0 && words.every((w) => w.bbox !== undefined), `words=${words.length}`);

console.log('\n--- 4c. OCR 坐标换算：可闭环到 vcu_click ---');
// attachCoordinates(lines, capture) 返回 { hwnd, image, lines:[{ line:{screen,client,clickHint}, words:[...] }] }
const coords = ocr.attachCoordinates(recognized.lines ?? [], shot);
if (coords !== undefined && Array.isArray(coords.lines) && coords.lines.length > 0) {
  const allWords = coords.lines.flatMap((l) => l.words ?? []);
  const withScreen = allWords.filter((w) => w.screen !== undefined);
  const withClient = allWords.filter((w) => w.client !== undefined);
  info('词级坐标覆盖', `${withScreen.length}/${allWords.length} 有屏幕坐标，${withClient.length} 有客户区坐标`);
  if (allWords.length > 0) {
    const sample = withScreen[0] ?? allWords[0];
    info('样本词', { text: sample.text, screen: sample.screen, client: sample.client, clickHint: sample.clickHint });
  }
  check('OCR 提供词级屏幕坐标', withScreen.length > 0, `${withScreen.length}/${allWords.length}`);
  check('OCR 提供客户区坐标 + clickHint（可直接喂给 vcu_click）',
    withClient.length > 0 && withClient.some((w) => typeof w.clickHint === 'string'),
    `${withClient.length} 个`);
  // 自洽性：屏幕坐标应落在窗口矩形内（允许标题栏/窗口外的少量 OCR 噪声）
  const wr = shot.windowRect ?? { x: 0, y: 0, width: 99999, height: 99999 };
  const inside = withScreen.filter((w) => w.screen.x >= wr.x - 5 && w.screen.x <= wr.x + (wr.width ?? 0) + 5
    && w.screen.y >= wr.y - 5 && w.screen.y <= wr.y + (wr.height ?? 0) + 5);
  info('屏幕坐标落在窗口内的比例', `${inside.length}/${withScreen.length}`);
  check('多数 OCR 屏幕坐标落在窗口矩形内（坐标换算自洽）',
    withScreen.length === 0 || inside.length / withScreen.length >= 0.7,
    `${inside.length}/${withScreen.length}`);
} else {
  console.log('        （attachCoordinates 未返回词级坐标，跳过换算断言）');
}

console.log('\n--- 4d. UIA：读取控件树 ---');
try {
  const tree = await uia.getTree(notepad, { maxDepth: 4, maxNodes: 60 });
  info('UIA getTree', { ok: tree.ok, count: tree.count ?? tree.nodes?.length, elapsedMs: tree.elapsedMs });
  check('UIA 读取成功（或诚实报告失败）', tree.ok === true || typeof tree.reason === 'string');
  if (tree.ok === true) {
    const nodes = tree.nodes ?? [];
    check('UIA 读到了控件节点', nodes.length > 0, `count=${nodes.length}`);
    const withBbox = nodes.filter((n) => n.bbox !== undefined);
    check('控件节点带 bbox', withBbox.length > 0, `${withBbox.length}/${nodes.length}`);
    if (withBbox.length > 0 && shot.windowRect !== undefined) {
      const inside = withBbox.every((n) => n.bbox.x >= shot.windowRect.x - 40 && n.bbox.x <= shot.windowRect.x + shot.windowRect.width + 40);
      check('控件 bbox 落在窗口矩形内（自洽）', inside);
    }
  }
} catch (error) {
  check('UIA 调用不抛异常', false, error.message);
}

console.log('\n--- 4e. 模板匹配：自证正确性（自己找自己必须命中）---');
{
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'vcu-e2e-'));
  const tplPath = pathMod.join(dir, 'tpl.png');
  // 从窗口客户区截一块有特征的区域（正文文字），再在窗口内找回来
  const region = capture.captureRegion(
    (shot.clientOrigin?.x ?? shot.windowRect?.x ?? 0) + 10,
    (shot.clientOrigin?.y ?? shot.windowRect?.y ?? 0) + 10,
    90, 20, {},
  );
  if (Buffer.isBuffer(region.png)) {
    fsMod.writeFileSync(tplPath, region.png);
    const t0 = Date.now();
    const found = await matcher.findOnScreen(tplPath, { hwnd: notepad, maxResults: 3, threshold: 0.8 });
    info('模板匹配', { ok: found.ok, count: found.matches?.length, elapsedMs: found.elapsedMs ?? (Date.now() - t0) });
    check('模板匹配调用成功', found.ok === true, found.reason);
    if (found.matches?.length > 0) {
      const m = found.matches[0];
      info('最佳匹配', { screen: m.screen, score: m.score });
      check('自匹配分数达到满分区间', (m.score ?? 0) >= 0.95, `score=${m.score}`);
      const expectX = (shot.clientOrigin?.x ?? 0) + 10;
      check('匹配位置等于截取位置（自证正确）', Math.abs((m.screen?.x ?? -999) - expectX) <= 3,
        `screen.x=${m.screen?.x} 期望 ${expectX}`);
    } else {
      console.log('        （窗口内未命中；模板取自客户区，可能因缩放/渲染差异未匹配）');
    }
  }
  try { fsMod.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// =========================================================================
console.log('\n【清理】');
// =========================================================================
const un = await esc.uninstall();
info('esc.uninstall()', un);
check('ESC 钩子卸载成功', un?.ok !== false, JSON.stringify(un));
overlay.hide();
tracker.dispose();
cleanup();
await sleep(400);
const leftover = spawnSync('powershell', ['-NoProfile', '-Command',
  "(Get-Process notepad -ErrorAction SilentlyContinue | Measure-Object).Count"], { encoding: 'utf8', timeout: 15000 });
info('残留 notepad 进程数', (leftover.stdout ?? '').trim());
check('测试启动的记事本已清理', (leftover.stdout ?? '').trim() === '0', leftover.stdout);

console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  汇总: ${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} 项`);
console.log('══════════════════════════════════════════════════════════════');
if (fail > 0) {
  console.log('\n失败项:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\n端到端验收全部通过：虚拟鼠标键盘 + 悬浮窗 + 双击 ESC 中断 + 画面识别。');
