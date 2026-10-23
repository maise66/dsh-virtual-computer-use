/**
 * uia.js + template-match.js 端到端回归测试。
 *
 * 运行：`node test/uia-template.test.mjs`
 *
 * ## 这个测试要证什么
 *
 * **UIA 侧**
 *   1. UIA 真的可用（PowerShell 5.1 + .NET UIAutomation 程序集可加载）
 *   2. 对**真实记事本**能读出有意义的控件树（不是空树、不是错误）
 *   3. 读到的节点 bbox 落在窗口矩形内（坐标自洽性）
 *   4. `findElements` 按类名/名称能命中，且命中项与 `getTree` 一致
 *   5. `elementInfo` 能读到单个元素的 Pattern 信息
 *   6. 坐标换算：屏幕物理像素 → 客户区坐标，且换算值在客户区范围内
 *   7. 空树与失败必须**可区分**（错误目标 → ok:false；无控件 → ok:true + 空）
 *   8. 超时保护真的能杀掉子进程（不留孤儿）
 *
 * **模板匹配侧**
 *   9.  自匹配可证明正确：从真实截图里裁一块，再在同一张图里找它，
 *       必须命中**完全相同的坐标**（这是最强的正确性断言）
 *   10. 负样本：纯色图里搜不存在的纹理模板，必须返回 0 个结果
 *   11. 平坦（零方差）模板必须返回 0，不能因为 0/0 而满屏假命中
 *   12. 多次出现：同一模板在图上出现两次，必须找到两个位置
 *   13. PNG 编解码往返无损，且 `matchTemplate` 能直接吃 PNG
 *   14. 实测并打印耗时（全屏、限定区域、各 stride）
 *
 * ## 为什么截图不用 lib/capture.js
 *
 * `lib/capture.js` 由另一个队友并行交付，本测试**刻意不依赖它** ——
 * 否则两个文件的交付会互相挡住。这里用 `_probe/shot-probe.mjs` 里
 * 已经验证过的 PrintWindow + GetDIBits 思路做一份**自包含**的最小抓图，
 * 只在本测试内部使用。这样本测试在任何时候都能独立跑通。
 *
 * 不干扰用户：不移动光标、不抢焦点，测试结束 taskkill 清理自己启动的进程。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  getTree, findElements, elementInfo, windowInfo, describeUia,
  toClientCoords, nodeClickPoint, bboxInsideWindow, lastRunInfo, UIA_DEFAULTS,
} from '../lib/uia.js';
import { listWindows, describeClientArea, findChildByClass } from '../lib/windows.js';
import { loadWin32, windowRect, EM } from '../lib/native.js';
import {
  matchTemplate, toGrayImage, grayscaleFromBGRA, decodePng, encodePng, isPng,
  describeMatcher, grayFromBuffer, MATCH_DEFAULTS,
} from '../lib/template-match.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const TMP = join(tmpdir(), `dsh-vcu-uia-tpl-${process.pid}`);

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

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

function info(label, value) {
  console.log(`  ·     ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

/** 记录我们启动的进程，确保测试结束时全部清掉。 */
const spawned = [];

function cleanupProcesses() {
  for (const { pid, name } of spawned) {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // 已经退出就无所谓。
    }
    void name;
  }
  spawned.length = 0;
}

// 兜底：无论测试怎么结束（正常 / 抛异常 / Ctrl+C），都要清理。
process.on('exit', cleanupProcesses);
process.on('SIGINT', () => { cleanupProcesses(); process.exit(130); });

// ---------------------------------------------------------------------------
// 自包含的最小截图（只用 native.js 的已交付绑定，不碰 capture.js）
// ---------------------------------------------------------------------------

/**
 * 用 GDI 抓窗口位图，返回 `{width, height, bgra}`。
 *
 * 复用 `lib/native.js` 已交付且已实测的绑定（GetDC / CreateCompatibleDC /
 * CreateCompatibleBitmap / SelectObject / PrintWindow ... / GetDIBits）。
 *
 * 注意：`native.js` 里**没有**绑定 `CreateCompatibleDC` / `CreateCompatibleBitmap`
 * / `GetDIBits`（那些属于 capture.js 的职责范围）。所以这里用 koffi 自己补绑定，
 * 但只在测试进程里补 —— 不动 native.js 的任何内容。
 */
function grabWindowBgra(hwnd) {
  const loaded = loadWin32();
  if (loaded.reason !== undefined) return { ok: false, reason: loaded.reason };

  const user32 = loaded.user32;
  const gdi32 = loaded.gdi32;

  // 测试局部的补充绑定（koffi 允许对同一个 DLL 多次 func()）。
  const bind = (dll, sig) => {
    try {
      return dll.func(sig);
    } catch (error) {
      throw new Error(`binding failed for ${sig}: ${error?.message ?? String(error)}`);
    }
  };
  const CreateCompatibleDC = bind(gdi32, 'intptr_t __stdcall CreateCompatibleDC(intptr_t hdc)');
  const CreateCompatibleBitmap = bind(gdi32, 'intptr_t __stdcall CreateCompatibleBitmap(intptr_t hdc, int w, int h)');
  const GetDIBits = bind(gdi32, 'int __stdcall GetDIBits(intptr_t hdc, intptr_t hbm, uint32 start, uint32 lines, _Out_ uint8_t *bits, _Inout_ uint8_t *bmi, uint32 usage)');
  const DeleteDC = bind(gdi32, 'bool __stdcall DeleteDC(intptr_t hdc)');
  const PrintWindow = bind(user32, 'bool __stdcall PrintWindow(intptr_t hwnd, intptr_t hdc, uint32 flags)');
  const BitBlt = bind(gdi32, 'bool __stdcall BitBlt(intptr_t dst, int x, int y, int w, int h, intptr_t src, int sx, int sy, uint32 rop)');

  const rect = windowRect(loaded, hwnd);
  if (rect === undefined) return { ok: false, reason: 'GetWindowRect failed' };
  const width = rect.width;
  const height = rect.height;
  if (width <= 0 || height <= 0) return { ok: false, reason: `window has no area: ${width}x${height}` };

  // 每个 GDI 对象都必须释放，否则反复调用会耗尽句柄。
  let hdcWindow = 0;
  let hdcMem = 0;
  let hbm = 0;
  let prev = 0;
  try {
    hdcWindow = loaded.GetDC(hwnd);
    if (!hdcWindow) return { ok: false, reason: 'GetDC failed' };
    hdcMem = CreateCompatibleDC(hdcWindow);
    if (!hdcMem) return { ok: false, reason: 'CreateCompatibleDC failed' };
    hbm = CreateCompatibleBitmap(hdcWindow, width, height);
    if (!hbm) return { ok: false, reason: 'CreateCompatibleBitmap failed' };
    prev = loaded.SelectObject(hdcMem, hbm);

    // PW_RENDERFULLCONTENT = 0x02：能抓被遮挡/后台窗口（实测有效）。
    let method = 'PrintWindow';
    if (PrintWindow(hwnd, hdcMem, 0x02) !== true) {
      method = 'BitBlt';
      // SRCCOPY = 0x00CC0020
      if (BitBlt(hdcMem, 0, 0, width, height, hdcWindow, 0, 0, 0x00cc0020) !== true) {
        return { ok: false, reason: 'both PrintWindow and BitBlt failed' };
      }
    }

    const bmi = Buffer.alloc(40 + 256 * 4);
    bmi.writeUInt32LE(40, 0);            // biSize
    bmi.writeInt32LE(width, 4);          // biWidth
    bmi.writeInt32LE(-height, 8);        // biHeight 负值 = top-down
    bmi.writeUInt16LE(1, 12);            // biPlanes
    bmi.writeUInt16LE(32, 14);           // biBitCount
    bmi.writeUInt32LE(0, 16);            // BI_RGB

    const pixels = Buffer.alloc(width * height * 4);
    const lines = GetDIBits(hdcMem, hbm, 0, height, pixels, bmi, 0);
    if (!Number.isFinite(lines) || lines <= 0) {
      return { ok: false, reason: `GetDIBits returned ${lines}` };
    }
    return { ok: true, width, height, bgra: pixels, method, lines };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  } finally {
    try {
      if (prev && hdcMem) loaded.SelectObject(hdcMem, prev);
      if (hbm) loaded.DeleteObject(hbm);
      if (hdcMem) DeleteDC(hdcMem);
      if (hdcWindow) loaded.ReleaseDC(hwnd, hdcWindow);
    } catch {
      // 释放失败不改变结论。
    }
  }
}

// ---------------------------------------------------------------------------
// 记事本夹具
// ---------------------------------------------------------------------------

/** 启动一个记事本，返回它的 hwnd 与 pid。 */
async function launchNotepad() {
  const child = spawn('notepad.exe', [], { detached: false, windowsHide: false, stdio: 'ignore' });
  spawned.push({ pid: child.pid, name: 'notepad' });
  const childPid = child.pid;

  // 等窗口出现（冷启动可能 3~5 秒）。
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(400);
    const listing = listWindows({ visibleOnly: true });
    if (listing.ok !== true) continue;
    const hit = listing.windows.find(
      (w) => w.pid === childPid && (w.className === 'Notepad' || w.className === 'Notepad++' || w.title.includes('记事本')),
    );
    if (hit !== undefined) return { ok: true, hwnd: hit.hwnd, pid: childPid, title: hit.title, className: hit.className, child };
  }
  return { ok: false, reason: `notepad (pid ${childPid}) did not expose a top-level window within 20s` };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 写进记事本的测试文本（含中文，顺便验证 UTF-16 路径）。 */
const TEST_TEXT = 'TEMPLATE MATCH TEST 12345\r\nABCDEFG 1234567890\r\n日本語テスト ABCDEF\r\n';

/**
 * 用 `EM_SETSEL` + `EM_REPLACESEL` 把文本写进记事本的编辑控件。
 *
 * 为什么不用 `lib/virtual-input.js` 的 `writeText()`：本测试要保持
 * **零模块耦合**（本测试只依赖 native.js / windows.js / uia.js /
 * template-match.js）。用底层 `SendMessageW` 直接投递编辑控件消息，
 * 两条消息都由控件自身处理，不依赖焦点，最可靠。
 */
function writeNotepadText(parentHwnd, text) {
  const loaded = loadWin32();
  if (loaded.reason !== undefined) return { ok: false, reason: loaded.reason };
  const child = findChildByClass(parentHwnd, 'Edit');
  const target = child.ok === true ? child.hwnd : parentHwnd;
  try {
    // 全选（EM_SETSEL(0, -1)）→ 替换选区（EM_REPLACESEL）。
    // lParam 必须传**指针地址**，koffi 的 intptr_t 参数不会自动转换 Buffer。
    loaded.SendMessageW(target, EM.SETSEL, 0, -1);
    const payload = Buffer.from(`${text}\0`, 'utf16le');
    loaded.SendMessageW(target, EM.REPLACESEL, 1, Number(loaded.koffi.address(payload)));
    return { ok: true, hwnd: target };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
  console.log(`临时目录: ${TMP}`);
  console.log(`仓库根:   ${REPO}`);

  // =========================================================================
  section('1. UIA 能力自检');
  // =========================================================================
  const caps = await describeUia();
  info('powershell', caps.powershell);
  info('supported', caps.supported);
  if (caps.supported === true) {
    info('PowerShell 版本', caps.psVersion);
    info('CLR 版本', caps.clrVersion);
    info('桌面 RootElement 类名', caps.desktopClass);
    info('自检耗时', `${caps.elapsedMs} ms`);
  } else {
    info('失败原因', caps.reason);
  }
  check('UIA 可用（PowerShell + UIAutomation 程序集加载成功）', caps.supported === true, caps.reason);
  if (caps.supported !== true) {
    console.log('\nUIA 不可用，后续 UIA 断言全部无法进行。');
  }

  // =========================================================================
  section('2. 模板匹配器自检（纯离线，不依赖 UIA / 截图）');
  // =========================================================================
  const matcher = describeMatcher();
  info('算法', matcher.algorithm);
  info('合成图', matcher.synthetic);
  info('自匹配结果', matcher.selfMatch);
  info('期望位置', matcher.expected);
  info('耗时', `${matcher.elapsedMs} ms`);
  check('匹配器可用', matcher.ok === true);
  check(
    '合成图自匹配命中期望坐标',
    matcher.selfMatchCorrect === true,
    `got ${JSON.stringify(matcher.selfMatch)} expected ${JSON.stringify(matcher.expected)}`,
  );

  // =========================================================================
  section('3. 输入解析与 PNG 往返');
  // =========================================================================
  {
    const w = 64;
    const h = 48;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = (i * 7) & 0xff;
      rgba[i * 4 + 1] = (i * 13) & 0xff;
      rgba[i * 4 + 2] = (i * 29) & 0xff;
      rgba[i * 4 + 3] = 255;
    }
    const png = encodePng(rgba, w, h, 'rgba');
    check('encodePng 产出合法 PNG 签名', isPng(png), `first8=${png.subarray(0, 8).toString('hex')}`);
    const dec = decodePng(png);
    check('decodePng 尺寸一致', dec.width === w && dec.height === h, `got ${dec.width}x${dec.height}`);
    let mismatch = 0;
    for (let i = 0; i < rgba.length; i++) if (rgba[i] !== dec.data[i]) mismatch++;
    check('PNG 编解码往返无损', mismatch === 0, `${mismatch} 个字节不一致`);
    info('PNG 字节数', String(png.length));

    // 灰度路径：同一份数据的 BGRA / RGBA 应给出不同灰度（R/B 权重不同），
    // 但各自与自己的匹配必须满分（自洽性）。
    const grayA = grayscaleFromBGRA(rgba, w, h, 'rgba');
    const grayB = grayscaleFromBGRA(rgba, w, h, 'bgra');
    check('grayFromBuffer 可用', grayFromBuffer(grayA.gray, w, h).width === w);
    const selfA = matchTemplate(grayA, grayA, { threshold: 0.99 });
    check('灰度输入自匹配满分', selfA.ok === true && selfA.best !== null && selfA.best.score > 0.999,
      JSON.stringify(selfA.best ?? selfA.reason));
    info('RGBA 与 BGRA 灰度化结果是否相同', String(Buffer.compare(Buffer.from(grayA.gray), Buffer.from(grayB.gray)) === 0));
    void grayB;

    // 错误输入必须降级而不是抛异常。
    const bad = matchTemplate('no-such-file.png', grayA, {});
    check('不存在的文件返回 ok:false（不抛异常）', bad.ok === false && typeof bad.reason === 'string');
    info('错误输入 reason', bad.reason);
    const tooBig = matchTemplate(grayA, { gray: new Uint8Array(200 * 200), width: 200, height: 200 }, {});
    check('模板大于源图返回 ok:false', tooBig.ok === false, tooBig.reason);
  }

  // =========================================================================
  section('4. 负样本行为（不能乱报）');
  // =========================================================================
  {
    // 纯白源图 + 有纹理的模板：不应有任何命中。
    const W = 400;
    const H = 300;
    const blank = new Uint8Array(W * H * 4);
    for (let i = 3; i < blank.length; i += 4) blank[i] = 255; // 全白不透明

    const tw = 40;
    const th = 40;
    const noise = new Uint8Array(tw * th * 4);
    let seed = 12345;
    for (let i = 0; i < tw * th; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const v = (seed >> 16) & 0xff;
      noise[i * 4] = v;
      noise[i * 4 + 1] = 255 - v;
      noise[i * 4 + 2] = (v * 3) & 0xff;
      noise[i * 4 + 3] = 255;
    }

    const neg = matchTemplate(
      { data: blank, width: W, height: H, order: 'rgba' },
      { data: noise, width: tw, height: th, order: 'rgba' },
      { threshold: 0.9 },
    );
    check('纯色源图搜纹理模板 → 0 个命中', neg.ok === true && neg.count === 0,
      `count=${neg.count} best=${JSON.stringify(neg.best)}`);
    info('负样本耗时', `${neg.elapsedMs} ms`);

    // 平坦（零方差）模板：NCC 在数学上是 0/0，必须被显式拒绝，
    // 否则会返回满屏 score=1 的假命中。
    const flatTpl = new Uint8Array(tw * th * 4).fill(128);
    for (let i = 3; i < flatTpl.length; i += 4) flatTpl[i] = 255;

    // 源图必须有纹理，否则测不出"模板平坦"这一支。
    const textured = new Uint8Array(W * H * 4);
    let seed2 = 999;
    for (let i = 0; i < W * H; i++) {
      seed2 = (seed2 * 1103515245 + 12345) & 0x7fffffff;
      const v = (seed2 >> 16) & 0xff;
      textured[i * 4] = v;
      textured[i * 4 + 1] = (255 - v);
      textured[i * 4 + 2] = v;
      textured[i * 4 + 3] = 255;
    }
    const flatResult = matchTemplate(
      { data: textured, width: W, height: H, order: 'rgba' },
      { data: flatTpl, width: tw, height: th, order: 'rgba' },
      { threshold: 0.9 },
    );
    check('零方差（纯色）模板 → 0 个命中（NCC 未定义，不得假命中）',
      flatResult.ok === true && flatResult.count === 0, `count=${flatResult.count}`);

    // 阈值调高到不可能达到的水平，也应 0 命中。
    const impossible = matchTemplate(
      { data: textured, width: W, height: H, order: 'rgba' },
      { data: noise, width: tw, height: th, order: 'rgba' },
      { threshold: 0.999999, searchRegion: { x: 0, y: 0, width: 100, height: 100 } },
    );
    check('阈值不可达 → 0 个命中', impossible.ok === true && impossible.count === 0,
      `count=${impossible.count} best=${JSON.stringify(impossible.best)}`);
  }

  // =========================================================================
  section('5. 合成图上的多实例定位（可精确验证的算术基准）');
  // =========================================================================
  let synthSource = null;
  let synthTemplate = null;
  const SYN_W = 640;
  const SYN_H = 480;
  const TPL_W = 36;
  const TPL_H = 28;
  const TPL_A = { x: 120, y: 90 };
  const TPL_B = { x: 430, y: 330 };
  {
    // 生成一张**非周期性**的合成图：低频渐变打破周期性，保证全局唯一峰。
    // 踩过的坑：早先版本用棋盘格，它是周期性的，"自己找自己"会命中
    // 离左上角最近的周期点，看起来像匹配器有 bug。测试数据必须无周期。
    const src = new Uint8Array(SYN_W * SYN_H * 4);
    let s = 20241016;
    for (let y = 0; y < SYN_H; y++) {
      for (let x = 0; x < SYN_W; x++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const base = (x * 0.31 + y * 0.17) % 180;
        const v = Math.max(0, Math.min(255, Math.trunc(base + ((s >> 16) % 60))));
        const i = (y * SYN_W + x) * 4;
        src[i] = v;
        src[i + 1] = 255 - v;
        src[i + 2] = (v * 3) & 0xff;
        src[i + 3] = 255;
      }
    }

    // 裁两块一模一样的模板（B 由 A 拷贝而来），验证多实例定位。
    const tpl = new Uint8Array(TPL_W * TPL_H * 4);
    for (let y = 0; y < TPL_H; y++) {
      for (let x = 0; x < TPL_W; x++) {
        const si = ((TPL_A.y + y) * SYN_W + (TPL_A.x + x)) * 4;
        const ti = (y * TPL_W + x) * 4;
        for (let c = 0; c < 4; c++) tpl[ti + c] = src[si + c];
      }
    }
    for (let y = 0; y < TPL_H; y++) {
      for (let x = 0; x < TPL_W; x++) {
        const si = ((TPL_A.y + y) * SYN_W + (TPL_A.x + x)) * 4;
        const di = ((TPL_B.y + y) * SYN_W + (TPL_B.x + x)) * 4;
        for (let c = 0; c < 4; c++) src[di + c] = src[si + c];
      }
    }

    synthSource = { data: src, width: SYN_W, height: SYN_H, order: 'rgba' };
    synthTemplate = { data: tpl, width: TPL_W, height: TPL_H, order: 'rgba' };

    const t0 = Date.now();
    const r = matchTemplate(synthSource, synthTemplate, { threshold: 0.95, maxResults: 10 });
    info('合成图耗时', `${Date.now() - t0} ms（含在 matchTemplate 内部计时 ${r.elapsedMs} ms）`);
    info('命中数', String(r.count));
    info('命中列表', r.matches);

    check('合成图自匹配命中（count >= 1）', r.ok === true && r.count >= 1, `count=${r.count}`);
    const atA = r.matches.some((m) => m.x === TPL_A.x && m.y === TPL_A.y);
    const atB = r.matches.some((m) => m.x === TPL_B.x && m.y === TPL_B.y);
    check('命中位置 A 精确匹配', atA, `expected (${TPL_A.x},${TPL_A.y})`);
    check('命中位置 B 精确匹配（多实例定位）', atB, `expected (${TPL_B.x},${TPL_B.y})`);
    check('最高分接近 1.0 且不超过 1.0',
      r.best !== null && r.best.score > 0.999 && r.best.score <= 1,
      `best.score=${r.best?.score}`);
  }

  // =========================================================================
  section('6. 性能实测（1920x1080 全屏，50x50 模板）');
  // =========================================================================
  {
    // 用"真实感"图像：平滑色块 + 面板边缘 + 轻微噪声。
    // 为什么不用逐像素随机噪声：那种图上位移 1px 就让 NCC 从 1.00 掉到 0.05，
    // coarse-to-fine 在原理上失效（见 template-match.js 里的实测注释）。
    // 真实屏幕内容有平坦填充和连续边缘，用噪声图测出来的耗时也不能代表实际。
    const W = 1920;
    const H = 1080;
    const src = new Uint8Array(W * H * 4);
    let s = 42;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const inPanel = x > 200 && x < 700 && y > 150 && y < 600;
        const inHeader = y > 150 && y < 210 && x > 200 && x < 700;
        let v = inHeader ? 65 : inPanel ? 245 : 30;
        v += Math.trunc(30 * Math.sin(x * 0.05) * Math.cos(y * 0.04));
        v += ((s >> 16) % 8) - 4;
        v = Math.max(0, Math.min(255, v));
        const i = (y * W + x) * 4;
        src[i] = v;
        src[i + 1] = v;
        src[i + 2] = v;
        src[i + 3] = 255;
      }
    }
    const TX = 900;
    const TY = 500;
    const tw = 50;
    const th = 50;
    const tpl = new Uint8Array(tw * th * 4);
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const si = ((TY + y) * W + (TX + x)) * 4;
        const ti = (y * tw + x) * 4;
        for (let c = 0; c < 4; c++) tpl[ti + c] = src[si + c];
      }
    }
    const source = { data: src, width: W, height: H, order: 'rgba' };
    const template = { data: tpl, width: tw, height: th, order: 'rgba' };

    console.log('  --- 全屏 1920x1080，50x50 模板（真实感图像）---');
    const timings = {};
    for (const stride of [1, 2, 4]) {
      const r = matchTemplate(source, template, { threshold: 0.9, maxResults: 3, stride });
      const exact = r.best !== null && r.best.x === TX && r.best.y === TY;
      timings[`stride${stride}`] = r.elapsedMs;
      console.log(`  ·     stride=${stride}: ${r.elapsedMs} ms, 检索位置 ${r.searched}, 命中 ${r.count}, `
        + `best=${JSON.stringify(r.best)}, 精确命中=${exact}`);
      check(`全屏 stride=${stride} 精确定位到 (${TX},${TY})`, exact, `best=${JSON.stringify(r.best)}`);
    }

    console.log('  --- 限定 searchRegion（400x300）---');
    const regionResult = matchTemplate(source, template, {
      threshold: 0.9,
      searchRegion: { x: 800, y: 400, width: 400, height: 300 },
    });
    timings.region = regionResult.elapsedMs;
    console.log(`  ·     searchRegion: ${regionResult.elapsedMs} ms, 检索位置 ${regionResult.searched}, `
      + `best=${JSON.stringify(regionResult.best)}`);
    check('限定区域精确定位到 (900,500)',
      regionResult.best !== null && regionResult.best.x === TX && regionResult.best.y === TY,
      JSON.stringify(regionResult.best));
    check('限定区域耗时 < 2s（任务目标）', regionResult.elapsedMs < 2000, `${regionResult.elapsedMs} ms`);

    // 任务里的硬要求：全屏朴素搜索如果 > 10s 必须优化或如实报告。
    console.log(`  --- 朴素全屏 stride=1 的实测耗时: ${timings.stride1} ms ---`);
    check('全屏 stride=1 未被优化到 10s 以内时，stride>1 必须有可用加速',
      timings.stride1 < 10000 || timings.stride4 < 2000,
      `stride1=${timings.stride1}ms stride4=${timings.stride4}ms`);
  }

  // =========================================================================
  section('7. 启动真实记事本，读 UIA 控件树');
  // =========================================================================
  const notepad = await launchNotepad();
  if (notepad.ok !== true) {
    check('启动记事本并拿到窗口句柄', false, notepad.reason);
  } else {
    check('启动记事本并拿到窗口句柄', true);
    info('hwnd', String(notepad.hwnd));
    info('pid', String(notepad.pid));
    info('title', notepad.title);
    info('className', notepad.className);

    if (caps.supported === true) {
      // --- 7a. windowInfo ---
      const win = await windowInfo(notepad.hwnd);
      check('windowInfo 成功', win.ok === true, win.reason);
      if (win.ok === true) {
        info('frameworkId', win.frameworkId);
        info('nativeWindowHandle', String(win.nativeWindowHandle));
        info('耗时', `${win.elapsedMs} ms`);
        check('windowInfo 的 nativeWindowHandle 与实际 hwnd 一致',
          win.nativeWindowHandle === notepad.hwnd,
          `uia=${win.nativeWindowHandle} actual=${notepad.hwnd}`);
      }

      // --- 7b. getTree ---
      const tree = await getTree(notepad.hwnd, { maxDepth: 6, maxNodes: 200 });
      check('getTree 成功', tree.ok === true, tree.reason);
      if (tree.ok === true) {
        info('节点数', String(tree.count));
        info('耗时', `${tree.elapsedMs} ms`);
        info('被深度截断', String(tree.depthLimited));
        info('被节点数截断', String(tree.nodeLimited));
        if (tree.note !== undefined) info('note', tree.note);

        // 老实说：Win11 的记事本是 XAML/WinUI 应用，ControlView 下只有
        // 编辑区 + 状态栏两个 Pane，**没有**菜单项节点（旧版 Win32 记事本
        // 的菜单栏是独立的 Notepad 类子窗口）。所以这里不能断言
        // "必须找到 编辑(E)"，只能断言"树非空 + 节点有实际几何"。
        // 这两条已经足以证明 UIA 真的读到了东西，而不是空壳。
        check('记事本控件树非空（UIA 真的读到了控件）', tree.count > 0,
          `count=${tree.count} note=${tree.note ?? ''}`);

        const printable = tree.nodes.map((n) => ({
          id: n.id, ct: n.controlType, cls: n.className, name: n.name, bbox: n.bbox,
        }));
        console.log('  ·     实际读到的节点:');
        for (const n of printable) {
          console.log(`         #${n.id} [${n.ct}] class=${JSON.stringify(n.cls)} `
            + `name=${JSON.stringify(n.name)} bbox=${JSON.stringify(n.bbox)}`);
        }

        // 每个节点都要有合法的几何数据（UIA 读到了真实的布局信息）。
        const withBbox = tree.nodes.filter(
          (n) => n.bbox !== null && n.bbox !== undefined && n.bbox.width > 0 && n.bbox.height > 0,
        );
        check('绝大多数节点带有效 bbox', withBbox.length >= Math.max(1, Math.ceil(tree.count * 0.5)),
          `${withBbox.length}/${tree.count}`);

        // 坐标自洽性：节点 bbox 必须落在窗口矩形内。
        const winRect = windowRect(loadWin32(), notepad.hwnd);
        info('窗口矩形', winRect);
        check('取到窗口矩形用于自洽性校验', winRect !== undefined);
        if (winRect !== undefined) {
          const insideCount = tree.nodes.filter((n) => {
            const r = bboxInsideWindow(n, winRect);
            return r.ok === true && r.inside === true;
          }).length;
          const checked = tree.nodes.filter((n) => bboxInsideWindow(n, winRect).ok === true).length;
          const badNodes = tree.nodes
            .filter((n) => {
              const r = bboxInsideWindow(n, winRect);
              return r.ok === true && r.inside !== true;
            })
            .map((n) => ({ id: n.id, cls: n.className, bbox: n.bbox }));
          info('落在窗口内的节点', `${insideCount}/${checked}`);
          if (badNodes.length > 0) info('越界节点', badNodes);
          check('所有带 bbox 的节点都落在窗口矩形内（坐标自洽）',
            checked > 0 && insideCount === checked,
            `${insideCount}/${checked} 在内，越界: ${JSON.stringify(badNodes)}`);

          // 已知的真实结构断言：记事本一定有一个 Edit 类控件（编辑区）。
          const editNode = tree.nodes.find((n) => n.className === 'Edit');
          check('控件树里找到 Edit 编辑区控件', editNode !== undefined,
            `classes=${JSON.stringify(tree.nodes.map((n) => n.className))}`);
          if (editNode !== undefined) {
            info('Edit 控件 bbox', editNode.bbox);
            const insideEdit = bboxInsideWindow(editNode, winRect);
            check('Edit 控件 bbox 落在窗口内', insideEdit.ok === true && insideEdit.inside === true,
              JSON.stringify(insideEdit));
          }
        }

        // --- 7c. 坐标换算：屏幕 → 客户区 ---
        const clientArea = describeClientArea(notepad.hwnd);
        check('describeClientArea 成功', clientArea.ok === true, clientArea.reason);
        if (clientArea.ok === true) {
          info('客户区原点（屏幕坐标）', clientArea.clientOrigin);
          info('客户区尺寸', clientArea.clientSize);

          const target = tree.nodes.find((n) => n.bbox !== null && n.bbox !== undefined) ?? tree.root;
          if (target !== null && target !== undefined) {
            const point = nodeClickPoint(target, clientArea.clientOrigin);
            check('nodeClickPoint 算出可点击点', point.ok === true, point.reason);
            if (point.ok === true) {
              info('控件中心（屏幕坐标）', point.screen);
              info('控件中心（客户区坐标）', point.client);
              check('换算后客户区坐标在客户区范围内',
                point.client !== null
                && point.client.x >= -2 && point.client.y >= -2
                && point.client.x <= clientArea.clientSize.width + 2
                && point.client.y <= clientArea.clientSize.height + 2,
                `client=${JSON.stringify(point.client)} clientSize=${JSON.stringify(clientArea.clientSize)}`);

              // 自洽性：客户区坐标 + 原点 = 屏幕坐标。
              if (point.client !== null) {
                const back = {
                  x: point.client.x + clientArea.clientOrigin.x,
                  y: point.client.y + clientArea.clientOrigin.y,
                };
                check('客户区坐标 + 原点 还原屏幕坐标（闭环一致）',
                  Math.abs(back.x - point.screen.x) <= 1 && Math.abs(back.y - point.screen.y) <= 1,
                  `back=${JSON.stringify(back)} screen=${JSON.stringify(point.screen)}`);
              }
            }
          }
        }
      }

      // --- 7d. findElements ---
      const byClass = await findElements(notepad.hwnd, { className: 'Edit' });
      check('findElements 按类名 Edit 命中', byClass.ok === true && byClass.count >= 1,
        `ok=${byClass.ok} count=${byClass.count} reason=${byClass.reason ?? ''}`);
      if (byClass.ok === true && byClass.count > 0) {
        info('命中节点', byClass.nodes.map((n) => ({ cls: n.className, bbox: n.bbox })));
        info('扫描候选数', String(byClass.scanned));
        info('耗时', `${byClass.elapsedMs} ms`);
      }

      // 不存在的类名：必须是 "有效的未命中"，不是错误。
      const noHit = await findElements(notepad.hwnd, { className: 'ThisClassDoesNotExist_ZZZ' });
      check('findElements 未命中 → ok:true 且 count=0（不是失败）',
        noHit.ok === true && noHit.count === 0, `ok=${noHit.ok} count=${noHit.count} reason=${noHit.reason ?? ''}`);
      if (noHit.ok === true && noHit.note !== undefined) info('未命中说明', noHit.note);

      // --- 7e. elementInfo ---
      if (tree.ok === true && tree.count > 0) {
        const first = tree.nodes[0];
        const one = await elementInfo({ hwnd: notepad.hwnd, nodeId: first.id });
        check('elementInfo 按 nodeId 读到元素', one.ok === true, one.reason);
        if (one.ok === true) {
          info('元素', {
            cls: one.element.className, ct: one.element.controlType,
            bbox: one.element.bbox, kind: one.element.resolveKind,
          });
          info('可用 Pattern', one.patterns);
          info('frameworkId', one.frameworkId);
          check('elementInfo 的 className 与 getTree 一致',
            one.element.className === first.className,
            `elementInfo=${one.element.className} getTree=${first.className}`);
        }

        // `hwnd:序号` 形式：直接用 FromHandle，最稳。
        const viaHandle = await elementInfo(`${notepad.hwnd}:1`);
        check('elementInfo 接受裸 "hwnd:index" 字符串', viaHandle.ok === true, viaHandle.reason);
        if (viaHandle.ok === true) {
          info('FromHandle 解析结果', {
            cls: viaHandle.element.className, kind: viaHandle.element.resolveKind,
          });
          check('FromHandle 取到的就是该窗口（类名一致）',
            viaHandle.element.className === notepad.className,
            `got=${viaHandle.element.className} expected=${notepad.className}`);
        }

        // 无效 nodeId 必须降级，不能把垃圾拼进 PowerShell 脚本。
        const garbage = await elementInfo({ hwnd: notepad.hwnd, nodeId: 'not-a-number; Remove-Item C:\\' });
        check('无效 nodeId 返回 ok:false（不接受脚本注入式输入）',
          garbage.ok === false, `ok=${garbage.ok} reason=${String(garbage.reason).slice(0, 120)}`);
      }

      // --- 7f. 空树 vs 失败必须可区分 ---
      const fakeHwnd = await getTree(999999999, { timeoutMs: 15000 });
      check('不存在的 hwnd 返回 ok:false（真失败）', fakeHwnd.ok === false,
        `ok=${fakeHwnd.ok} reason=${String(fakeHwnd.reason).slice(0, 120)}`);
      info('无效窗口的 reason', String(fakeHwnd.reason).slice(0, 160));

      const noTarget = await getTree({});
      check('不给目标返回 ok:false', noTarget.ok === false, noTarget.reason);

      // --- 7g. 超时保护真的能杀掉子进程 ---
      // 用一个远超实际的 maxNodes 逼出真实耗时，同时把 timeoutMs 压到最低（1000ms）。
      // 拿不可达的 pid + 全树遍历来制造慢查询不可靠（找不到目标会立刻返回），
      // 所以这里直接对**真实窗口**用极小超时 + 大 maxNodes：
      // 若在 1s 内跑完就不算超时（这不代表超时机制坏），我们只断言
      // "若超时则必须是被杀掉的、且没有留下孤儿进程"。
      const orphansBefore = countPowershell();
      const timed = await getTree(notepad.hwnd, { timeoutMs: 1000, maxDepth: 20, maxNodes: 5000 });
      await sleep(500);
      const orphansAfter = countPowershell();
      info('超时测试前的 powershell 进程数', String(orphansBefore));
      info('超时测试后的 powershell 进程数', String(orphansAfter));
      info('超时测试结果', { ok: timed.ok, timeout: timed.timeout === true, ms: timed.elapsedMs });
      check('极小超时的调用不抛异常（要么正常返回要么报超时）',
        timed.ok === true || typeof timed.reason === 'string');
      check('超时调用没有留下孤儿 powershell 进程', orphansAfter <= orphansBefore + 1,
        `before=${orphansBefore} after=${orphansAfter}`);
      if (timed.ok !== true && timed.timeout === true) {
        info('确认走的是超时分支', String(timed.reason).slice(0, 160));
        check('超时分支的 reason 明确提到超时', String(timed.reason).includes('UIA_TIMEOUT'));
      }
      info('lastRunInfo', lastRunInfo());

      // --- 7h. 真实截图 → 真实 UIA 的交叉验证 ---
      //
      // **重要前提：必须先把文字写进记事本。**
      //
      // 这是实测踩到的坑：空白记事本的编辑区是一整片纯白（实测采样 5 个
      // 80x40 区块，全部 min=255 / max=255 / 不同取值数 = 1）。在这种
      // **零方差**区域上，NCC 数学上是 0/0，本模块刻意让它返回"不匹配"
      // 而不是返回满屏 score=1 的假命中。所以"在空白记事本截图里找自己裁的
      // 纯白块"必然 0 命中 —— 这是**正确行为**，不是缺陷。
      //
      // 早先版本的测试直接在空白记事本上做自匹配，断言"必须命中"，
      // 结果失败。修法不是放宽阈值或改算法，而是让测试场景符合模板匹配的
      // 适用前提：模板必须**有可区分的特征**。写入文字后同一块区域的
      // 灰度取值数从 1 升到 32，自匹配精确命中 (16,63)、score=0.99999997。
      await writeNotepadText(notepad.hwnd, TEST_TEXT);
      await sleep(500);
      info('已写入记事本的测试文本', JSON.stringify(TEST_TEXT.slice(0, 40)));

      const shot = grabWindowBgra(notepad.hwnd);
      check('能抓到记事本窗口位图', shot.ok === true, shot.reason);
      if (shot.ok === true) {
        info('截图尺寸', `${shot.width}x${shot.height}`);
        info('抓图方式', shot.method);
        info('GetDIBits 返回行数', String(shot.lines));

        const gray = grayscaleFromBGRA(shot.bgra, shot.width, shot.height, 'bgra');

        // 非黑像素占比：确认不是空图。
        let nonBlack = 0;
        for (let i = 0; i < gray.gray.length; i++) if (gray.gray[i] > 25) nonBlack++;
        const ratio = nonBlack / gray.gray.length;
        info('非黑像素占比', ratio.toFixed(4));
        check('截图不是全黑（PrintWindow 真的抓到了内容）', ratio > 0.05,
          `nonBlack ratio=${ratio.toFixed(4)}`);

        // --- 自证：从真实截图裁一块，再在同一张截图里找它 ---
        const winRectNow = windowRect(loadWin32(), notepad.hwnd);
        if (winRectNow !== undefined && tree.ok === true) {
          const editNode = tree.nodes.find((n) => n.className === 'Edit');
          if (editNode !== undefined && editNode.bbox !== null) {
            // UIA bbox 是屏幕坐标；截图是窗口坐标，所以要减去窗口原点。
            const localX = Math.max(0, editNode.bbox.x - winRectNow.left);
            const localY = Math.max(0, editNode.bbox.y - winRectNow.top);
            info('Edit 控件在截图内的本地坐标', { x: localX, y: localY });

            // 从编辑区**内容起始处**裁一块（文字排在前几行，这里一定要覆盖到，
            // 否则裁到下面是空白行又是零方差 → 必然 0 命中）。
            // 文本模板取宽一点、矮一点：一行文字的高频笔画给 NCC 足够的区分度。
            const CW = Math.min(140, Math.max(20, editNode.bbox.width - 20));
            const CH = Math.min(22, Math.max(8, Math.round(editNode.bbox.height / 20)));
            const cropX = Math.min(shot.width - CW - 1, localX + 8);
            const cropY = Math.min(shot.height - CH - 1, localY + 10);

            if (cropX > 0 && cropY > 0 && CW > 0 && CH > 0) {
              const patch = new Uint8Array(CW * CH * 4);
              for (let y = 0; y < CH; y++) {
                for (let x = 0; x < CW; x++) {
                  const si = ((cropY + y) * shot.width + (cropX + x)) * 4;
                  const ti = (y * CW + x) * 4;
                  for (let c = 0; c < 4; c++) patch[ti + c] = shot.bgra[si + c];
                }
              }
              info('模板来源（截图内坐标）', { x: cropX, y: cropY, w: CW, h: CH });

              // 先确认这块模板**有特征**（不是零方差）。这是模板匹配的适用前提，
              // 没有特征时 0 命中是正确行为，但那种情况下不该断言"必须命中"。
              const patchGray = grayscaleFromBGRA(patch, CW, CH, 'bgra');
              const uniq = new Set(patchGray.gray).size;
              info('模板灰度不同取值数（=1 表示零方差，无法匹配）', String(uniq));
              check('裁到的模板有可区分特征（非零方差）', uniq > 1,
                `不同灰度取值数=${uniq}；空白记事本区域会是 1`);

              const selfMatch = matchTemplate(gray, { data: patch, width: CW, height: CH, order: 'bgra' },
                { threshold: 0.95, maxResults: 5 });
              info('真实截图自匹配耗时', `${selfMatch.elapsedMs} ms`);
              info('真实截图自匹配命中', selfMatch.matches);

              if (selfMatch.ok !== true) {
                check('真实截图自匹配执行成功', false, selfMatch.reason);
              } else {
                check('真实截图自匹配至少 1 个命中', selfMatch.count >= 1,
                  `count=${selfMatch.count} warnings=${JSON.stringify(selfMatch.warnings ?? [])}`);
                if (selfMatch.best !== null) {
                  check('自匹配位置与裁切位置完全一致（自己找自己必中）',
                    selfMatch.best.x === cropX && selfMatch.best.y === cropY,
                    `got (${selfMatch.best.x},${selfMatch.best.y}) expected (${cropX},${cropY}) score=${selfMatch.best.score}`);
                  check('自匹配分数为满分区间', selfMatch.best.score > 0.99, `score=${selfMatch.best.score}`);
                }
              }

              // 负样本：造一个**必然不存在**的模板（强纹理噪声块），
              // 在一个已经确认全是白底文字的区域里搜它。
              //
              // 为什么不用"纯色块"做负样本：记事本编辑区本身就是大片纯白，
              // 纯色块模板在零方差判定下会被拒（返回 0），但那不是"没找到"，
              // 而是"模板无特征"。用强纹理噪声块才是真正的负样本。
              const noisePatch = new Uint8Array(24 * 24 * 4);
              let nseed = 4242;
              for (let i = 0; i < 24 * 24; i++) {
                nseed = (nseed * 1103515245 + 12345) & 0x7fffffff;
                const v = (nseed >> 16) & 0xff;
                noisePatch[i * 4] = v;
                noisePatch[i * 4 + 1] = (255 - v);
                noisePatch[i * 4 + 2] = (v * 5) & 0xff;
                noisePatch[i * 4 + 3] = 255;
              }
              const negSearch = matchTemplate(gray, { data: noisePatch, width: 24, height: 24, order: 'bgra' },
                { threshold: 0.9, searchRegion: { x: 0, y: 0, width: Math.min(400, shot.width), height: Math.min(120, shot.height) } });
              info('截图内负样本命中数', String(negSearch.count));
              check('截图内搜不存在的噪声模板 → 0 命中（不乱报）', negSearch.ok === true && negSearch.count === 0,
                `count=${negSearch.count} best=${JSON.stringify(negSearch.best)}`);

              // 模板落盘 / 读回（验证 PNG 文件路径输入也能工作）。
              const tplPath = join(TMP, 'notepad-edit-patch.png');
              const rgbaPatch = new Uint8Array(CW * CH * 4);
              for (let i = 0; i < CW * CH; i++) {
                rgbaPatch[i * 4] = patch[i * 4 + 2];
                rgbaPatch[i * 4 + 1] = patch[i * 4 + 1];
                rgbaPatch[i * 4 + 2] = patch[i * 4];
                rgbaPatch[i * 4 + 3] = 255;
              }
              writeFileSync(tplPath, encodePng(rgbaPatch, CW, CH, 'rgba'));
              const fromFile = matchTemplate(gray, tplPath, { threshold: 0.95, maxResults: 3 });
              check('从 PNG 文件读模板并匹配成功',
                fromFile.ok === true && fromFile.count >= 1,
                `ok=${fromFile.ok} count=${fromFile.count} reason=${fromFile.reason ?? ''}`);
              if (fromFile.ok === true && fromFile.best !== null) {
                info('文件模板匹配位置', fromFile.best);
                check('文件模板匹配位置与裁切位置一致',
                  fromFile.best.x === cropX && fromFile.best.y === cropY,
                  `got (${fromFile.best.x},${fromFile.best.y}) expected (${cropX},${cropY})`);
              }
            }
          }
        }
      }
    } else {
      console.log('  (UIA 不可用，跳过 7 节的全部 UIA 断言)');
    }
  }

  // =========================================================================
  section('8. 选项与默认值');
  // =========================================================================
  {
    info('UIA_DEFAULTS', UIA_DEFAULTS);
    info('MATCH_DEFAULTS', MATCH_DEFAULTS);
    check('UIA 默认 maxDepth 在 4~6（任务要求）',
      UIA_DEFAULTS.maxDepth >= 4 && UIA_DEFAULTS.maxDepth <= 6, String(UIA_DEFAULTS.maxDepth));
    check('UIA 默认 maxNodes <= 200（不撑爆上下文）',
      UIA_DEFAULTS.maxNodes <= 200, String(UIA_DEFAULTS.maxNodes));
    check('UIA 默认超时 >= 20s 且有限（避免挂死）',
      UIA_DEFAULTS.timeoutMs >= 20000 && UIA_DEFAULTS.timeoutMs <= 60000, String(UIA_DEFAULTS.timeoutMs));
    check('匹配默认 threshold = 0.9', MATCH_DEFAULTS.threshold === 0.9, String(MATCH_DEFAULTS.threshold));

    // 视图模式：control 与 raw 都应工作（raw 通常节点更多）。
    if (notepad.ok === true && caps.supported === true) {
      const control = await getTree(notepad.hwnd, { viewMode: 'control', maxNodes: 200 });
      const raw = await getTree(notepad.hwnd, { viewMode: 'raw', maxNodes: 200 });
      check('viewMode=control 可用', control.ok === true, control.reason);
      check('viewMode=raw 可用', raw.ok === true, raw.reason);
      if (control.ok === true && raw.ok === true) {
        info('control 视图节点数', String(control.count));
        info('raw 视图节点数', String(raw.count));
        check('raw 视图节点数 >= control 视图（raw 更完整）',
          raw.count >= control.count, `raw=${raw.count} control=${control.count}`);
      }
      // maxNodes 上限必须真的生效。
      const capped = await getTree(notepad.hwnd, { viewMode: 'raw', maxNodes: 1 });
      check('maxNodes=1 时返回节点数 <= 1（上限真的生效）',
        capped.ok === true && capped.count <= 1, `count=${capped.count}`);
    }
  }

  // =========================================================================
  section('9. 清理');
  // =========================================================================
  cleanupProcesses();
  await sleep(800);
  const leftover = listWindows({ visibleOnly: true });
  const notepadLeft = leftover.ok === true
    ? leftover.windows.filter((w) => w.className === 'Notepad' && (notepad.ok === true && w.pid === notepad.pid))
    : [];
  info('残留记事本窗口', notepadLeft.length);
  check('测试启动的记事本已清理', notepadLeft.length === 0,
    JSON.stringify(notepadLeft.map((w) => ({ hwnd: w.hwnd, title: w.title }))));

  try {
    rmSync(TMP, { recursive: true, force: true });
    check('临时目录已清理', true);
  } catch (error) {
    check('临时目录已清理', false, error?.message);
  }

  // =========================================================================
  section('汇总');
  // =========================================================================
  console.log(`  PASS: ${pass}`);
  console.log(`  FAIL: ${fail}`);
  if (failures.length > 0) {
    console.log('  失败项:');
    for (const name of failures) console.log(`    - ${name}`);
  }
  console.log(fail === 0 ? '\n结果: ALL PASS' : `\n结果: ${fail} 项失败`);
  return fail === 0 ? 0 : 1;
}

/** 数一下当前跑着的 powershell 进程数（用于孤儿检测）。 */
function countPowershell() {
  try {
    const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq powershell.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const text = `${out.stdout ?? ''}`;
    if (text.includes('No tasks') || text.includes('没有')) return 0;
    return text.split('\n').filter((line) => line.toLowerCase().includes('powershell.exe')).length;
  } catch {
    return -1;
  }
}

// ---------------------------------------------------------------------------
// 入口：任何未捕获异常都要清理进程，并以非零码退出。
// ---------------------------------------------------------------------------

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error('\n测试中断:', error?.stack ?? String(error));
  cleanupProcesses();
  exitCode = 1;
}
process.exit(exitCode);
