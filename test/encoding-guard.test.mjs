/**
 * 源码完整性守卫。
 *
 * ## 为什么需要这个测试
 *
 * 本项目真实发生过一次事故：用 PowerShell 的
 * `(Get-Content x.js -Raw) | Set-Content x.js` 就地把某个源文件里的
 * 标识符改名，结果这台机器上 PowerShell 按 **GBK(CP936)** 读取 UTF-8 文件、
 * 再以 UTF-8 写回，导致：
 *   - 939 个中文字符被替换成 `?`（不可恢复）
 *   - 部分换行丢失、语句粘连
 *   - 文件语法失效，只能请原作者重建
 *
 * 这类损坏**在 diff 里极不显眼**（看起来只是"注释变了"），却会让整个模块
 * 不可用。所以要有自动化守卫，在任何一次改动后立刻发现它。
 *
 * 本测试对 lib/ 下所有源文件做三项检查：
 *   1. **无替换字符**：U+FFFD（decoder 遇到非法字节的产物）
 *   2. **无乱码特征**：GBK 往返会把中文变成"锟斤拷/鈥/鍜"这类典型乱码字符，
 *      以及大量连续的问号（不可映射字符的替代）
 *   3. **语法可解析**：用 node --check 逐个验证
 *
 * 运行：`node test/encoding-guard.test.mjs`
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const libDir = join(here, '..', 'lib');

let pass = 0, fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** GBK 误读 UTF-8 会把中文变成这些典型乱码字符。 */
const MOJIBAKE_MARKERS = [
  '锟斤拷', '锟', '鈥', '鍜', '鏍', '锛', '涓', '鎴', '娑', '绐', '榧', '閿', '锟',
  '鈻', '锟', '圹', '铏', '鏈', '鏂', '鎵', '缂', '鍣', '鐞',
];

/** U+FFFD 替换字符。 */
const REPLACEMENT_CHAR = '\uFFFD';

console.log('=== 源码完整性守卫（防止 GBK 往返损坏）===\n');
console.log(`检查目录: ${libDir}\n`);

const files = readdirSync(libDir).filter((f) => f.endsWith('.js') && !f.endsWith('.corrupt-bak') && !f.endsWith('.fixed'));
console.log(`发现 ${files.length} 个源文件: ${files.join(', ')}\n`);

for (const file of files) {
  const full = join(libDir, file);
  let text;
  try {
    text = readFileSync(full, 'utf8');
  } catch (error) {
    check(`${file} 可读取`, false, error.message);
    continue;
  }

  // 1. U+FFFD
  const fffdCount = (text.match(new RegExp(REPLACEMENT_CHAR, 'g')) ?? []).length;
  check(`${file}: 无 U+FFFD 替换字符`, fffdCount === 0, `发现 ${fffdCount} 个`);

  // 2. 乱码特征
  const foundMarkers = [];
  for (const marker of MOJIBAKE_MARKERS) {
    if (text.includes(marker)) foundMarkers.push(marker);
  }
  check(`${file}: 无 GBK 乱码特征字符`, foundMarkers.length === 0,
    foundMarkers.length > 0 ? `发现: ${foundMarkers.slice(0, 6).join(' ')}` : '');

  // 3. 连续的 '?' 替代（GBK 无法映射的字符会被替换成 ?）
  // 正常代码里连续 3 个以上问号极罕见（除了三元链 ?. 或 ??? 之类），
  // 这里只看"连续 3 个及以上且周围有中文"的情况。
  const suspiciousQuestionRuns = (text.match(/[\u4e00-\u9fff\uff00-\uffef]\?|\?[\u4e00-\u9fff]/g) ?? []).length;
  check(`${file}: 无明显的中文-问号替代痕迹`, suspiciousQuestionRuns < 3,
    `可疑片段 ${suspiciousQuestionRuns} 处`);

  // 4. 语法可解析
  try {
    execFileSync(process.execPath, ['--check', full], { stdio: 'pipe', timeout: 30000 });
    check(`${file}: 语法可解析（node --check）`, true);
  } catch (error) {
    const stderr = String(error.stderr ?? '').split('\n').slice(0, 3).join(' ').slice(0, 200);
    check(`${file}: 语法可解析（node --check）`, false, stderr || error.message);
  }

  // 5. 换行完好性：如果文件里既有 \r\n 又有孤立的 \n 混杂，可能是文本工具往返过。
  //    这里只报告，不算失败（不同编辑器习惯不同）。
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const loneLf = (text.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf > 0 && loneLf > 0) {
    console.log(`        · ${file}: 混合行尾（CRLF ${crlf} / LF ${loneLf}）—— 提示性信息，非失败`);
  }
}

console.log(`\n=== 汇总: ${pass} 通过 / ${fail} 失败 ===`);
if (fail > 0) {
  console.log('\n失败项:');
  for (const f of failures) console.log(`  - ${f}`);
  console.log('\n⚠ 源码可能被文本工具（尤其是 PowerShell Set-Content）损坏。');
  console.log('  修复建议：从备份或版本控制恢复，不要尝试用文本管道"改回来"。');
  process.exit(1);
}
console.log('所有源文件编码与语法完好。');
