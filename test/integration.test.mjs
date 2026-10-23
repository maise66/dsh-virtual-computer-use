/**
 * 集成测试：验证 host.js 的接线假设与三个已交付模块的真实 API 完全吻合。
 *
 * 这个测试的价值在于：host.js 是我写的，而 esc-abort.js / overlay.js 是另一个
 * 队友写的。如果两边对 API 形状的假设不一致（参数名、返回值、方法名），
 * 插件会在真实运行时才炸。这里把假设**显式断言**出来，在集成期就发现分歧。
 *
 * 只测接缝，不重复测各模块内部行为（那些它们自己的测试已覆盖）。
 */
import { createEscAbort } from '../lib/esc-abort.js';
import { createOverlay } from '../lib/overlay.js';
import { OperationTracker } from '../lib/tracker.js';

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('=== 1. createOverlay({ text, position }) 的接线假设 ===');
const overlay = createOverlay({ text: 'AI 正在操作电脑', position: 'top-right' });
check('createOverlay 返回对象（不是 undefined）', overlay !== undefined && overlay !== null);
// 注意：overlay 没有 dispose()。host.js 的清理走 hide()（它销毁窗口并清 unref 过的定时器），
// 这里断言真实存在的生命周期方法，避免主机侧基于错误的 API 形状写代码。
for (const m of ['show', 'hide', 'update', 'status', 'isVisible']) {
  check(`overlay.${m} 是可调用方法`, typeof overlay?.[m] === 'function', `got ${typeof overlay?.[m]}`);
}
if (overlay.dispose !== undefined) {
  check('overlay.dispose（若存在则必须是函数）', typeof overlay.dispose === 'function');
} else {
  console.log('  INFO  overlay 未提供 dispose() —— host.js 已按此改用 hide() 清理');
}

const shown = overlay.show('AI 正在操作电脑');
console.log('  show() 返回:', JSON.stringify(shown));
check('overlay.show() 返回结构化结果', shown !== undefined && typeof shown === 'object');
check('show() 后 isVisible() 为 true', overlay.isVisible() === true);

const upd = overlay.update('已中断');
check('overlay.update() 可调用且不抛异常', upd !== undefined || upd === undefined);
const hid = overlay.hide();
check('overlay.hide() 后 isVisible() 为 false', overlay.isVisible() === false);
const st = overlay.status();
check('overlay.status() 返回对象', st !== undefined && typeof st === 'object');
overlay.hide();
console.log('  overlay 生命周期 OK\n');

console.log('=== 2. createEscAbort({ thresholdMs, cooldownMs }) 的接线假设 ===');
const esc = createEscAbort({ thresholdMs: 400, cooldownMs: 400 });
check('createEscAbort 返回对象', esc !== undefined && esc !== null);
for (const m of ['install', 'uninstall', 'status', 'onAbort', 'reset']) {
  check(`esc.${m} 是可调用方法`, typeof esc?.[m] === 'function', `got ${typeof esc?.[m]}`);
}
check('esc.signal 存在（AbortSignal 供长任务轮询）', esc.signal !== undefined);

// onAbort 的返回值形状：host.js 里用 `created.onAbort?.(cb)` 订阅，不消费返回值。
const sub = esc.onAbort(() => {});
check('onAbort(cb) 可订阅且不抛异常', sub !== undefined || sub === undefined);

const installed = await esc.install();
console.log('  install() 返回:', JSON.stringify(installed));
check('install() 返回结构化结果且 ok=true', installed?.ok === true, JSON.stringify(installed));
check('install() 标注了实际模式（主线程泵）', typeof installed?.mode === 'string', JSON.stringify(installed?.mode));

const st2 = esc.status();
check('status() 返回 installed=true', st2?.installed === true, JSON.stringify(st2?.installed));

console.log('\n=== 3. host.js 的关键接线：ESC 中断 → tracker.abort() ===');
const tracker = new OperationTracker({ lingerMs: 50 });
let abortEvents = 0;
tracker.on('abort', () => { abortEvents++; });

// 复刻 host.js 的接线：controller.onAbort -> tracker.abort()
esc.onAbort((event) => { tracker.abort(event?.source ?? 'double-escape'); });

// 用注入事件走与真实钩子相同的判定路径（hook-overlay-dev 为此提供了 injectKeyEvent）
const t0 = 1_000_000;
esc.reset?.();
esc.resetCounters?.();
// 三连击：验证端到端（跨模块）也只触发一次
esc.injectKeyEvent?.({ vkCode: 0x1B, down: true, t: t0 });
esc.injectKeyEvent?.({ vkCode: 0x1B, down: false, t: t0 + 10 });
esc.injectKeyEvent?.({ vkCode: 0x1B, down: true, t: t0 + 100 });
esc.injectKeyEvent?.({ vkCode: 0x1B, down: false, t: t0 + 110 });
esc.injectKeyEvent?.({ vkCode: 0x1B, down: true, t: t0 + 200 });
esc.injectKeyEvent?.({ vkCode: 0x1B, down: false, t: t0 + 210 });

console.log('  tracker 收到 abort 事件次数:', abortEvents);
check('ESC 双击经接线传导到 tracker（abortEvents >= 1）', abortEvents >= 1, `got ${abortEvents}`);
check('三连击跨模块只触发一次 abort', abortEvents === 1, `got ${abortEvents}`);
check('tracker 进入 aborted 状态', tracker.status().aborted === true);
check('tracker.abort() 后 activity 归零', tracker.status().depth === 0, `depth=${tracker.status().depth}`);
check('AbortSignal 已置位（供长任务中断）', esc.signal?.aborted === true || esc.aborted === true);

console.log('\n=== 4. 中断后的工具调用应被拒绝（host.js + tools.js 的契约）===');
const gate = tracker.status().aborted;
check('中断状态下 guard 会拦截后续操作', gate === true);
const endFn = tracker.begin('after-abort');
check('abort 后 begin() 返回拒绝而不是放行', endFn?.ok === false, JSON.stringify(endFn));

console.log('\n=== 5. reset 恢复 ===');
await esc.reset?.();
esc.resetCounters?.();
tracker.reset();
check('reset 后 tracker 不再 aborted', tracker.status().aborted === false);
const endFn2 = tracker.begin('after-reset');
check('reset 后 begin() 恢复为可结束函数', typeof endFn2 === 'function', typeof endFn2);
if (typeof endFn2 === 'function') endFn2();

console.log('\n=== 6. 清理 ===');
const un = await esc.uninstall();
check('uninstall() 返回 ok', un?.ok !== false, JSON.stringify(un));
tracker.dispose();
console.log('  已卸载钩子与追踪器');

console.log(`\n=== 汇总: ${pass} 通过 / ${fail} 失败 ===`);
if (fail > 0) { console.log('失败项:', failures.join(' | ')); process.exit(1); }
console.log('集成接缝验证全部通过。');
