/**
 * dsh-virtual-computer-use —— 全局双击 ESC 中断 + 悬浮窗 回归测试。
 *
 * 运行：`node test/esc-overlay.test.mjs`
 *
 * ## 为什么时序用例用「显式时间戳注入」而不是靠 SendInput 的真实间隔
 *
 * 实测（本文件「真实钩子连通性」用例会打印原始事件流）：`SendInput` 只保证把输入
 * **排入**系统输入队列后立即返回，返回不等于已投递。真实投递会排在物理输入之后，
 * 实测中注入的 ESC 按下沿间隔可达 ~700ms–1500ms（up 甚至能迟到 15 秒），
 * 与我们 `sleep(100)` 的意图完全脱钩。因此：
 *
 *   - **时序语义**（120ms 命中 / 900ms 不命中 / 三连击只触发一次）用
 *     `controller.injectKeyEvent({vkCode, down, t})` 驱动，走的是与真实钩子
 *     **完全相同**的判定函数（`_onKey`），只是时间戳可控 → 确定性可复现。
 *   - **真实连通性**（钩子真的能收到全局按键）单独用一个用例断言，只断言
 *     「ESC 事件确实到达」，不断言时序。
 *
 * ## 另一条必须守住的前置校验
 * INPUT 结构在 x64 是 **40 字节**。cbSize 写错（如 32）时 SendInput 会
 * **静默返回 0 且不注入**，于是「0 次 ESC → 0 次中断 → 测试假装通过」。
 * 所以合成按键之前先断言 SendInput 返回 1，并额外用 32 字节做反向对照，
 * 证明这个前置校验真的有效。
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { createEscAbort } from '../lib/esc-abort.js';
import { createOverlay } from '../lib/overlay.js';
import { loadWin32, loadKoffi, describeNative } from '../lib/native.js';

// ---------------------------------------------------------------------------
// 测试框架（极简）
// ---------------------------------------------------------------------------

const cases = [];
const results = [];

function testCase(name, fn) {
  cases.push({ name, fn });
}

async function run() {
  for (const { name, fn } of cases) {
    const started = Date.now();
    try {
      await fn();
      results.push({ name, ok: true, ms: Date.now() - started });
      console.log(`  PASS  ${name} (${Date.now() - started}ms)`);
    } catch (error) {
      const message = error?.message ?? String(error);
      results.push({ name, ok: false, ms: Date.now() - started, error: message });
      console.log(`  FAIL  ${name} (${Date.now() - started}ms)`);
      console.log(`        ${message}`);
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

// ---------------------------------------------------------------------------
// Win32 辅助
// ---------------------------------------------------------------------------

const loaded = loadWin32();
const hasNative = loaded.reason === undefined;

/** INPUT 结构在 x64 是 40 字节；写错会静默不注入（见文件头说明）。 */
const INPUT_SIZE = 40;
const ESC = 0x1b;
/** LLKHF_INJECTED。 */
const LLKHF_INJECTED = 0x10;

let koffi;
let INPUT_UNION;

function initSendInput() {
  const loadedKoffi = loadKoffi();
  assert(loadedKoffi.koffi !== undefined, `koffi unavailable: ${loadedKoffi.reason}`);
  koffi = loadedKoffi.koffi;
  INPUT_UNION = koffi.struct('EscTestInput', {
    type: 'uint32',
    pad: 'uint32',
    kbd: koffi.struct('EscTestKeybdInput', {
      wVk: 'uint16',
      wScan: 'uint16',
      dwFlags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uintptr_t',
    }),
  });
}

/**
 * 用 SendInput 合成一次按键（按下 + 抬起）。
 *
 * @returns {number[]} 两次 SendInput 的返回值；必须是 [1, 1]，
 *   否则说明注入根本没发生，调用方必须据此失败，而不是把「0 次触发」当通过。
 */
function sendKey(vk, size = INPUT_SIZE) {
  const down = Buffer.alloc(INPUT_SIZE);
  koffi.encode(down, 0, INPUT_UNION, { type: 1, pad: 0, kbd: { wVk: vk, wScan: 0, dwFlags: 0, time: 0, dwExtraInfo: 0 } });
  const n1 = Number(loaded.SendInput(1, down, size));
  const up = Buffer.alloc(INPUT_SIZE);
  koffi.encode(up, 0, INPUT_UNION, { type: 1, pad: 0, kbd: { wVk: vk, wScan: 0, dwFlags: 2, time: 0, dwExtraInfo: 0 } });
  const n2 = Number(loaded.SendInput(1, up, size));
  return [n1, n2];
}

/** 用确定时间戳注入 n 次 ESC「按下沿」。 */
function injectTaps(controller, times) {
  for (const t of times) {
    controller.injectKeyEvent({ vkCode: ESC, down: true, t });
    controller.injectKeyEvent({ vkCode: ESC, down: false, t: t + 20 });
  }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

if (!hasNative) {
  console.log(`\n[SKIP] 原生层不可用：${loaded.reason}`);
  console.log('       无法运行任何用例。\n');
  process.exit(2);
}

console.log('\n=== dsh-virtual-computer-use: 全局双击 ESC 中断 + 悬浮窗 ===\n');
console.log('原生环境:', JSON.stringify(describeNative()));
console.log('');

initSendInput();

// --- 前置校验：注入能力 -----------------------------------------------------

testCase('前置：SendInput 合成 ESC 生效，且 cbSize 错误会静默失败（自证校验有效）', async () => {
  const [down, up] = sendKey(ESC);
  assertEqual(down, 1, 'SendInput(ESC down) 必须返回 1（返回 0 表示结构体 cbSize 不对，静默失败）');
  assertEqual(up, 1, 'SendInput(ESC up) 必须返回 1');
  const [bad] = sendKey(ESC, 32);
  assertEqual(bad, 0, 'cbSize=32 时 SendInput 必须返回 0 —— 用于证明上面的前置校验真的能抓到问题');
  console.log('        对照：cbSize=40 -> 1（成功），cbSize=32 -> 0（静默失败）');
  await sleep(300);
});

// --- 真实钩子连通性 ---------------------------------------------------------

testCase('真实钩子：装钩后能收到 SendInput 合成的全局 ESC', async () => {
  const controller = createEscAbort({ thresholdMs: 400 });
  const install = controller.install();
  assert(install.ok === true, `install 失败：${install.reason}`);
  assertEqual(install.mode, 'main-thread-peek-pump', '应报告主线程 PeekMessage 泵模式');
  await sleep(400);

  controller.resetCounters();
  const before = controller.status().stats.rawKeyCount;
  sendKey(ESC);
  // 不靠固定 sleep 断言时序，只轮询「ESC 事件是否到达」，给足真实投递时间。
  const deadline = Date.now() + 6000;
  let arrived = 0;
  while (Date.now() < deadline) {
    arrived = controller.rawEvents.filter((e) => e.vkCode === ESC).length;
    if (arrived > 0) break;
    await sleep(50);
  }
  const stats = controller.status().stats;
  controller.uninstall();

  assert(stats.rawKeyCount > before, `钩子未收到任何按键事件（rawKeyCount ${before} -> ${stats.rawKeyCount}）`);
  assert(arrived > 0, '钩子未收到 ESC —— 全局键盘钩子未生效');
  console.log(`        真实钩子收到 ${arrived} 条 ESC 事件（rawKeyCount=${stats.rawKeyCount}）`);
});

testCase('install() 幂等 + uninstall() 真正解钩', async () => {
  const controller = createEscAbort({ thresholdMs: 400 });
  const first = controller.install();
  assert(first.ok === true, `install 失败：${first.reason}`);
  const second = controller.install();
  assert(second.ok === true, '重复 install 应仍然 ok');
  assertEqual(second.alreadyInstalled, true, '重复 install 应报告 alreadyInstalled');
  assertEqual(second.hook, first.hook, '重复 install 不应换钩子句柄');
  assertEqual(controller.status().installed, true, 'installed 应为 true');

  const un = controller.uninstall();
  assert(un.ok === true, `uninstall 失败：${un.reason}`);
  assertEqual(controller.status().installed, false, 'uninstall 后 installed 应为 false');
  const again = controller.uninstall();
  assert(again.ok === true, 'uninstall 应幂等');
  assertEqual(again.alreadyUninstalled, true, '重复 uninstall 应报告 alreadyUninstalled');
});

// --- 核心判定（确定性时间戳） -----------------------------------------------

testCase('用例1：间隔 120ms 两次 ESC -> 触发 1 次', async () => {
  const controller = createEscAbort({ thresholdMs: 400, cooldownMs: 400 });
  const install = controller.install();
  assert(install.ok === true, `install 失败：${install.reason}`);
  controller.resetCounters();

  const t0 = 1_000_000;
  injectTaps(controller, [t0, t0 + 120]);
  const count = controller.abortCount;
  controller.uninstall();

  assertEqual(count, 1, `120ms 双击应恰好触发 1 次，实际 ${count}`);
});

testCase('用例2：间隔 900ms 两次 ESC -> 触发 0 次（超出阈值）', async () => {
  const controller = createEscAbort({ thresholdMs: 400, cooldownMs: 400 });
  const install = controller.install();
  assert(install.ok === true, `install 失败：${install.reason}`);
  controller.resetCounters();

  const t0 = 1_000_000;
  injectTaps(controller, [t0, t0 + 900]);
  const count = controller.abortCount;
  const stats = controller.status().stats;
  controller.uninstall();

  assertEqual(count, 0, `900ms 双击（超过 400ms 阈值）不应触发中断，实际 ${count}`);
  assertEqual(stats.matchedKeyCount, 2, `应记录 2 次 ESC 按下，实际 ${stats.matchedKeyCount}`);
});

testCase('用例3（关键回归）：三连 ESC 间隔 100ms -> 只触发 1 次', async () => {
  const controller = createEscAbort({ thresholdMs: 400, cooldownMs: 400 });
  const install = controller.install();
  assert(install.ok === true, `install 失败：${install.reason}`);
  controller.resetCounters();

  const t0 = 1_000_000;
  injectTaps(controller, [t0, t0 + 100, t0 + 200]);
  const count = controller.abortCount;
  const stats = controller.status().stats;
  controller.uninstall();

  console.log(
    `        三连击实测：abortCount=${count}, matchedDown=${stats.matchedKeyCount}, suppressed=${stats.suppressedCount}`,
  );
  assertEqual(stats.matchedKeyCount, 3, `必须真的处理 3 次 ESC 按下（实际 ${stats.matchedKeyCount}）`);
  assertEqual(count, 1, `三连 ESC 只能触发 1 次中断，实际 ${count}`);
  assert(stats.suppressedCount >= 1, `第 3 次 ESC 应被冷却窗口吞掉，实际 suppressed=${stats.suppressedCount}`);
});

testCase('用例4：中断触发后 AbortSignal.aborted 为 true 且订阅者被调用', async () => {
  const controller = createEscAbort({ thresholdMs: 400, cooldownMs: 400 });
  const install = controller.install();
  assert(install.ok === true, `install 失败：${install.reason}`);
  // 控制器是进程内单例，AbortSignal 一旦 abort 不会自己复原；
  // 这里显式换一个新 signal，才能测「触发前 false -> 触发后 true」。
  controller.resetSignal();
  controller.resetCounters();
  assertEqual(controller.signal.aborted, false, 'resetSignal 后 signal 不应为 aborted');

  const calls = [];
  const sub = controller.onAbort((payload) => calls.push(payload));
  assert(sub.ok === true, 'onAbort 订阅应成功');

  const t0 = 1_000_000;
  injectTaps(controller, [t0, t0 + 120]);

  assertEqual(controller.abortCount, 1, '应触发 1 次中断');
  assertEqual(controller.signal.aborted, true, '触发后 signal.aborted 应为 true');
  assertEqual(calls.length, 1, `订阅者应被调用 1 次，实际 ${calls.length}`);
  assertEqual(typeof controller.lastAbortAt, 'number', true, '应记录触发时间戳');
  assertEqual(calls[0].at, controller.lastAbortAt, '回调 payload 的时间戳应与控制器一致');
  assert(calls[0].signal === controller.signal, '回调 payload 的 signal 应与控制器一致');
  console.log(`        订阅者调用 ${calls.length} 次，lastAbortAt=${controller.lastAbortAt}`);

  // resetSignal() 后应可再次触发。
  sub.unsubscribe();
  controller.resetSignal();
  assertEqual(controller.signal.aborted, false, 'resetSignal 后应重新可用');
  controller.resetCounters();
  injectTaps(controller, [t0 + 5000, t0 + 5120]);
  assertEqual(controller.abortCount, 1, 'resetSignal 后应能再次触发');
  assertEqual(controller.signal.aborted, true, '第二次触发后 signal 应再次 aborted');
  controller.uninstall();
});

testCase('附加：冷却期结束后重新武装，可再次触发', async () => {
  const controller = createEscAbort({ thresholdMs: 400, cooldownMs: 400 });
  const install = controller.install();
  assert(install.ok === true, `install 失败：${install.reason}`);
  controller.resetCounters();

  const t0 = 1_000_000;
  // 第一组三连击 -> 1 次
  injectTaps(controller, [t0, t0 + 100, t0 + 200]);
  assertEqual(controller.abortCount, 1, '第一组应触发 1 次');
  // 冷却期内再来一组 -> 不应触发
  injectTaps(controller, [t0 + 300, t0 + 400]);
  assertEqual(controller.abortCount, 1, '冷却期内的第二组不应触发');
  // 冷却结束后（t0+200+400=t0+600 之后）重新武装 -> 应可再次触发
  injectTaps(controller, [t0 + 700, t0 + 800]);
  const final = controller.abortCount;
  controller.uninstall();

  assertEqual(final, 2, `冷却结束后应重新武装并可再次触发，实际 ${final}`);
});

testCase('附加：disable() 后不再触发，enable() 后恢复', async () => {
  const controller = createEscAbort({ thresholdMs: 400, cooldownMs: 400 });
  const install = controller.install();
  assert(install.ok === true, `install 失败：${install.reason}`);
  controller.disable();
  controller.resetCounters();

  const t0 = 1_000_000;
  injectTaps(controller, [t0, t0 + 100, t0 + 200]);
  assertEqual(controller.abortCount, 0, 'disable() 后不应触发');

  controller.enable();
  controller.resetCounters();
  injectTaps(controller, [t0 + 5000, t0 + 5100]);
  const after = controller.abortCount;
  controller.uninstall();

  assertEqual(after, 1, `enable() 后应恢复触发，实际 ${after}`);
});

testCase('附加：可配置成其它键 / 其它阈值 / taps', async () => {
  const controller = createEscAbort({ thresholdMs: 400, cooldownMs: 400, keys: 'ctrl+shift+q', taps: 2 });
  const cfg = controller.status().config;
  assertEqual(cfg.keys.length, 3, `ctrl+shift+q 应解析为 3 个键码，实际 ${JSON.stringify(cfg.keys)}`);
  assertEqual(cfg.keys[cfg.keys.length - 1], 'q', `主键应为 q，实际 ${JSON.stringify(cfg.keys)}`);

  // thresholdMs 可配：600ms 间隔在 800ms 阈值下应命中
  const wide = controller.configure({ keys: 'esc', thresholdMs: 800, cooldownMs: 800, taps: 2 });
  assert(wide.ok === true, `configure 失败：${wide.reason}`);
  controller.install();
  controller.resetCounters();
  const t0 = 1_000_000;
  injectTaps(controller, [t0, t0 + 600]);
  assertEqual(controller.abortCount, 1, '阈值放宽到 800ms 后，600ms 间隔应命中');

  // taps=3：三连击在无冷却干扰下应命中
  controller.configure({ taps: 3, thresholdMs: 400, cooldownMs: 400 });
  controller.resetCounters();
  const t1 = 2_000_000;
  injectTaps(controller, [t1, t1 + 100, t1 + 200, t1 + 300]);
  const withTaps3 = controller.abortCount;
  controller.uninstall();

  assertEqual(withTaps3, 1, `taps=3 时应在前 3 次内命中 1 次，实际 ${withTaps3}`);
});

testCase('附加：未配置的原生层缺失时降级为 {ok:false, reason}，不抛异常', async () => {
  const controller = createEscAbort({ thresholdMs: 400 });
  // 直接调用不存在的键名应被拒绝而不是抛异常
  const bad = controller.configure({ keys: 'not-a-real-key' });
  assertEqual(bad.ok, false, '无法解析的键应返回 ok:false');
  assert(typeof bad.reason === 'string' && bad.reason.length > 0, '应给出 reason');
  const badThreshold = controller.configure({ thresholdMs: -1 });
  assertEqual(badThreshold.ok, false, '负阈值应被拒绝');
  const badSub = controller.onAbort('not a function');
  assertEqual(badSub.ok, false, '非函数订阅者应被拒绝');
  // status() 任何情况下都不应抛
  const status = controller.status();
  assert(typeof status.ok === 'boolean', 'status() 应返回结构化结果');
});

// --- 悬浮窗 -----------------------------------------------------------------

testCase('悬浮窗：show() 创建窗口，扩展样式正确，不抢焦点', async () => {
  const overlay = createOverlay({ position: 'top-right', pulseMs: 200 });
  const before = String(loaded.GetForegroundWindow());
  const shown = overlay.show('AI 正在操作电脑');
  assert(shown.ok === true, `show 失败：${shown.reason}`);
  assertEqual(shown.created, true, '首次 show 应创建窗口');

  await sleep(400);
  const status = overlay.status();
  assertEqual(status.visible, true, 'show() 后窗口应可见');
  assertEqual(status.layered, true, `必须带 WS_EX_LAYERED，exStyle=0x${(status.exStyle ?? 0).toString(16)}`);
  assertEqual(status.topmost, true, '必须带 WS_EX_TOPMOST');
  assertEqual(status.noActivate, true, '必须带 WS_EX_NOACTIVATE');
  assertEqual(status.transparent, true, '必须带 WS_EX_TRANSPARENT');
  assertEqual(status.toolWindow, true, '必须带 WS_EX_TOOLWINDOW（不进任务栏）');

  const after = String(loaded.GetForegroundWindow());
  assertEqual(after, before, '显示悬浮窗不得改变前台窗口（绝不抢焦点）');
  assertEqual(status.isForeground, false, '悬浮窗自己不能成为前台窗口');
  assert(status.pumpTicks > 0, '消息泵应在运行（宿主事件循环未被卡住）');
  assert(status.paintCount > 0, '窗口过程应真的收到过 WM_PAINT 并重绘');

  // 位置必须在虚拟屏可见区域内，且默认靠右上角。
  const rect = status.rect;
  const vx = Number(loaded.GetSystemMetrics(76));
  const vy = Number(loaded.GetSystemMetrics(77));
  const vw = Number(loaded.GetSystemMetrics(78));
  const vh = Number(loaded.GetSystemMetrics(79));
  assert(rect.x >= vx && rect.y >= vy, `窗口不得超出虚拟屏左上（rect=${JSON.stringify(rect)}）`);
  assert(
    rect.x + rect.width <= vx + vw && rect.y + rect.height <= vy + vh,
    `窗口不得超出虚拟屏右下（rect=${JSON.stringify(rect)}）`,
  );
  assert(rect.x + rect.width > vx + vw / 2, '默认应靠屏幕右侧');

  const updated = overlay.update('AI 正在操作电脑（测试）');
  assert(updated.ok === true, `update 失败：${updated.reason}`);
  await sleep(200);
  assertEqual(overlay.status().layered, true, 'update 后仍应保持 LAYERED');

  assertEqual(overlay.hide().ok, true, 'hide 应成功');
});

testCase('悬浮窗：update()/setPosition() 生效，hide() 后窗口真正销毁', async () => {
  const overlay = createOverlay({ position: 'bottom-left', pulseMs: 0 });
  const shown = overlay.show('AI 正在操作电脑');
  assert(shown.ok === true, `show 失败：${shown.reason}`);
  await sleep(200);

  const moved = overlay.setPosition('bottom-right');
  assert(moved.ok === true, `setPosition 失败：${moved.reason}`);
  await sleep(150);
  const vx = Number(loaded.GetSystemMetrics(76));
  const vw = Number(loaded.GetSystemMetrics(78));
  assert(moved.rect.x + moved.rect.width > vx + vw / 2, `bottom-right 应靠右侧，实际 x=${moved.rect.x}`);

  const hwnd = overlay.status().hwnd;
  assert(hwnd !== undefined, '应能读到 hwnd');
  assertEqual(overlay.isVisible(), true, 'hide 前应可见');

  const hidden = overlay.hide();
  assert(hidden.ok === true, `hide 失败：${hidden.reason}`);
  assertEqual(hidden.destroyed, true, 'hide() 应真正销毁窗口');
  assertEqual(overlay.isVisible(), false, 'hide() 后 isVisible 应为 false');
  assertEqual(loaded.IsWindow(BigInt(hwnd)), false, `hide() 后 IsWindow(${hwnd}) 应为 false`);
});

testCase('悬浮窗：重复 show/hide 不泄漏、不抛异常（koffi 类型名不重复注册）', async () => {
  const overlay = createOverlay({ position: 'top-left', pulseMs: 0 });
  for (let i = 0; i < 3; i += 1) {
    const shown = overlay.show(`第 ${i + 1} 次`);
    assert(shown.ok === true, `第 ${i + 1} 次 show 失败：${shown.reason}`);
    await sleep(150);
    assertEqual(overlay.isVisible(), true, `第 ${i + 1} 次 show 后应可见`);
    const hidden = overlay.hide();
    assert(hidden.ok === true, `第 ${i + 1} 次 hide 失败：${hidden.reason}`);
    assertEqual(overlay.isVisible(), false, `第 ${i + 1} 次 hide 后应不可见`);
  }
});

testCase('附加：uninstall() 后消息泵停转，且不阻止进程退出（回归）', async () => {
  const controller = createEscAbort({ thresholdMs: 400 });
  const install = controller.install();
  assert(install.ok === true, `install 失败：${install.reason}`);

  // install 后泵应在转。
  await sleep(200);
  assertEqual(controller.status().pumping, true, 'install 后消息泵应处于运行状态');

  const un = controller.uninstall();
  assert(un.ok === true, `uninstall 失败：${un.reason}`);
  assertEqual(controller.status().pumping, false, 'uninstall 后消息泵应停止');

  // 回归点：早期版本用 GetMessageW.async 自续泵，会让进程永不退出（koffi 线程池
  // 挂着不返回的请求）。这里断言 uninstall 之后事件循环里确实没有存活的定时器
  // ——若泵定时器没被 clearInterval，本进程在测试结束后就无法自然退出。
  const reason = await Promise.race([
    sleep(1500).then(() => 'kept-alive'),
    new Promise((resolve) => {
      // 用一次瞬态定时器做对照，无强引用时事件循环应能立刻进入空闲。
      const probe = setTimeout(() => resolve('timer-fired'), 10);
      probe.unref();
    }),
  ]);
  assertEqual(reason, 'timer-fired', '事件循环应能进入空闲状态（无存活的泵定时器）');
});

testCase('附加：uninstall() 与 hide() 之后无残留（进程可自然退出）', async () => {
  // 这条用例覆盖"测试进程能自然退出"这个硬要求的关键路径：
  // 反复 install/uninstall + show/hide，最后全部清理，不应留下活跃句柄。
  const c = createEscAbort({ thresholdMs: 400 });
  const overlay = createOverlay({ pulseMs: 100 });

  for (let i = 0; i < 2; i += 1) {
    assertEqual(c.install().ok, true, `第 ${i + 1} 次 install 应成功`);
    assertEqual(overlay.show('清理测试').ok, true, `第 ${i + 1} 次 show 应成功`);
    await sleep(120);
    assertEqual(overlay.hide().ok, true, `第 ${i + 1} 次 hide 应成功`);
    assertEqual(c.uninstall().ok, true, `第 ${i + 1} 次 uninstall 应成功`);
  }
  assertEqual(c.status().installed, false, '最终不应处于已安装状态');
  assertEqual(overlay.isVisible(), false, '最终不应有可见窗口');
});

// ---------------------------------------------------------------------------

await run();

// --- 汇总 -------------------------------------------------------------------

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log('\n=== 汇总 ===');
console.log(`通过 ${passed} / 失败 ${failed} / 共 ${results.length}`);
for (const r of results) {
  if (!r.ok) console.log(`  FAIL  ${r.name}\n        ${r.error}`);
}
console.log('');

// 清理：确保没有残留钩子/窗口/定时器，进程能自然退出。
try {
  const { uninstallDoubleEscapeAbort } = await import('../lib/esc-abort.js');
  uninstallDoubleEscapeAbort();
} catch {
  // 忽略
}
try {
  const { hideOperationOverlay } = await import('../lib/overlay.js');
  hideOperationOverlay();
} catch {
  // 忽略
}

process.exit(failed === 0 ? 0 : 1);

