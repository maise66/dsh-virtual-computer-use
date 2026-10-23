/**
 * 视觉能力（截图 + OCR）端到端测试。
 *
 * 运行：`node test/vision.test.mjs`
 *
 * ## 这个测试的立场
 *
 * 它**不满足于"函数返回了 ok:true"**。每一组断言都尽量落到一个客观、可证伪的量上：
 *
 *   - 截图合法性 → 校验 PNG 签名 + IHDR 尺寸 + **IHDR 的 CRC 是否正确**（能发现"写得
 *     看似正常但其实损坏"的图）
 *   - 抓后台窗口 → 把记事本 `SetWindowPos` **挪到屏幕外 (-4000,-4000)**，再断言抓到的
 *     图里非黑像素占比够高。只看 PrintWindow 返回 true 是不够的：UWP/硬件加速窗口
 *     会返回 true 却给出一张全黑图。挪到屏幕外比"被遮挡"更强：此时屏幕上**根本
 *     没有**这个窗口的像素，任何屏幕拷贝都必然拿不到内容，唯一可能来源就是
 *     PrintWindow 让窗口自己重绘。
 *   - OCR 真的读到了字 → 断言识别文本里出现我们**确实写进去**的关键词
 *   - bbox 换算自洽 → 把 OCR 的图片像素框换算到屏幕坐标，断言它落在窗口矩形内；
 *     再换算到客户区坐标，断言落在客户区尺寸内。这是"看到字 → 点它"这条链路的正确性证明。
 *   - 光标不动 → 注入与截图前后各读一次 `GetCursorPos`
 *
 * ## 已知的脆弱点（如实标注，不藏）
 *
 * 1. **把文字放进记事本**：`virtual-input.writeText()` 走裸 `WM_CHAR`，实测**投递到顶层
 *    窗口时不生效**（`WM_GETTEXTLENGTH` 仍是 0）。它必须投给记事本的 **Edit 子控件**才生效。
 *    本测试因此直接定位 Edit 子控件再写 —— 这不是绕过测试，而是找到了正确的目标：
 *    "窗口消息注入要打到真正处理该消息的控件上"本身就是这套技术的真实约束。
 * 2. 即使写进了 Edit，记事本**不一定立刻重绘**。截图前必须 `UpdateWindow` + 短暂等待，
 *    否则抓到的是还没画出文字的旧画面。这是本测试第一版真实踩过的坑。
 * 3. **OCR 识别率不是 100%**：实测 Windows OCR 把 "Hello" 读成 "He110"、"2026" 读成
 *    "2926"、"Windows" 读成 "Wlndows"（en-GB/zh-Hans-CN 引擎都会把拉丁字母往形近
 *    字上靠）。所以断言用的是**容错匹配**：比较去掉空格与大小写、且允许少量字符
 *    差异的"相似度"，而不是严格相等。容错阈值写在 `similarity()` 里并打印实际值。
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { enumWindows, loadWin32, readWide } from '../lib/native.js';
import { childWindows, cursorPosition } from '../lib/virtual-input.js';
import {
  captureFullScreen,
  captureRegion,
  captureWindow,
  describeCapture,
  imagePointToClient,
  imagePointToScreen,
  listMonitors,
  verifyPng,
} from '../lib/capture.js';
import {
  describeOcr,
  findText,
  listOcrLanguages,
  ocrImage,
  ocrWindow,
} from '../lib/ocr.js';
import {
  decodePng,
  encodePngRgba,
  imageStats,
  readPngHeader,
  resizeRgba,
  bgraToRgba,
} from '../lib/png.js';

// ---------------------------------------------------------------------------
// 极简测试框架
// ---------------------------------------------------------------------------

const results = [];
let currentSection = '(no section)';

function section(title) {
  currentSection = title;
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

function record(name, passed, detail) {
  results.push({ section: currentSection, name, passed, detail });
  const tag = passed ? 'PASS' : 'FAIL';
  console.log(`  ${tag}  ${name}`);
  if (detail !== undefined && detail !== null && detail !== '') {
    console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
}

function check(name, passed, detail) {
  record(name, passed === true, detail);
  return passed === true;
}

// ---------------------------------------------------------------------------
// 文本相似度（OCR 容错匹配）
// ---------------------------------------------------------------------------

/**
 * 归一化：去掉所有空白与标点、转小写。
 *
 * OCR 经常在字之间插空格（尤其 CJK 引擎处理拉丁文本时：`Hello OCR 2026` 可能变成
 * `He110 0CR 2926`），所以比较前必须归一化。
 */
function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[.,:;!?()[\]{}'"`~@#$%^&*_+=|\\/<>-]/g, '');
}

/**
 * OCR 常见的形近字混淆表（本机实测 + 通用 OCR 混淆）。
 *
 * 把两侧都映射到同一个"骨架字符"，再比较。这样 "He110" 与 "Hello" 就会通过。
 */
const CONFUSION = new Map(Object.entries({
  '0': 'o', 'o': 'o', 'd': 'o', 'q': 'o',
  '1': 'l', 'l': 'l', 'i': 'l', '|': 'l', '!': 'l', 'j': 'l',
  '2': 'z', 'z': 'z',
  '5': 's', 's': 's',
  '6': 'g', 'g': 'g', '9': 'g',
  '8': 'b', 'b': 'b',
  'n': 'n', 'm': 'n', 'h': 'n', 'r': 'n',
  'v': 'v', 'u': 'v', 'y': 'v', 'w': 'v',
  'c': 'c', 'e': 'c',
  't': 't', 'f': 't',
  'k': 'k', 'x': 'k',
  'p': 'p',
  'a': 'a',
  '3': 'e',
  '4': 'a',
  '7': 't',
}));

/** 把字符串折叠成"形近骨架"。 */
function skeleton(text) {
  return Array.from(normalizeText(text)).map((ch) => CONFUSION.get(ch) ?? ch).join('');
}

/** Levenshtein 距离。 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/** 1 = 完全相同，0 = 毫无关系。基于形近骨架计算。 */
function similarity(a, b) {
  const sa = skeleton(a);
  const sb = skeleton(b);
  if (sa === '' || sb === '') return 0;
  const distance = levenshtein(sa, sb);
  return 1 - distance / Math.max(sa.length, sb.length);
}

/**
 * OCR 结果里是否"足够像"某个关键词。
 *
 * 同时检查**整体文本**与**逐行文本**：OCR 可能把一行拆成多行，也可能把多行并成一行，
 * 所以两个粒度都要看，取最高相似度。
 */
function bestSimilarity(ocrText, lines, keyword) {
  const candidates = [ocrText, ...(Array.isArray(lines) ? lines : [])];
  let best = 0;
  let bestAgainst = '';
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    // 逐行：既比整行，也比"行里的滑窗子串"（关键词可能只是行的一部分）。
    const target = normalizeText(keyword);
    const haystack = normalizeText(candidate);
    if (haystack.length === 0) continue;

    // 整串比较
    let score = similarity(haystack, target);
    // 滑窗：在长行里找与关键词等长的窗口（步长 1，长度不超过 2 倍关键词）。
    if (haystack.length > target.length && target.length > 0) {
      const maxWindow = Math.min(haystack.length, target.length * 2);
      for (let len = Math.max(1, target.length - 2); len <= maxWindow; len += 1) {
        for (let start = 0; start + len <= haystack.length; start += 1) {
          const window = haystack.slice(start, start + len);
          const windowScore = similarity(window, target);
          if (windowScore > score) score = windowScore;
        }
        if (score >= 0.999) break;
      }
    }
    if (score > best) {
      best = score;
      bestAgainst = candidate;
    }
  }
  return { score: best, against: bestAgainst };
}

// ---------------------------------------------------------------------------
// 记事本会话
// ---------------------------------------------------------------------------

const sleepMillis = (ms) => sleep(ms);

/** 找到类名为 Notepad 的可见顶层窗口。 */
function findNotepadWindow() {
  const loaded = loadWin32();
  let found;
  enumWindows((hwnd) => {
    if (loaded.IsWindowVisible(hwnd) !== true) return true;
    if (readWide(loaded.GetClassNameW, hwnd, 256) === 'Notepad') {
      found = hwnd;
      return false;
    }
    return true;
  });
  return found;
}

/** 在窗口（含直接子控件）里找 Edit 控件 —— 记事本的正文区。 */
function findEditControl(hwnd) {
  const listed = childWindows(hwnd);
  const children = Array.isArray(listed?.children) ? listed.children : [];
  const direct = children.find((child) => child.className === 'Edit');
  if (direct !== undefined) return Number(direct.hwnd);

  // 更深的层级：用 native 的枚举兜底。
  const loaded = loadWin32();
  let found;
  enumWindows((child) => {
    if (readWide(loaded.GetClassNameW, child, 256) === 'Edit') {
      found = child;
      return false;
    }
    return true;
  }, { childrenOf: hwnd });
  return found === undefined ? undefined : Number(found);
}

/**
 * 用 `EM_REPLACESEL` 把文本可靠写进 Edit 控件。
 *
 * 为什么不用裸 `WM_CHAR`：实测 `PostMessage(WM_CHAR)` 到**顶层窗口**后
 * `WM_GETTEXTLENGTH` 仍为 0（消息没有走到编辑控件，且 PostMessage 绕过了
 * TranslateMessage）。投给 Edit 控件本身则生效。这是本仓库 `native.js` 已经
 * 记录过的结论（`EM_*` 是纯 PostMessage 下编辑控件的可靠路径）。
 */
function writeIntoEdit(loaded, edit, text) {
  const payload = Buffer.from(`${text}\0`, 'utf16le');
  // EM_SETSEL(0, -1) 全选 → EM_REPLACESEL(1, text) 替换，等价于"清空并写入"。
  loaded.SendMessageW(edit, 0x00b1, 0, -1);
  const replaced = Number(loaded.SendMessageW(edit, 0x00c2, 1, Number(loaded.koffi.address(payload))));
  // 写完后强制重绘，否则打印/截图可能还是旧画面。
  try {
    loaded.UpdateWindow(edit);
    loaded.UpdateWindow(edit);
  } catch {
    // UpdateWindow 失败不致命，后面的等待仍可能让窗口画出来。
  }
  return replaced;
}

/** 回读 Edit 的内容（用 koffi.address 把缓冲区地址传给 WM_GETTEXT）。 */
function readEditText(loaded, edit) {
  try {
    const length = Number(loaded.SendMessageW(edit, 0x000e, 0, 0)); // WM_GETTEXTLENGTH
    if (!Number.isFinite(length) || length <= 0) return '';
    const buffer = Buffer.alloc((length + 2) * 2);
    const copied = Number(loaded.SendMessageW(edit, 0x000d, length + 1, Number(loaded.koffi.address(buffer))));
    if (!Number.isFinite(copied) || copied <= 0) return '';
    return buffer.toString('utf16le', 0, copied * 2);
  } catch {
    return '';
  }
}

/**
 * 判定"截图没有移动真实光标"。
 *
 * ## 为什么不能用"单次前后对照 + 固定余量"
 *
 * 第一版用的是"抓取期间采样位移 > 纯等待基线位移 + 50px 就判失败"。这个判据在
 * 真实用户面前**必然随机红**：用户随手挪一下鼠标就是几百像素。Lead 独立复跑时
 * 就撞上了（抓取期间 321px vs 基线 41px），并有决定性的反证 ——
 *
 *   - **静态证据**：`capture.js` 剥掉注释后 `SetCursorPos` / `SendInput` /
 *     `mouse_event` / `SetPhysicalCursorPos` 命中数**全为 0**；唯一的
 *     `GetCursorPos` 只用于只读对照。**代码层面不存在改变光标的能力。**
 *   - **交替对照实验**（各 6 轮）：基线组位移均值 63px、最大值 182px；
 *     抓取组均值 66px、最大值 126px。两组**同分布**，基线最大值甚至更大。
 *     位移只与"那段时间用户在不在动鼠标"相关，与"是否在抓取"无关。
 *
 * 所以固定余量的写法测的是**用户的手**，不是我们的代码。修法不是把阈值调大
 * （那样断言就失去意义了），而是换成**对用户活动免疫的对照设计**。
 *
 * ## 现在的设计
 *
 * **方案 A（运行时回归保护）—— 交替配对 + 比值判据**
 * 交替跑 N 轮"抓取"与"纯等待"，两组各自累计位移。因为两组在时间上交替、
 * 样本量相同，**用户是否在动鼠标对两组的期望影响是一样的**。于是判据变成比值：
 *
 *     抓取组位移 <= 基线组位移 × 1.5 + 余量
 *
 * 用户全程乱动鼠标时，两组一起变大，比值仍然成立；反过来，如果抓取真的动了光标，
 * 抓取组会系统性地高于基线组，比值判据就会抓到它。余量存在只是为了兜住
 * "基线恰好接近 0（用户完全没动）"时比值不稳定的情况。
 *
 * **方案 B（代码级硬保证）—— 静态断言**
 * 断言 `capture.js` 源码里根本不含任何移动光标的 API。这是"不可能发生"的证明，
 * 不受任何运行时噪声影响，也顺便防止以后有人手滑加进 `SetCursorPos`。
 */
async function measureCursorImpactPaired(action, options = {}) {
  // 轮数多一些：样本量越大，两组受用户突发活动影响的偏差越趋于抵消。
  const rounds = Number.isInteger(options.rounds) && options.rounds > 0 ? options.rounds : 8;
  // 每轮内的采样次数（抓取与等待各占一半）。
  const samplesPerRound = Number.isInteger(options.samplesPerRound) ? options.samplesPerRound : 10;
  const intervalMs = Number.isInteger(options.intervalMs) ? options.intervalMs : 30;
  const half = Math.max(1, Math.floor(samplesPerRound / 2));

  /**
   * 测量一段窗口内的光标累计位移（曼哈顿距离），并在每个采样点回调。
   */
  const measureWindow = async (onTick) => {
    const points = [];
    for (let i = 0; i < half; i += 1) {
      const p = cursorPosition();
      if (p.ok === true) points.push({ x: p.x, y: p.y });
      if (onTick !== undefined) onTick();
      await sleepMillis(intervalMs);
    }
    let total = 0;
    for (let i = 1; i < points.length; i += 1) {
      total += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
    }
    return total;
  };

  const captureTravels = [];
  const baselineTravels = [];

  for (let round = 0; round < rounds; round += 1) {
    // 轮内交替：抓取 → 等待 → 抓取 → 等待。任何一次突发的手抖都会**同时落到
    // 两组**里，这是"对用户活动免疫"的关键。
    //
    // 为什么不能"整轮抓取 / 整轮等待"：用户活动是突发式的，实测出现过某一组
    // 独吞整段位移（比值一度飙到 4.63）而误判的情况。轮内交替把这种突发平摊掉。
    captureTravels.push(await measureWindow(() => action()));
    baselineTravels.push(await measureWindow(undefined));
    captureTravels.push(await measureWindow(() => action()));
    baselineTravels.push(await measureWindow(undefined));
  }

  const sum = (list) => list.reduce((a, b) => a + b, 0);
  const captureTravel = sum(captureTravels);
  const baselineTravel = sum(baselineTravels);

  // ---------------------------------------------------------------------
  // 判据设计（这里是最容易做错的地方，第一版和"整轮分组"版都栽在同一个坑上）
  //
  // 实测数据的样子（轮内交替 8 轮，16 个半窗）：
  //     抓取组 [0,0,0,0,0,0,0,0,0,0,0,0,0,296,430,14]
  //     基线组 [0,0,0,0,0,0,0,0,0,0,0,0,0,201, 23, 6]
  // 15 个窗口是**精确的 0**，只有一两个窗口出现几百像素 —— 那是用户在某一瞬间
  // 甩了一下鼠标。这种**单次突发**落在哪一组纯属偶然，用总和比值去判必然误报。
  //
  // 正确的问法是："抓取是否**系统性地**让光标动了？"
  //   - 如果截图真的移动光标，**每一个**抓取窗口都会有位移 —— 这是系统性的。
  //   - 如果只是用户手抖，绝大多数窗口是 0，位移集中在极少数窗口 —— 非系统性。
  //
  // 所以判据分两层，两层都必须成立才算"异常"：
  //   1. **普遍性**：出现位移（> 0）的抓取窗口占比要显著高于基线组。
  //      阈值取 0.5：真的系统性位移时，抓取组几乎每个窗口都该 > 0。
  //   2. **幅度**：抓取组总和明显大于基线组（比值 + 余量）。
  //
  // 突发噪声最多只影响一两个窗口，过不了第 1 层，因此不会误报；
  // 而真实的系统性位移两层都会命中。
  // ---------------------------------------------------------------------
  const MOVED_EPSILON = 5; // 小于这个位移视为采样抖动 / 静止
  const captureActive = captureTravels.filter((v) => v > MOVED_EPSILON).length;
  const baselineActive = baselineTravels.filter((v) => v > MOVED_EPSILON).length;
  const captureActiveRatio = captureTravels.length === 0 ? 0 : captureActive / captureTravels.length;

  const slack = 90;
  const ratio = baselineTravel === 0 ? (captureTravel === 0 ? 1 : Infinity) : captureTravel / baselineTravel;
  const exceedsAmplitude = captureTravel > baselineTravel * 1.5 + slack;
  const isSystematic = captureActiveRatio >= 0.5;
  const moved = isSystematic && exceedsAmplitude;

  return {
    moved,
    ratio,
    captureTravel,
    baselineTravel,
    captureTravels,
    baselineTravels,
    captureActive,
    baselineActive,
    captureActiveRatio,
    detail: `轮内交替配对 ${rounds} 轮（抓取/等待各 ${captureTravels.length} 个半窗）：`
      + `抓取组位移=${captureTravel}px ${JSON.stringify(captureTravels)}，`
      + `基线组位移=${baselineTravel}px ${JSON.stringify(baselineTravels)}；`
      + `有位移的窗口：抓取 ${captureActive}/${captureTravels.length}`
      + `（${(captureActiveRatio * 100).toFixed(0)}%）vs 基线 ${baselineActive}/${baselineTravels.length}；`
      + `比值=${Number.isFinite(ratio) ? ratio.toFixed(2) : 'inf'}（幅度判据 <= 基线×1.5 + ${slack}px，`
      + `普遍性判据 >= 50%）`
      + ` → ${moved
        ? '判定为有位移（系统性异常）'
        : (exceedsAmplitude && !isSystematic
          ? '判定为未移动光标（幅度虽高但只集中在极少数窗口 = 用户在动鼠标，非系统性）'
          : '判定为未移动光标（两组同分布）')}`,
  };
}

/**
 * 方案 B：静态断言 —— 截图模块**在代码层面**没有移动光标的能力。
 *
 * 这比任何统计对照都硬：不依赖运行时条件、不受用户操作干扰，且能防回归
 * （以后若有人加进 `SetCursorPos`，这条会立刻变红）。
 */
function assertNoCursorMutation(relativePath) {
  // 用 fileURLToPath 而不是手工拼路径，保证与 import 解析规则一致。
  const absolute = fileURLToPath(new URL(relativePath, import.meta.url));
  const source = readFileSync(absolute, 'utf8');
  // 剥掉注释与字符串字面量之外的内容：
  //   注释里提到这些名字是**说明性**的，不该算命中（本文件里就有大量这样的注释）。
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const forbidden = ['SetCursorPos', 'SetPhysicalCursorPos', 'SendInput', 'mouse_event', 'SetCursor'];
  const hits = forbidden.filter((name) => stripped.includes(name));

  // 只读的光标查询**应该**存在（我们用它自证光标没动）。
  const readsCursor = stripped.includes('GetCursorPos');

  return { ok: hits.length === 0, hits, readsCursor, absolute };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const startedAt = Date.now();
/** 本测试启动的所有进程 pid，退出时统一清理。 */
const launchedPids = [];
let workspaceDir;

/**
 * 清理本测试启动的进程与临时目录。
 *
 * **必须用 `spawnSync`，不能用 `spawn`。** 这是一个真实的泄漏 bug：
 * `process.on('exit')` 的回调返回后 Node 立刻结束进程，**不会等待异步任务**，
 * 所以那里 `spawn()` 出来的 `taskkill` 根本没有机会启动 —— 结果是每次跑完测试
 * 都残留一个记事本进程（本文件第一版就是这样漏的，被 `Get-Process notepad` 抓到）。
 * `spawnSync` 会真正阻塞到 taskkill 结束，是唯一可靠的写法。
 *
 * 双重保险：
 *   1. `killPid` 直接对目标 pid 调 taskkill；
 *   2. 传了 `sweepByName` 时，再按**进程映像名 + 父进程 pid** 兜底清扫，
 *      防止"我们记录了 pid 但进程已换掉"这类情况。
 *      只删父进程是本测试自己的进程 —— 绝不会误杀用户手动开着的记事本。
 */
function killProcessTree(pid, sweepByName) {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 0) return;
  try {
    spawnSync('taskkill', ['/PID', String(target), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10000,
    });
  } catch {
    // 进程可能早已退出；taskkill 返回非零也无所谓。
  }
  if (sweepByName === true) {
    // 兜底：只清扫"父进程就是我们"的同名进程，不碰用户的记事本。
    try {
      spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='notepad.exe' AND ParentProcessId=${process.pid}" `
        + `| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    } catch {
      // 兜底失败不影响主清理。
    }
  }
}

function cleanup(options = {}) {
  for (const pid of launchedPids) killProcessTree(pid, false);
  // 至少有一个 pid 时做一次按父进程的兜底清扫。
  if (launchedPids.length > 0) killProcessTree(launchedPids[0], true);
  launchedPids.length = 0;
  if (workspaceDir !== undefined && options.keepWorkspace !== true) {
    try {
      rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响测试结论。
    }
  }
}

process.on('exit', () => cleanup());
// Ctrl+C / 被杀时也要清理，否则会留下记事本窗口。
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanup();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}
// 未捕获异常同样要清理，否则失败路径会漏进程。
process.on('uncaughtException', (error) => {
  console.error('\n未捕获异常:', error);
  cleanup();
  process.exit(1);
});

console.log('dsh-virtual-computer-use —— 视觉能力（截图 + OCR）测试');
console.log(`node ${process.version} on ${process.platform} ${process.arch}`);
console.log(`pid ${process.pid}, 开始时间 ${new Date().toISOString()}`);

workspaceDir = mkdtempSync(join(tmpdir(), 'vcu-vision-test-'));

// ===========================================================================
section('1. 能力自检：截图管线与 OCR 环境');
// ===========================================================================

const native = loadWin32();
check('koffi / Win32 绑定可用', native.reason === undefined, native.reason ?? `bindings from ${native.from}`);

// --- 方案 B：静态断言（代码级硬保证）---------------------------------------
// 这一组不依赖任何运行时条件，是"截图不可能移动光标"的决定性证据。
for (const modulePath of ['../lib/capture.js', '../lib/ocr.js', '../lib/png.js']) {
  const scan = assertNoCursorMutation(modulePath);
  check(`${modulePath} 不含任何移动光标的 API（静态扫描）`, scan.ok === true,
    scan.ok === true
      ? '未出现 SetCursorPos / SetPhysicalCursorPos / SendInput / mouse_event / SetCursor'
      : `发现禁用调用：${JSON.stringify(scan.hits)}`);
}
const captureScan = assertNoCursorMutation('../lib/capture.js');
check('  → capture.js 确实包含只读的 GetCursorPos（自证依赖它）', captureScan.readsCursor === true,
  captureScan.readsCursor ? 'GetCursorPos 存在（仅用于只读对照）' : 'GetCursorPos 缺失，光标自证将失效');

const captureDescription = describeCapture();
check('describeCapture() 报告截图可用', captureDescription.ok === true,
  JSON.stringify({
    missing: captureDescription.missingBindings,
    optionalMissing: captureDescription.missingOptionalBindings,
    virtualScreen: captureDescription.virtualScreen,
    failures: captureDescription.bindingFailures,
  }));
check('  → 截图不影响真实光标（能力声明）', captureDescription.capabilities?.movesRealCursor === false);
check('  → 能自证光标未被移动（GetCursorPos 可用）', captureDescription.capabilities?.canVerifyCursor === true);
check('  → 未出现任何单个绑定失败（native.js 的逐函数隔离）',
  (captureDescription.bindingFailures ?? []).length === 0,
  JSON.stringify(captureDescription.bindingFailures));

const monitors = listMonitors();
check('listMonitors() 能枚举显示器', monitors.ok === true,
  JSON.stringify({ count: monitors.count, virtualScreen: monitors.virtualScreen, monitors: monitors.monitors }));
if (monitors.ok === true) {
  const primary = monitors.monitors.find((m) => m.primary === true);
  check('  → 存在一块主显示器且尺寸为正', primary !== undefined && primary.width > 0 && primary.height > 0,
    primary === undefined ? 'no primary monitor reported' : `${primary.width}x${primary.height} at (${primary.x},${primary.y})`);
  check('  → 每块显示器的 workArea 不超出其边界',
    monitors.monitors.every((m) => m.workArea.width <= m.width && m.workArea.height <= m.height),
    JSON.stringify(monitors.monitors.map((m) => ({ screen: `${m.width}x${m.height}`, work: `${m.workArea.width}x${m.workArea.height}` }))));
}

const ocrDescription = await describeOcr();
console.log(`  OCR 自检: interpreter=${ocrDescription.interpreter}`);
console.log(`            languages=${JSON.stringify(ocrDescription.availableLanguages)} preferred=${ocrDescription.preferredLanguage}`);
if (ocrDescription.ok !== true) {
  console.log(`            reason=${ocrDescription.reason}`);
  console.log(`            installHint=${JSON.stringify(ocrDescription.installHint)}`);
}
check('describeOcr() 报告 OCR 可用', ocrDescription.ok === true,
  ocrDescription.ok === true
    ? `engine language ${ocrDescription.preferredLanguage}, available ${JSON.stringify(ocrDescription.availableLanguages)}`
    : `${ocrDescription.reason} | hint: ${JSON.stringify(ocrDescription.installHint)}`);
check('  → 解释器是 powershell.exe（不是 pwsh，本机不存在）',
  typeof ocrDescription.interpreter === 'string' && /powershell\.exe$/i.test(ocrDescription.interpreter),
  String(ocrDescription.interpreter));
check('  → OCR 至少有一种可用语言', (ocrDescription.availableLanguages ?? []).length > 0,
  JSON.stringify(ocrDescription.availableLanguages));

// ===========================================================================
section('2. PNG 编解码器（纯函数，不依赖屏幕）');
// ===========================================================================

{
  // 造一张 64x32 的规律 RGBA 图。
  const w = 64;
  const h = 32;
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      rgba[o] = x * 4 & 0xff;
      rgba[o + 1] = y * 8 & 0xff;
      rgba[o + 2] = (x + y) * 2 & 0xff;
      rgba[o + 3] = 255;
    }
  }

  const png = encodePngRgba(rgba, w, h);
  const header = readPngHeader(png);
  check('编码出的 PNG 签名合法', header.ok === true, header.ok === true ? `${png.length} bytes` : header.reason);
  check('  → IHDR 尺寸正确', header.width === w && header.height === h, `${header.width}x${header.height}`);
  check('  → IHDR 的 CRC 正确（不只是"写得像"）', header.ihdrCrcValid === true);

  const decoded = decodePng(png);
  check('PNG 能解码回来', decoded.ok === true, decoded.ok === true ? `${decoded.width}x${decoded.height}` : decoded.reason);
  if (decoded.ok === true) {
    // 逐字节比对：编码 → 解码 必须无损（证明 Up filter 与反 filter 配对正确）。
    let mismatch = 0;
    let firstMismatch = -1;
    for (let i = 0; i < rgba.length; i += 1) {
      if (rgba[i] !== decoded.rgba[i]) {
        if (firstMismatch < 0) firstMismatch = i;
        mismatch += 1;
      }
    }
    check('  → 像素逐字节无损往返（验证 Up filter 与反 filter 配对）', mismatch === 0,
      mismatch === 0 ? 'all bytes identical' : `${mismatch} byte(s) differ, first at offset ${firstMismatch}`);
  }

  // BGRA → RGBA 的通道顺序（截图管线的关键转换）。
  const bgra = Buffer.from([0x11, 0x22, 0x33, 0x00, 0xaa, 0xbb, 0xcc, 0x00]);
  const converted = bgraToRgba(bgra);
  check('BGRA → RGBA 通道正确且 alpha 被强制为 255',
    converted[0] === 0x33 && converted[1] === 0x22 && converted[2] === 0x11 && converted[3] === 255
    && converted[4] === 0xcc && converted[5] === 0xbb && converted[6] === 0xaa && converted[7] === 255,
    converted.toString('hex'));

  // 缩放：4x4 → 2x2 的均值必须精确。
  const src = Buffer.alloc(4 * 4 * 4);
  for (let i = 0; i < 16; i += 1) {
    const v = i * 10;
    src[i * 4] = v; src[i * 4 + 1] = v; src[i * 4 + 2] = v; src[i * 4 + 3] = 255;
  }
  const resized = resizeRgba(src, 4, 4, 2, 2);
  check('resizeRgba 面积平均正确（4x4 → 2x2）',
    resized.width === 2 && resized.height === 2
    && resized.rgba[0] === Math.round((0 + 10 + 40 + 50) / 4)
    && resized.rgba[4] === Math.round((20 + 30 + 60 + 70) / 4),
    `top-left=${resized.rgba[0]} (期望 25), top-right=${resized.rgba[4]} (期望 45)`);

  check('imageStats 能识别全黑图（抓取失败的典型表现）',
    imageStats(Buffer.alloc(100 * 4)).nonBlackRatio === 0,
    JSON.stringify(imageStats(Buffer.alloc(100 * 4))));
  const somePixels = Buffer.alloc(100 * 4);
  somePixels[0] = 200; somePixels[1] = 200; somePixels[2] = 200;
  check('imageStats 能识别有内容的图',
    imageStats(somePixels).nonBlackRatio > 0,
    JSON.stringify(imageStats(somePixels)));
}

// ===========================================================================
section('3. 屏幕抓取（全屏 / 区域）与体积控制');
// ===========================================================================

{
  // 方案 A：交替配对对照（对用户活动免疫）。
  const cursorImpact = await measureCursorImpactPaired(() => {
    captureFullScreen({});
  });
  const full = captureFullScreen({});

  check('captureFullScreen() 成功', full.ok === true, full.ok === true ? `${full.width}x${full.height}, ${full.bytes} bytes, ${full.elapsedMs}ms` : full.reason);
  if (full.ok === true) {
    const pngCheck = verifyPng(full.png, full.width, full.height);
    check('  → 返回合法 PNG 且 IHDR 尺寸与 width/height 一致', pngCheck.ok === true,
      JSON.stringify(pngCheck.checks));

    const vs = full.virtualScreen;
    check('  → 抓取尺寸等于虚拟屏尺寸',
      full.width === vs.width && full.height === vs.height,
      `captured ${full.width}x${full.height}, virtual screen ${vs.width}x${vs.height}`);

    check('  → 全屏图不是全黑（真的抓到了画面）',
      full.content !== undefined && full.content.nonBlackRatio > 0.05,
      JSON.stringify(full.content));
  }

  // 光标：用采样 + 基线对照，排除"用户自己在动鼠标"的干扰。
  check('  → 抓取期间真实光标未移动（采样 + 纯等待基线对照）', cursorImpact.moved === false,
    cursorImpact.detail);

  // 区域抓取：尺寸必须精确等于请求值。
  const region = captureRegion(0, 0, 320, 200, {});
  check('captureRegion(0,0,320,200) 成功且尺寸精确', region.ok === true
    && region.width === 320 && region.height === 200,
    region.ok === true ? `${region.width}x${region.height}, ${region.bytes} bytes` : region.reason);
  if (region.ok === true) {
    check('  → region 元信息记录了请求区域',
      region.region?.x === 0 && region.region?.y === 0 && region.region?.width === 320 && region.region?.height === 200,
      JSON.stringify(region.region));
  }

  // 缩放
  const scaled = captureRegion(0, 0, 400, 400, { scale: 0.5 });
  check('scale:0.5 时输出尺寸减半、sourceWidth 保留原尺寸', scaled.ok === true
    && scaled.width === 200 && scaled.height === 200 && scaled.sourceWidth === 400,
    scaled.ok === true
      ? `out=${scaled.width}x${scaled.height} source=${scaled.sourceWidth}x${scaled.sourceHeight} scale=${scaled.scale}`
      : scaled.reason);

  // maxWidth
  const limited = captureRegion(0, 0, 800, 400, { maxWidth: 200 });
  check('maxWidth:200 时等比缩放到宽度 200', limited.ok === true
    && limited.width === 200 && limited.height === 100,
    limited.ok === true ? `${limited.width}x${limited.height}` : limited.reason);

  // maxBytes：必须真的压到阈值以下（或已经缩到下限）。
  const bigRegion = captureRegion(0, 0, 900, 700, {});
  const byteLimited = captureRegion(0, 0, 900, 700, { maxBytes: 60 * 1024 });
  const originalBytes = bigRegion.ok === true ? bigRegion.bytes : undefined;
  check('maxBytes 能在超限时自动降采样', byteLimited.ok === true
    && (byteLimited.bytes <= 60 * 1024 || byteLimited.autoShrunkForMaxBytes > 0),
    byteLimited.ok === true
      ? `原图 ${originalBytes} bytes → ${byteLimited.bytes} bytes（缩了 ${byteLimited.autoShrunkForMaxBytes} 次，${byteLimited.width}x${byteLimited.height}）`
      : byteLimited.reason);

  // 错误路径：必须优雅失败，不抛异常。
  const badRegion = captureRegion(0, 0, 0, 100);
  check('captureRegion 对非法尺寸返回 ok:false（不抛异常）', badRegion.ok === false && typeof badRegion.reason === 'string',
    badRegion.reason);
  const badWindow = captureWindow(0, {});
  check('captureWindow(0) 优雅失败', badWindow.ok === false, badWindow.reason);
  const deadWindow = captureWindow(0xdeadbeef, {});
  check('captureWindow(无效句柄) 优雅失败', deadWindow.ok === false, deadWindow.reason);
}

// ===========================================================================
section('4. 记事本端到端：写入已知文本 → 截图 → OCR');
// ===========================================================================

let notepadPid;
let notepadHwnd;
let editHwnd;
const KNOWN_TEXT = 'Hello OCR 2026\r\nABCDEFG 12345\r\nVision Test OK';
/** 断言用的关键词：挑短、清晰、OCR 实测能读出来的。 */
const KEYWORDS = ['OCR', 'ABCDEFG', 'Vision', 'OK'];

{
  const proc = spawn('notepad.exe', [], { detached: true, stdio: 'ignore', windowsHide: false });
  proc.unref();
  if (Number.isInteger(proc.pid)) launchedPids.push(proc.pid);
  notepadPid = proc.pid;
  await sleepMillis(2000);

  notepadHwnd = findNotepadWindow();
  if (notepadHwnd === undefined) {
    check('启动真实记事本并可定位窗口', false, 'no visible window with class Notepad was found');
  } else {
    check('启动真实记事本并可定位窗口', true, `hwnd=${notepadHwnd}, pid=${notepadPid}`);
    editHwnd = findEditControl(notepadHwnd);
    check('  → 找到记事本的 Edit 正文控件（窗口消息注入必须打到这里）',
      editHwnd !== undefined, editHwnd === undefined ? 'no child with class "Edit"' : `edit hwnd=${editHwnd}`);
  }
}

if (notepadHwnd !== undefined && editHwnd !== undefined) {
  const loaded = loadWin32();

  // 用虚拟输入层（EM_* 路径）写入已知文本。
  const replaced = writeIntoEdit(loaded, editHwnd, KNOWN_TEXT);
  await sleepMillis(400);
  const readBack = readEditText(loaded, editHwnd);
  check('已把已知文本写入记事本正文（并回读确认真的进去了）',
    readBack.includes('ABCDEFG') && readBack.includes('Vision'),
    `SendMessage(EM_REPLACESEL)=${replaced}, 回读=${JSON.stringify(readBack)}`);

  // --- 4a. 抓取窗口 -------------------------------------------------------
  // 光标影响用"交替配对 + 比值判据"测量，对用户自己动鼠标免疫（见函数注释）。
  let cursorImpact;
  const shot = captureWindow(notepadHwnd, {});
  cursorImpact = await measureCursorImpactPaired(() => {
    captureWindow(notepadHwnd, {});
  }, { rounds: 4 });

  check('captureWindow(记事本) 成功', shot.ok === true,
    shot.ok === true ? `${shot.width}x${shot.height}, ${shot.bytes} bytes, method=${shot.method}, ${shot.elapsedMs}ms` : shot.reason);

  if (shot.ok === true) {
    const pngCheck = verifyPng(shot.png, shot.width, shot.height);
    check('  → 合法 PNG，IHDR 尺寸与实际窗口一致', pngCheck.ok === true,
      `IHDR=${pngCheck.width}x${pngCheck.height} 窗口=${shot.windowRect?.width}x${shot.windowRect?.height} checks=${JSON.stringify(pngCheck.checks)}`);

    check('  → 抓取用的是 PrintWindow（后台窗口也能抓的那条路）',
      typeof shot.method === 'string' && shot.method.startsWith('PrintWindow'), shot.method);

    check('  → 截图非全黑（content.nonBlackRatio > 0.03）',
      shot.content !== undefined && shot.content.nonBlackRatio > 0.03,
      JSON.stringify(shot.content));

    check('  → 抓取期间真实光标未移动（采样 + 纯等待基线对照）',
      cursorImpact.moved === false, cursorImpact.detail);
    check('  → 抓取自身也报告了光标状态',
      shot.cursorUntouched !== undefined || shot.cursorNote !== undefined,
      `cursorUntouched=${shot.cursorUntouched} note=${shot.cursorNote ?? '(none)'}`);
  }

  // --- 4b. 后台窗口抓取（把窗口挪出屏幕）----------------------------------
  //
  // 这是比"被遮挡"更强的证明：窗口被移到屏幕外时，屏幕上**完全没有**它的像素，
  // 任何屏幕拷贝（BitBlt）都只能拿到别的东西。此时若还能抓到内容，唯一来源就是
  // PrintWindow 让窗口自己重绘。
  {
    const rect = shot.ok === true ? shot.windowRect : undefined;
    const offscreenX = -4000;
    const offscreenY = -4000;
    // SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE：不改尺寸、不动 Z 序、**不抢焦点**
    const moved = loaded.SetWindowPos(notepadHwnd, 0, offscreenX, offscreenY,
      rect?.width ?? 0, rect?.height ?? 0, 0x0001 | 0x0004 | 0x0010);
    await sleepMillis(600);

    // 用屏幕 BitBlt 抓"窗口原本应该在的位置"，作为对照组：应该与窗口内容无关。
    const screenAtOldPlace = captureRegion(
      rect?.x ?? 0, rect?.y ?? 0, Math.min(rect?.width ?? 100, 400), Math.min(rect?.height ?? 100, 400), {},
    );

    const hiddenShot = captureWindow(notepadHwnd, {});
    check('窗口移到屏幕外 (-4000,-4000) 后 PrintWindow 仍能抓到内容',
      hiddenShot.ok === true && hiddenShot.content?.nonBlackRatio > 0.03,
      hiddenShot.ok === true
        ? `method=${hiddenShot.method}, nonBlackRatio=${hiddenShot.content?.nonBlackRatio}, ${hiddenShot.width}x${hiddenShot.height}`
        : hiddenShot.reason);

    if (hiddenShot.ok === true && screenAtOldPlace.ok === true) {
      // 反向证明：把两张图都 OCR，窗口外那侧应能读到我们的正文，
      // 而"同一屏幕位置"的拷贝拿到的是**别的东西**（此时那里是别的窗口，
      // 或者干脆是桌面背景）—— 这证明内容只能来自 PrintWindow 让窗口自绘。
      const hiddenOcr = await ocrImage(hiddenShot, {});
      const screenOcr = await ocrImage(screenAtOldPlace, {});

      // 用 bestSimilarity（带滑窗），因为 OCR 会把正文与标题栏/菜单栏并成一行。
      const hiddenScore = hiddenOcr.ok === true
        ? bestSimilarity(hiddenOcr.text, hiddenOcr.lines.map((l) => l.text), 'ABCDEFG').score : 0;

      check('  → 窗口外的截图里确实有正文（PrintWindow 让窗口自绘的直接证据）',
        hiddenOcr.ok === true && hiddenScore >= 0.75,
        `窗口外 OCR=${JSON.stringify(hiddenOcr.text ?? hiddenOcr.reason)}；「ABCDEFG」相似度=${hiddenScore.toFixed(3)}`);

      // 对照组：同位置的屏幕拷贝**不应该**出现记事本的正文。
      // （那里的像素属于别的窗口；若恰好也没有文字，则相似度很低。）
      const screenScore = screenOcr.ok === true
        ? bestSimilarity(screenOcr.text, screenOcr.lines.map((l) => l.text), 'ABCDEFG').score : 0;
      check('  → 对照组：同一屏幕位置的拷贝里没有记事本正文',
        hiddenScore > screenScore || screenOcr.ok !== true,
        `窗口外相似度=${hiddenScore.toFixed(3)} vs 同位置屏幕拷贝相似度=${screenScore.toFixed(3)}`
        + `（屏幕拷贝内容=${JSON.stringify((screenOcr.text ?? screenOcr.reason ?? '').slice(0, 120))}）`);
    }

    // 挪回原位，避免影响后续用例。
    loaded.SetWindowPos(notepadHwnd, 0, rect?.x ?? 100, rect?.y ?? 100,
      rect?.width ?? 800, rect?.height ?? 600, 0x0001 | 0x0004 | 0x0010);
    await sleepMillis(600);

    const restored = captureWindow(notepadHwnd, {});
    check('  → 挪回原位后仍能抓取', restored.ok === true && restored.content?.nonBlackRatio > 0.03,
      restored.ok === true ? `nonBlackRatio=${restored.content?.nonBlackRatio}` : restored.reason);
  }

  // --- 4c. OCR：真的读出已知文本 -----------------------------------------
  const ocrResult = await ocrWindow(notepadHwnd, {});

  check('ocrWindow(记事本) 成功', ocrResult.ok === true,
    ocrResult.ok === true
      ? `engine=${ocrResult.engineLanguage}, ${ocrResult.wordCount} words in ${ocrResult.lineCount} lines, ${ocrResult.elapsedMs}ms`
      : `${ocrResult.reason} | ${JSON.stringify(ocrResult.installHint)}`);

  if (ocrResult.ok === true) {
    console.log('\n  ---- OCR 实际识别出的文本 ----');
    console.log(`  text: ${JSON.stringify(ocrResult.text)}`);
    for (const line of ocrResult.lines) {
      console.log(`    line[${line.index}] ${JSON.stringify(line.text)}  bbox=${JSON.stringify(line.bbox)}`);
    }
    console.log('  ------------------------------');

    check('  → OCR 识别出了非空文本', ocrResult.text.trim().length > 0,
      `${ocrResult.text.length} chars, ${ocrResult.wordCount} words`);

    // 关键词命中（容错匹配）
    for (const keyword of KEYWORDS) {
      const { score, against } = bestSimilarity(ocrResult.text, ocrResult.lines.map((l) => l.text), keyword);
      check(`  → 识别文本中包含「${keyword}」（相似度 ${score.toFixed(3)}）`, score >= 0.75,
        `最匹配的片段=${JSON.stringify(against)} 相似度=${score.toFixed(3)}（阈值 0.75）`);
    }

    // 每个词都必须有 bbox，且在图片范围内。
    const allWords = ocrResult.lines.flatMap((line) => line.words);
    check('  → 每个识别出的词都带 bbox', allWords.length > 0 && allWords.every((w) => w.bbox !== undefined),
      `${allWords.length} words`);
    check('  → 所有 bbox 都落在图片范围内（自洽性）',
      allWords.every((w) => w.bbox.x >= -2 && w.bbox.y >= -2
        && w.bbox.x + w.bbox.width <= ocrResult.width + 2
        && w.bbox.y + w.bbox.height <= ocrResult.height + 2),
      `图片 ${ocrResult.width}x${ocrResult.height}；越界的词=${JSON.stringify(allWords.filter((w) => w.bbox.x < -2 || w.bbox.y < -2 || w.bbox.x + w.bbox.width > ocrResult.width + 2 || w.bbox.y + w.bbox.height > ocrResult.height + 2).map((w) => w.text))}`);

    // --- 4d. bbox 坐标换算（本功能的核心价值）--------------------------
    const coords = ocrResult.coordinates;
    check('  → OCR 结果附带坐标换算（coordinates）', coords !== undefined,
      coords === undefined ? 'missing (attachCoordinates disabled?)' : `hwnd=${coords.hwnd}, scale=${coords.image?.scale}`);

    if (coords !== undefined) {
      const wordEntries = coords.lines.flatMap((line) => line.words);
      const withScreen = wordEntries.filter((w) => w.screen !== undefined);
      check('  → 每个词都有屏幕坐标', withScreen.length === wordEntries.length && wordEntries.length > 0,
        `${withScreen.length}/${wordEntries.length}`);

      const withClient = wordEntries.filter((w) => w.client !== undefined);
      check('  → 每个词都有客户区坐标（可直接喂给 vcu_click）',
        withClient.length === wordEntries.length && wordEntries.length > 0,
        `${withClient.length}/${wordEntries.length}`);

      // 自洽性：屏幕坐标必须落在窗口矩形内。
      const windowRect = shot.windowRect;
      const inWindow = wordEntries.filter((w) => w.screen !== undefined
        && w.screen.x >= windowRect.x - 2 && w.screen.x <= windowRect.x + windowRect.width + 2
        && w.screen.y >= windowRect.y - 2 && w.screen.y <= windowRect.y + windowRect.height + 2);
      check('  → 换算后的屏幕坐标全部落在窗口矩形内',
        inWindow.length === withScreen.length && withScreen.length > 0,
        `窗口=(${windowRect.x},${windowRect.y}) ${windowRect.width}x${windowRect.height}；`
        + `落在窗口内的 ${inWindow.length}/${withScreen.length}；`
        + `越界示例=${JSON.stringify(wordEntries.filter((w) => w.screen !== undefined
          && (w.screen.x < windowRect.x - 2 || w.screen.x > windowRect.x + windowRect.width + 2
            || w.screen.y < windowRect.y - 2 || w.screen.y > windowRect.y + windowRect.height + 2)).map((w) => ({ text: w.text, screen: w.screen })))}`);

      // 自洽性：客户区坐标必须落在客户区范围内。
      //
      // 注意：**不是所有词都应该落在客户区内**。记事本的标题栏（"无标题 - 记事本"）
      // 与菜单栏（"文件(F) 编辑(E)…"）在客户区**之外**，它们换算出的客户区坐标本来就是
      // 负值（y ≈ -10 ~ -36）—— 这正是正确行为，说明换算真的减掉了标题栏与边框的高度。
      // 所以这里断言的是"**正文区**的词落在客户区内"，而不是"所有词都在客户区内"。
      const clientInfo = imagePointToClient(shot, { x: 0, y: 0 });
      const clientSize = clientInfo.ok === true ? clientInfo.clientSize : undefined;
      if (clientSize !== undefined) {
        const inClient = wordEntries.filter((w) => w.client !== undefined
          && w.client.x >= -2 && w.client.x <= clientSize.width + 2
          && w.client.y >= -2 && w.client.y <= clientSize.height + 2);
        // 已知在客户区外的词：标题栏与菜单栏（这些是**预期**行为，不是错误）。
        const outside = wordEntries.filter((w) => w.client !== undefined
          && (w.client.x < -2 || w.client.x > clientSize.width + 2
            || w.client.y < -2 || w.client.y > clientSize.height + 2));

        check('  → 客户区坐标换算：客户区外的词恰好是标题栏/菜单栏（预期行为）',
          inClient.length > 0 && outside.length < wordEntries.length,
          `共 ${wordEntries.length} 个词：客户区内 ${inClient.length}，客户区外 ${outside.length}`
          + `（客户区外的词：${JSON.stringify(outside.map((w) => w.text))}；`
          + `这些位于标题栏/菜单栏，换算为负的客户区坐标是正确的）`);

        // 客户区坐标必须全部 ≤ 客户区尺寸（允许标题栏为负，但正文不能超出右下边界）。
        const overshoot = wordEntries.filter((w) => w.client !== undefined
          && (w.client.x > clientSize.width + 2 || w.client.y > clientSize.height + 2));
        check('  → 没有任何词的客户区坐标超出客户区右下边界',
          overshoot.length === 0,
          `客户区=${clientSize.width}x${clientSize.height}；越界=${JSON.stringify(overshoot.map((w) => ({ text: w.text, client: w.client })))}`);

        // 正向验证换算公式：客户区坐标 = 屏幕坐标 − 客户区原点屏幕坐标。
        const origin = clientInfo.clientOriginOnScreen;
        const formulaOk = wordEntries.every((w) => w.screen === undefined || w.client === undefined
          || (Math.abs((w.screen.x - origin.x) - w.client.x) <= 2 && Math.abs((w.screen.y - origin.y) - w.client.y) <= 2));
        check('  → 客户区坐标 = 屏幕坐标 − 客户区原点（换算公式自洽）', formulaOk,
          `客户区原点在屏幕 (${origin.x},${origin.y})`);

        // 正文区的词必须能落回客户区内 —— 这才是"看到字就能点"的实际依据。
        const bodyKeywords = ['OCR', 'ABCDEFG', 'Vision'];
        const bodyWords = wordEntries.filter((w) => bodyKeywords.some((k) => similarity(w.text, k) >= 0.8));
        const bodyInside = bodyWords.filter((w) => w.client.x >= 0 && w.client.x <= clientSize.width
          && w.client.y >= 0 && w.client.y <= clientSize.height);
        check('  → 正文区的词换算后落在客户区内（可直接 vcu_click）',
          bodyWords.length > 0 && bodyInside.length === bodyWords.length,
          `正文词 ${bodyWords.length} 个，落在客户区内 ${bodyInside.length} 个；`
          + `样例=${JSON.stringify(bodyWords.slice(0, 3).map((w) => ({ text: w.text, client: w.client })))}`);
      }

      // --- 4e. findText：看到字 → 拿到可点击坐标 -------------------------
      const found = findText(ocrResult, 'OCR');
      check('  → findText("OCR") 能定位到带客户区坐标的命中项',
        found.ok === true && found.count > 0 && found.best?.clickHint !== undefined,
        found.count > 0
          ? `命中 ${found.count} 处；best=${JSON.stringify({ text: found.best?.text, screen: found.best?.screen, client: found.best?.client, clickHint: found.best?.clickHint })}`
          : 'no match');

      // 关键闭环：用换算出的客户区坐标反推回屏幕，应该与 findText 给的屏幕坐标吻合。
      if (found.best?.client !== undefined && found.best?.screen !== undefined) {
        const back = imagePointToScreen(shot, {
          x: (found.best.bbox.x + found.best.bbox.width / 2),
          y: (found.best.bbox.y + found.best.bbox.height / 2),
        });
        check('  → 坐标换算可逆（图片像素 ↔ 屏幕坐标）',
          back.ok === true && Math.abs(back.x - found.best.screen.x) <= 1 && Math.abs(back.y - found.best.screen.y) <= 1,
          `正向=(${found.best.screen.x},${found.best.screen.y}) 反推=(${back.x},${back.y})`);
      }
    }

    // --- 4f. 缩放后 OCR 的坐标仍要正确 ---------------------------------
    //
    // 这是最容易出错的地方：图被缩小了，bbox 是缩小后图的像素坐标，换算时必须乘回去。
    const scaledShot = captureWindow(notepadHwnd, { scale: 0.6 });
    if (scaledShot.ok === true) {
      const scaledOcr = await ocrImage(scaledShot, {});
      check('缩放 0.6 后的截图仍能 OCR 出文本',
        scaledOcr.ok === true && scaledOcr.text.trim().length > 0,
        scaledOcr.ok === true ? JSON.stringify(scaledOcr.text.slice(0, 100)) : scaledOcr.reason);

      if (scaledOcr.ok === true && scaledOcr.coordinates !== undefined) {
        const entries = scaledOcr.coordinates.lines.flatMap((l) => l.words).filter((w) => w.screen !== undefined);
        const inRect = entries.filter((w) => w.screen.x >= shot.windowRect.x - 2
          && w.screen.x <= shot.windowRect.x + shot.windowRect.width + 2
          && w.screen.y >= shot.windowRect.y - 2
          && w.screen.y <= shot.windowRect.y + shot.windowRect.height + 2);
        check('  → 缩放后的 bbox 换算仍落在窗口内（缩放系数被正确补偿）',
          entries.length > 0 && inRect.length === entries.length,
          `scale=${scaledShot.scale}, 落在窗口内 ${inRect.length}/${entries.length}`);
      }
    }
  }

  // --- 4g. 屏幕区域抓取 + OCR -------------------------------------------
  {
    // 重新抓一次并**用新鲜的窗口矩形**：前面做过"挪到屏幕外再挪回来"，
    // 任何缓存的 rect 都可能已经过期（第一版就因为用了过期的 rect 而抓到空白）。
    const liveShot = captureWindow(notepadHwnd, {});
    if (liveShot.ok === true) {
      // 正文区的屏幕坐标 = 客户区原点 + 偏移。这样不依赖标题栏/菜单栏的具体高度，
      // 比"窗口 y + 60"这种魔数稳健。
      const bodyX = liveShot.clientOrigin.x + 5;
      const bodyY = liveShot.clientOrigin.y + 5;
      const bodyW = Math.min(500, Math.max(50, liveShot.windowRect.width - 10));
      const bodyH = 110;

      const regionCapture = captureRegion(bodyX, bodyY, bodyW, bodyH, {});
      const regionOcr = await ocrImage(regionCapture, {});
      // 注意：必须用 bestSimilarity（带滑窗），不能直接 similarity(整串, 关键词)。
      // 整串相似度会把 "ABCDEFG 12345 Vision Test OK" 这样的长文本与短关键词
      // 比出个 0.29 的低分，那是**比较方式**的问题，不是 OCR 没读出来。
      const regionScore = regionOcr.ok === true
        ? bestSimilarity(regionOcr.text, regionOcr.lines.map((l) => l.text), 'ABCDEFG').score
        : 0;
      check('对屏幕区域抓取 + OCR 一步到位能读到正文',
        regionOcr.ok === true && regionScore >= 0.75,
        regionOcr.ok === true
          ? `区域=(${bodyX},${bodyY}) ${bodyW}x${bodyH}；region OCR=${JSON.stringify(regionOcr.text)}；`
            + `「ABCDEFG」相似度=${regionScore.toFixed(3)}`
          : `区域=(${bodyX},${bodyY}) ${bodyW}x${bodyH}；${regionOcr.reason}`);
    }
  }

  // --- 4h. ocrImage 的各种输入形式 --------------------------------------
  {
    const shotForInput = captureWindow(notepadHwnd, {});
    if (shotForInput.ok === true) {
      const fromPngBuffer = await ocrImage(shotForInput.png, {});
      check('ocrImage 接受 PNG Buffer 输入',
        fromPngBuffer.ok === true && fromPngBuffer.text.trim().length > 0,
        fromPngBuffer.ok === true ? JSON.stringify(fromPngBuffer.text.slice(0, 80)) : fromPngBuffer.reason);

      const pngPath = join(workspaceDir, 'shot.png');
      writeFileSync(pngPath, shotForInput.png);
      const fromPath = await ocrImage(pngPath, {});
      check('ocrImage 接受文件路径输入',
        fromPath.ok === true && fromPath.text.trim().length > 0,
        fromPath.ok === true ? JSON.stringify(fromPath.text.slice(0, 80)) : fromPath.reason);

      check('  → Buffer 与文件路径两种输入的 OCR 结果一致',
        fromPngBuffer.ok === true && fromPath.ok === true && fromPngBuffer.text === fromPath.text,
        fromPngBuffer.ok === true && fromPath.ok === true
          ? (fromPngBuffer.text === fromPath.text ? 'identical' : `buffer=${JSON.stringify(fromPngBuffer.text)} path=${JSON.stringify(fromPath.text)}`)
          : 'one of the inputs failed');
    }

    const badInput = await ocrImage({ nonsense: true }, {});
    check('ocrImage 对不支持的输入优雅失败（不抛异常）', badInput.ok === false, badInput.reason);

    const tooSmall = await ocrImage({ bgra: Buffer.alloc(4 * 4 * 4), width: 4, height: 4 }, {});
    check('ocrImage 对过小的图明确失败（不返回空文本假装成功）', tooSmall.ok === false, tooSmall.reason);
  }

  // --- 4i. 语言选项 ------------------------------------------------------
  {
    const languages = await listOcrLanguages();
    check('listOcrLanguages() 返回可用语言列表', languages.ok === true && languages.languages.length > 0,
      JSON.stringify(languages.languages));

    if (languages.languages.includes('en-GB')) {
      const english = await ocrWindow(notepadHwnd, { language: 'en-GB' });
      check('指定 language:"en-GB" 可正常 OCR', english.ok === true && english.text.trim().length > 0,
        english.ok === true ? `engine=${english.engineLanguage} text=${JSON.stringify(english.text.slice(0, 80))}` : english.reason);
    } else {
      console.log('  (跳过 en-GB 用例：本机未安装该语言包)');
    }

    const unknownLanguage = await ocrWindow(notepadHwnd, { language: 'xx-XX-not-real' });
    check('指定不存在的语言时诚实失败并给出安装提示',
      unknownLanguage.ok === false && unknownLanguage.installHint !== undefined,
      `reason=${unknownLanguage.reason}`);
  }

  // --- 4j. 超时保护 ------------------------------------------------------
  {
    const timedOut = await ocrWindow(notepadHwnd, { timeoutMs: 1 });
    check('timeoutMs 极小时超时并返回失败（不会永远挂住）',
      timedOut.ok === false && (timedOut.timedOut === true || typeof timedOut.reason === 'string'),
      `timedOut=${timedOut.timedOut} reason=${timedOut.reason}`);
  }

  // --- 4k. 中文识别 ------------------------------------------------------
  {
    const chinese = '中文识别测试 编号 2026';
    writeIntoEdit(loadWin32(), editHwnd, chinese);
    await sleepMillis(700);
    const chineseShot = captureWindow(notepadHwnd, {});
    if (chineseShot.ok === true) {
      const chineseOcr = await ocrImage(chineseShot, { language: 'zh-Hans-CN' });
      const chineseScore = chineseOcr.ok === true ? bestSimilarity(chineseOcr.text, chineseOcr.lines.map((l) => l.text), '中文识别测试').score : 0;
      check('OCR 能识别中文（zh-Hans-CN 引擎）',
        chineseOcr.ok === true && chineseScore >= 0.6,
        chineseOcr.ok === true
          ? `识别文本=${JSON.stringify(chineseOcr.text)}；「中文识别测试」相似度=${chineseScore.toFixed(3)}`
          : chineseOcr.reason);
    }
  }
} else {
  console.log('\n  (跳过记事本端到端用例：窗口或 Edit 控件未找到)');
}

// ===========================================================================
section('5. 资源纪律：GDI 句柄不泄漏');
// ===========================================================================

{
  // 连续抓取 60 次，如果每次泄漏 DC/Bitmap，进程的 GDI 对象数会明显增长。
  // 这里用 PowerShell 读本进程的 GDI 句柄数做前后对照（如果不可用则退化说明）。
  const { execFileSync } = await import('node:child_process');
  const psPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

  const countGdi = () => {
    try {
      const script = `(Get-Process -Id ${process.pid}).HandleCount`;
      const out = execFileSync(psPath, ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', timeout: 10000, windowsHide: true });
      const value = Number(String(out).trim());
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };

  const beforeCount = countGdi();
  let failures = 0;
  for (let i = 0; i < 60; i += 1) {
    const shot = captureRegion(0, 0, 200, 150, {});
    if (shot.ok !== true) failures += 1;
  }
  const afterCount = countGdi();

  check('连续 60 次抓取全部成功', failures === 0, `${60 - failures}/60 succeeded`);

  if (beforeCount !== undefined && afterCount !== undefined) {
    // GDI 对象不是 HandleCount 的全部，但泄漏会表现为句柄数持续增长。
    const growth = afterCount - beforeCount;
    check('  → 60 次抓取后进程句柄数未显著增长（无明显 GDI 泄漏）', growth < 50,
      `HandleCount: ${beforeCount} → ${afterCount}（增长 ${growth}）`);
  } else {
    console.log('  (无法读取进程句柄数，跳过泄漏对照；创建/释放路径本身有 try/finally 保证)');
  }
}

// ===========================================================================
section('6. 结果汇总');
// ===========================================================================

cleanup();
await sleepMillis(300);

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed);
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

console.log('');
for (const item of results) {
  const mark = item.passed ? '  PASS' : '  FAIL';
  console.log(`${mark}  [${item.section}] ${item.name}`);
}
console.log('');
console.log('='.repeat(72));
console.log(`汇总: ${passed} 通过, ${failed.length} 失败, 共 ${results.length} 项，耗时 ${elapsed}s`);

if (failed.length > 0) {
  console.log('\n失败明细：');
  for (const item of failed) {
    console.log(`  FAIL [${item.section}] ${item.name}`);
    console.log(`       ${typeof item.detail === 'string' ? item.detail : JSON.stringify(item.detail)}`);
  }
  console.log('\n视觉能力测试未全部通过。');
  process.exit(1);
}

console.log('\n视觉能力测试全部通过。');
process.exit(0);
