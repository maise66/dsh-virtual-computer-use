/**
 * 集成契约验证：template-match.findOnScreen 依赖 lib/capture.js 的实际返回形状。
 *
 * uia-dev 明确说他写测试时 capture.js 还在被队友修改，所以这个契约**未被端到端验证**，
 * 他做了多形状兜底但请我在集成阶段确认。这正是跨模块最容易出问题的地方
 * （两边各自测试都过，合起来才发现字段名不一致）。
 *
 * 本测试把契约**显式断言**出来，并做真正的端到端验证：抓屏 → 存模板 → 找回来。
 */
import * as capture from '../lib/capture.js';
import * as matcher from '../lib/template-match.js';
import { loadWin32 } from '../lib/native.js';

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('=== 1. capture.js 的返回契约（template-match 依赖它）===');
const shot = capture.captureVirtualScreen({ maxWidth: 800 });
console.log('  captureVirtualScreen 返回的字段:', Object.keys(shot ?? {}).join(', '));
check('captureVirtualScreen().ok === true', shot.ok === true, shot.reason);
check('返回 png 且是 Buffer', Buffer.isBuffer(shot.png), `got ${typeof shot.png}`);
check('返回 width/height（数字）', Number.isInteger(shot.width) && Number.isInteger(shot.height), `${shot.width}x${shot.height}`);
// template-match 需要知道抓取区域在屏幕上的原点，才能把匹配坐标换算成屏幕坐标。
// 实际字段名是 screenOrigin（实测），不是 origin。
check('返回 screenOrigin 供坐标换算', shot.screenOrigin !== undefined
  && Number.isInteger(shot.screenOrigin.x) && Number.isInteger(shot.screenOrigin.y),
  `keys=${Object.keys(shot).join(',')}`);
check('返回 scale 供缩放补偿', Number.isFinite(shot.scale), `scale=${shot.scale}`);
console.log(`  screenOrigin: ${JSON.stringify(shot.screenOrigin)} | scale=${shot.scale} | ${shot.width}x${shot.height}`);

console.log('\n=== 1b. 各抓取函数的原点字段（跨模块契约的真实形状）===');
// 不同抓取函数把原点放在不同字段里，这是 findOnScreen 必须兼容的地方。
const regionShot = capture.captureRegion(500, 400, 100, 80, {});
check('captureRegion 用 region 承载原点', regionShot.region?.x === 500 && regionShot.region?.y === 400,
  JSON.stringify(regionShot.region));
check('captureRegion 不提供 screenOrigin（与上一行形成对照）', regionShot.screenOrigin === undefined,
  JSON.stringify(regionShot.screenOrigin));
const lister = await import('../lib/windows.js');
const win = lister.listWindows({ visibleOnly: true, withTitleOnly: true }).windows[0];
const winShot = capture.captureWindow(win.hwnd, {});
check('captureWindow 用 windowRect 承载原点', winShot.windowRect !== undefined && Number.isInteger(winShot.windowRect.x),
  JSON.stringify(winShot.windowRect));
console.log(`  captureRegion→region(${regionShot.region.x},${regionShot.region.y})`
  + ` | captureWindow→windowRect(${winShot.windowRect.x},${winShot.windowRect.y})`
  + ` | captureVirtualScreen→screenOrigin(${shot.screenOrigin.x},${shot.screenOrigin.y})`);

console.log('\n=== 2. captureRegion 的契约（findOnScreen 用 searchRegion 时会走它）===');
const region = capture.captureRegion(100, 100, 320, 240, {});
console.log('  captureRegion 返回:', JSON.stringify({
  ok: region.ok, width: region.width, height: region.height,
  pngIsBuffer: Buffer.isBuffer(region.png), origin: region.origin, region: region.region,
}));
check('captureRegion().ok === true', region.ok === true, region.reason);
check('captureRegion 返回合法 PNG Buffer', Buffer.isBuffer(region.png) && matcher.isPng(region.png));
check('captureRegion 尺寸精确匹配请求', region.width === 320 && region.height === 240, `${region.width}x${region.height}`);

console.log('\n=== 3. 端到端：抓屏 → 存模板 → findOnScreen 找回（契约闭环）===');
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcu-contract-'));
const templatePath = path.join(tmpDir, 'tpl.png');

try {
  const saved = await matcher.saveTemplateFromRegion(60, 60, 120, 40, templatePath, {});
  console.log('  saveTemplateFromRegion 返回:', JSON.stringify({ ok: saved.ok, path: saved.path, width: saved.width, height: saved.height, reason: saved.reason }));
  check('saveTemplateFromRegion 成功', saved.ok === true, saved.reason);
  check('模板文件确实写到磁盘', fs.existsSync(templatePath));
} catch (error) {
  check('saveTemplateFromRegion 不抛异常', false, error.message);
}

if (fs.existsSync(templatePath)) {
  const found = await matcher.findOnScreen(templatePath, { maxResults: 3, threshold: 0.9 });
  console.log('  findOnScreen 返回:', JSON.stringify({
    ok: found.ok, count: found.matches?.length, elapsedMs: found.elapsedMs,
    miss: found.matches?.[0], reason: found.reason,
  }));
  check('findOnScreen().ok === true（契约打通）', found.ok === true, found.reason);
  const first = found.matches?.[0];
  check('至少找到 1 个匹配', (found.matches?.length ?? 0) >= 1);
  if (first !== undefined) {
    // === 关键回归：findOnScreen 曾把抓屏原点当成 (0,0) ===
    // 模板从 (60,60) 裁出，全屏抓取的原点是 (0,0)，所以 screen 应回到 (60,60)。
    check('回归：匹配位置等于截取位置（原点解析正确）',
      Math.abs(first.screen.x - 60) <= 2 && Math.abs(first.screen.y - 60) <= 2,
      `screen=(${first.screen?.x}, ${first.screen?.y}) 期望 (60,60)`);
    check('匹配分数达到满分区间', (first.score ?? 0) >= 0.99, `score=${first.score}`);
    check('center 由 screen + 半个模板算得', first.center !== undefined
      && Math.abs(first.center.x - (first.screen.x + 60)) <= 1, JSON.stringify(first.center));
  }

  // === 关键回归：hwnd 支持（工具的搜索窗口参数曾完全没有生效）===
  const target = lister.listWindows({ visibleOnly: true, withTitleOnly: true }).windows[0];
  const inWindow = await matcher.findOnScreen(templatePath, { hwnd: target.hwnd, maxResults: 2, threshold: 0.85 });
  console.log(`  findOnScreen({hwnd: ${target.hwnd}}) → ok=${inWindow.ok} capture.origin=${JSON.stringify(inWindow.capture?.origin)} capture.hwnd=${inWindow.capture?.hwnd}`);
  check('hwnd 选项被真正使用（capture.hwnd 回传）', inWindow.ok !== true || inWindow.capture?.hwnd === target.hwnd,
    JSON.stringify(inWindow.capture));
  if (inWindow.ok === true && inWindow.matches?.length > 0) {
    const m = inWindow.matches[0];
    // 窗口内匹配必须落在窗口矩形内（自洽性）
    const wr = target.rect;
    const inside = m.screen.x >= wr.x - 2 && m.screen.x <= wr.x + wr.width + 2
      && m.screen.y >= wr.y - 2 && m.screen.y <= wr.y + wr.height + 2;
    check('窗口内匹配坐标落在窗口矩形内（自洽）', inside,
      `screen=(${m.screen.x},${m.screen.y}) window=(${wr.x},${wr.y},${wr.width}x${wr.height})`);
  } else {
    console.log('  （该窗口内未找到模板，属正常——模板是全屏某处的图案）');
  }
}

// 清理临时目录
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('\n=== 4. 静态契约：template-match 是否正确 import capture ===');
const tmSrc = fs.readFileSync(new URL('../lib/template-match.js', import.meta.url), 'utf8');
check('template-match 动态 import ./capture.js', /import\(\s*['"]\.\/capture\.js['"]/.test(tmSrc));
// 确认它没有静态顶层 import（否则 capture.js 缺失时连纯离线匹配都不可用）
const hasStaticImport = /^import\s.*from\s+['"]\.\/capture\.js['"]/m.test(tmSrc);
check('没有静态顶层 import capture.js（保留离线可用性）', hasStaticImport === false);

console.log('\n=== 5. uia.js 的只读性（不应含写操作）===');
const uiaSrc = fs.readFileSync(new URL('../lib/uia.js', import.meta.url), 'utf8');
const uiaCode = uiaSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('uia.js 未实现 invokeElement（只读，职责不重叠）', uiaCode.includes('function invokeElement') === false);
console.log('  （若将来要加结构化调用，应在 tools 层标注"会抢焦点"再暴露）');

console.log(`\n=== 汇总: ${pass} 通过 / ${fail} 失败 ===`);
if (fail > 0) { console.log('失败项:', failures.join(' | ')); process.exit(1); }
console.log('跨模块契约验证全部通过。');
