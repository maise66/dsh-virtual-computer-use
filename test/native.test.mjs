/**
 * native.js 回归测试。
 *
 * 覆盖两个曾经的真实缺陷：
 *   1. FillRect 曾绑在 gdi32（实际在 user32），它让整个绑定的 try 块抛错，
 *      导致**所有** Win32 能力失效。现在应当：FillRect 绑成功，且即使某个
 *      函数绑错，也只影响它自己。
 *   2. 独立 `node test/x.mjs` 进程里 process.execPath 指向 nodejs 安装目录，
 *      推导出的 koffi 路径不存在。现在应当能从标准安装位置找到 koffi。
 */
import { describeNative, loadWin32, loadKoffi, enumWindows, windowRect, EM, WM } from '../lib/native.js';
import { processImagePath } from '../lib/windows.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('=== 1. koffi 解析（独立 node 进程场景）===');
const koffi = loadKoffi();
console.log('  execPath:', process.execPath);
console.log('  koffi from:', koffi.from ?? '(未解析)');
check('koffi 可在独立 node 进程中解析', koffi.koffi !== undefined, koffi.reason);

console.log('\n=== 2. Win32 绑定完整性 ===');
const loaded = loadWin32();
check('loadWin32() 可用（核心绑定齐全）', loaded.reason === undefined, loaded.reason);
if (loaded.reason !== undefined) {
  console.log('  原因:', loaded.reason);
  process.exit(1);
}

const reported = describeNative();
console.log('  koffi 版本:', reported.koffiVersion);
console.log('  绑定失败项:', reported.failures.length === 0 ? '无（全部成功）' : reported.failures.join(' | '));
check('没有任何单个函数绑定失败', reported.failures.length === 0, reported.failures.join('; '));

console.log('\n=== 3. FillRect 回归（曾绑错 DLL 击穿全部绑定）===');
check('FillRect 已绑定成功（user32 而非 gdi32）', typeof loaded.FillRect === 'function');
check('gdi32 的 GDI 函数仍正常', typeof loaded.CreateSolidBrush === 'function' && typeof loaded.TextOutW === 'function');
check('核心消息投递函数可用', typeof loaded.PostMessageW === 'function' && typeof loaded.SendMessageW === 'function');
check('光标读取可用（并行性校验依赖）', typeof loaded.GetCursorPos === 'function');

console.log('\n=== 3b. 进程查询绑定（供终端类窗口识别）===');
check('OpenProcess 可用', typeof loaded.OpenProcess === 'function');
check('QueryFullProcessImageNameW 可用', typeof loaded.QueryFullProcessImageNameW === 'function');
check('CloseHandle 可用（句柄必须能关）', typeof loaded.CloseHandle === 'function');

console.log('\n=== 3c. EM_* 常量（纯 PostMessage 下编辑控件的可靠路径）===');
check('EM.SETSEL 已定义', EM.SETSEL === 0x00B1, `got ${EM.SETSEL}`);
check('EM.REPLACESEL 已定义', EM.REPLACESEL === 0x00C2, `got ${EM.REPLACESEL}`);
check('EM.GETLINE 已定义', EM.GETLINE === 0x00C4, `got ${EM.GETLINE}`);
// 曾有一个错误的 SETCURSORPOS: 0x0200（既非真实消息名，又与 MOUSEMOVE 撞号）。
check('错误的 WM.SETCURSORPOS 已被移除', WM.SETCURSORPOS === undefined);
check('WM.SETCURSOR 是正确的 0x0020', WM.SETCURSOR === 0x0020, `got ${WM.SETCURSOR}`);
check('WM.MOUSEMOVE 未被撞号污染', WM.MOUSEMOVE === 0x0200, `got ${WM.MOUSEMOVE}`);

console.log('\n=== 3d. processImagePath（只读进程信息）===');
const selfPath = processImagePath(process.pid);
console.log('  自身进程映像:', JSON.stringify(selfPath));
check('能读到自身进程的可执行路径', selfPath.ok === true && /\.exe$/i.test(selfPath.path ?? ''), selfPath.reason);
// 受保护进程会被拒绝，这必须是"优雅失败"而不是抛异常。
const bogus = processImagePath(0x7FFF_FFFE);
check('不存在的进程优雅失败（不抛异常）', bogus.ok === false && typeof bogus.reason === 'string');
check('非法 pid 被拒绝', processImagePath(-1).ok === false && processImagePath('abc').ok === false);

console.log('\n=== 4. 枚举实际窗口（端到端冒烟）===');
let count = 0;
const withTitle = [];
enumWindows((hwnd) => {
  count++;
  if (loaded.IsWindowVisible(hwnd) === true) {
    const buf = Buffer.alloc(1024);
    const n = loaded.GetWindowTextW(hwnd, buf, 512);
    if (n > 0) withTitle.push(buf.toString('utf16le', 0, n * 2));
  }
  return true;
});
console.log('  枚举到顶层窗口:', count, '| 有标题的可见窗口:', withTitle.length);
check('能枚举到窗口', count > 0, `count=${count}`);
check('能读到窗口标题', withTitle.length > 0, `titled=${withTitle.length}`);
if (withTitle.length > 0) console.log('  示例标题:', withTitle.slice(0, 5).join(' / '));

console.log('\n=== 5. 光标位置读取 ===');
const pt = Buffer.alloc(8);
const got = loaded.GetCursorPos(pt) === true;
check('GetCursorPos 成功', got);
if (got) console.log('  当前光标:', pt.readInt32LE(0), ',', pt.readInt32LE(4));

console.log(`\n=== 汇总: ${pass} 通过, ${fail} 失败 ===`);
if (fail > 0) {
  console.log('失败项:', failures.join(' | '));
  process.exit(1);
}
console.log('native.js 回归测试全部通过。');
