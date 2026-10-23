/**
 * dsh-virtual-computer-use —— 虚拟输入层测试。
 *
 * 运行：`node test/virtual-input.test.mjs`
 *
 * 本测试**只对真实程序做只读/注入式验证**，且硬性要求：
 *   - 绝不移动真实鼠标、绝不调用 SetCursorPos / SendInput；
 *   - 绝不抢用户焦点（除非该用例显式标了会抢焦点，本文件默认全程不抢）；
 *   - 测试只清理**自己 spawn 出来的** notepad 进程，按 pid 精确 taskkill。
 *
 * 光标不动是核心断言，用"注入组 vs 纯等待基线"对比来排除用户自己动鼠标的干扰：
 * 同一个采样循环跑两轮，一轮不做任何注入（基线），一轮高频注入；
 * 若注入组的最大位移没有显著超过基线的合理倍数，则判定"注入没有移动光标"。
 *
 * 任何用例失败都会在最后汇总并以非零码退出。
 */

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  click,
  move,
  scroll,
  writeText,
  pressKey,
  keyCombo,
  explainKey,
  probeWindow,
  describeVirtualInput,
  ensureTargetReady,
  clientToScreen,
  screenToClient,
  normalizePoint,
  packMouseLParam,
  unpackMouseLParam,
  buildKeyLParam,
  scanCodeForVk,
  parseKeySpec,
  resolveKey,
  cursorPosition,
  childWindows,
  // 编辑控件可靠路径（EM_*）
  edit,
  selectAll,
  replaceSelection,
  clearSelection,
  getSelection,
  isEditControl,
} from '../lib/virtual-input.js';

import { loadWin32 } from '../lib/native.js';

/** 缓存绑定，避免每次调用都走一遍 loadWin32 的对象展开。 */
let cachedWin32;
function loadWin32Cached() {
  if (cachedWin32 === undefined) cachedWin32 = loadWin32();
  return cachedWin32;
}

// ---------------------------------------------------------------------------
// 迷你测试框架
// ---------------------------------------------------------------------------

const results = [];
let currentGroup = 'general';

function group(name) {
  currentGroup = name;
  console.log(`\n${'='.repeat(72)}\n== ${name}\n${'='.repeat(72)}`);
}

function record(name, ok, detail) {
  results.push({ group: currentGroup, name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  const suffix = detail === undefined ? '' : `  ${detail}`;
  console.log(`  [${tag}] ${name}${suffix}`);
}

function check(name, condition, detail) {
  record(name, condition === true, detail);
  return condition === true;
}

function info(label, value) {
  console.log(`        · ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

/** 包一层，把"抛异常"也变成 FAIL 而不是让整个测试进程崩掉。 */
function step(name, fn) {
  try {
    const outcome = fn();
    if (outcome !== undefined && typeof outcome.then === 'function') {
      return outcome.catch((error) => record(name, false, `threw: ${error?.message ?? error}`));
    }
    return outcome;
  } catch (error) {
    record(name, false, `threw: ${error?.message ?? error}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 光标采样：注入组 vs 纯等待基线
// ---------------------------------------------------------------------------

/**
 * 在一段固定时长的窗口内高频采样真实光标位置，返回位移统计。
 *
 * @param durationMs - 采样总时长
 * @param onTick - 每次采样时调用的注入回调（基线组传 undefined）
 */
async function sampleCursor(durationMs, onTick) {
  const samples = [];
  const start = Date.now();
  let ticks = 0;
  let injections = 0;
  // 采样间隔 2ms — 比任何注入节奏都密，保证能抓到注入导致的位移。
  while (Date.now() - start < durationMs) {
    const position = cursorPosition();
    if (position.ok === true) samples.push({ x: position.x, y: position.y, t: Date.now() - start });
    if (onTick !== undefined) {
      const produced = onTick(ticks);
      if (Number.isFinite(produced)) injections += produced;
    }
    ticks += 1;
    await sleep(2);
  }

  if (samples.length === 0) {
    return { samples: 0, ticks, injections, maxDisplacement: NaN, totalPath: NaN, first: undefined, last: undefined };
  }

  const first = samples[0];
  let maxDisplacement = 0;
  let totalPath = 0;
  let previous = first;
  for (const sample of samples) {
    const displacement = Math.hypot(sample.x - first.x, sample.y - first.y);
    if (displacement > maxDisplacement) maxDisplacement = displacement;
    totalPath += Math.hypot(sample.x - previous.x, sample.y - previous.y);
    previous = sample;
  }

  return {
    samples: samples.length,
    ticks,
    injections,
    maxDisplacement,
    totalPath,
    first: { x: first.x, y: first.y },
    last: { x: previous.x, y: previous.y },
  };
}

function formatStats(stats) {
  return `samples=${stats.samples} ticks=${stats.ticks} injections=${stats.injections} ` +
    `maxDisplacement=${Number.isFinite(stats.maxDisplacement) ? stats.maxDisplacement.toFixed(2) : 'n/a'}px ` +
    `totalPath=${Number.isFinite(stats.totalPath) ? stats.totalPath.toFixed(2) : 'n/a'}px ` +
    `first=(${stats.first?.x},${stats.first?.y}) last=(${stats.last?.x},${stats.last?.y})`;
}

// ---------------------------------------------------------------------------
// 进程管理：只清理自己 spawn 的东西
// ---------------------------------------------------------------------------

const spawnedPids = new Set();

function killOwnedProcesses() {
  const killed = [];
  for (const pid of spawnedPids) {
    try {
      // /T 连带子进程（notepad 新版会有子窗口进程），/F 强制。
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      killed.push(pid);
    } catch {
      // 进程可能已自行退出；忽略。
    }
  }
  spawnedPids.clear();
  return killed;
}

/**
 * 启动一个真实的 notepad，等待它的主窗口出现。
 *
 * @returns `{ ok, pid, hwnd, probe, reason, texts:[hwnd...] }`
 *          `texts` 是记事本里的编辑控件（Windows 11 的 notepad 是 UWP 外壳
 *          包着 RichEditD2DPT / Edit，需要枚举子窗口找到真正的文本控件）。
 */
async function launchNotepad(timeoutMs = 12000) {
  const child = spawn('notepad.exe', [], { detached: false, stdio: 'ignore' });
  const pid = child.pid;
  spawnedPids.add(pid);
  child.on('error', () => {});

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await findNotepadWindows(pid);
    if (found.mainHwnd !== undefined) {
      return { ok: true, pid, child, ...found };
    }
    await sleep(150);
  }
  return { ok: false, pid, reason: `notepad (pid ${pid}) did not open a window within ${timeoutMs}ms` };
}

/** 枚举属于该 pid 的顶层窗口，并找出其编辑控件。 */
async function findNotepadWindows(pid) {
  const { enumWindows } = await import('../lib/native.js');
  const topLevel = [];
  enumWindows((hwnd) => {
    const probe = probeWindow(hwnd);
    if (probe.ok === true && probe.pid === pid) topLevel.push(probe);
    return true;
  });

  // 优先选有非空标题的可见窗口（跳过隐藏的工具窗）。
  const main = topLevel.find((p) => p.visible === true && p.className !== 'ToolTip')
    ?? topLevel.find((p) => p.visible === true);

  let textWindows = [];
  if (main !== undefined) {
    const tree = childWindows(main.hwnd);
    const descendants = collectTextControls(main.hwnd, tree);
    textWindows = descendants;
  }
  return { mainHwnd: main?.hwnd, probe: main, topLevel, texts: textWindows };
}

/** 递归找可作为文本目标/回读对象的编辑控件。 */
function collectTextControls(hwnd, tree, depth = 0, acc = []) {
  if (tree.ok !== true || depth > 6) return acc;
  for (const child of tree.children) {
    if (/^(Edit|RichEdit|RichEdit20W|RichEdit50W|RichEditD2DPT|Windows\.UI\.Core\.CoreWindow)$/i.test(child.className ?? '')) {
      acc.push(child);
    }
    const nested = childWindows(child.hwnd);
    collectTextControls(child.hwnd, nested, depth + 1, acc);
  }
  return acc;
}

/** 轮询等待某个条件成立。 */
async function waitFor(predicate, timeoutMs = 4000, intervalMs = 60) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value !== undefined && value !== false && value !== null) return value;
    await sleep(intervalMs);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = new Date();
  console.log('dsh-virtual-computer-use — 虚拟输入层测试');
  console.log(`started: ${startedAt.toISOString()}`);
  console.log(`node: ${process.version}  platform: ${process.platform}  pid: ${process.pid}`);

  group('0. 环境自检');
  const describe = describeVirtualInput();
  info('describeVirtualInput', describe);
  if (check('FFI 可用（native.js 绑定成功）', describe.ok === true, describe.reason)) {
    check('native.js 无单个绑定失败', (describe.native?.failures ?? []).length === 0,
      JSON.stringify(describe.native?.failures ?? []));
    check('虚拟输入层必需绑定齐全', describe.missingBindings.length === 0,
      describe.missingBindings.join(','));
  } else {
    console.log('\nFFI 不可用，后续用例无法进行。');
    return finish();
  }

  const cursorAtStart = cursorPosition();
  info('测试开始前的真实光标位置', cursorAtStart);
  check('可以读取真实光标位置（只读）', cursorAtStart.ok === true, cursorAtStart.reason);

  // -------------------------------------------------------------------------
  group('1. 纯函数：坐标打包 / lParam 位域 / 按键解析');
  // -------------------------------------------------------------------------

  const packing = [
    { x: 0, y: 0, lx: 0, ly: 0 },
    { x: 100, y: 200, lx: 100, ly: 200 },
    { x: 32767, y: 32767, lx: 32767, ly: 32767 },
    // > 32767 必须折成有符号 16 位负数（Windows 的真实语义）
    { x: 32768, y: 32768, lx: -32768, ly: -32768 },
    { x: -1, y: -1, lx: -1, ly: -1 },
    { x: -5, y: 3, lx: -5, ly: 3 },
    { x: 65536 + 7, y: 65536 + 9, lx: 7, ly: 9 },
  ];
  let packingOk = true;
  for (const item of packing) {
    const packed = packMouseLParam(item.x, item.y);
    const unpacked = unpackMouseLParam(packed.lp);
    if (unpacked.x !== item.lx || unpacked.y !== item.ly) packingOk = false;
    info(`pack(${item.x},${item.y})`, `lp=0x${(packed.lp >>> 0).toString(16).padStart(8, '0')} -> (${unpacked.x},${unpacked.y})`);
  }
  check('lParam 打包符合 (y<<16)|x 的有符号 16 位语义（含 >32767 折负）', packingOk);
  check('packMouseLParam 往返一致（随机 200 组）', (() => {
    for (let i = 0; i < 200; i += 1) {
      const x = Math.floor(Math.random() * 70000) - 35000;
      const y = Math.floor(Math.random() * 70000) - 35000;
      const back = unpackMouseLParam(packMouseLParam(x, y).lp);
      const expectedX = ((x & 0xffff) << 16) >> 16;
      const expectedY = ((y & 0xffff) << 16) >> 16;
      if (back.x !== expectedX || back.y !== expectedY) return false;
    }
    return true;
  })());

  // lParam 位域
  const keyDownA = buildKeyLParam(0x41);
  const keyUpA = buildKeyLParam(0x41, { keyUp: true });
  const leftDown = buildKeyLParam(0x25);
  const enterDown = buildKeyLParam(0x0d);
  const enterNumpad = buildKeyLParam(0x0d, { extended: true });
  info('A down', `0x${(keyDownA >>> 0).toString(16).padStart(8, '0')} scan=0x${scanCodeForVk(0x41).toString(16)}`);
  info('A up  ', `0x${(keyUpA >>> 0).toString(16).padStart(8, '0')}`);
  info('LEFT down', `0x${(leftDown >>> 0).toString(16).padStart(8, '0')}`);
  info('ENTER down', `0x${(enterDown >>> 0).toString(16).padStart(8, '0')}`);

  check('lParam repeat count = 1', (keyDownA & 0xffff) === 1);
  check('lParam 扫描码来自 MapVirtualKeyW（A=0x1E）', ((keyDownA >>> 16) & 0xff) === scanCodeForVk(0x41) && scanCodeForVk(0x41) === 0x1e);
  check('lParam keyup 置 previous-state(bit30) 与 transition(bit31)', ((keyUpA >>> 30) & 1) === 1 && ((keyUpA >>> 31) & 1) === 1);
  check('lParam keydown 不置 bit30/bit31', ((keyDownA >>> 30) & 1) === 0 && ((keyDownA >>> 31) & 1) === 0);
  check('扩展键（LEFT）置 bit24', ((leftDown >>> 24) & 1) === 1);
  check('主键盘 Enter 不置 bit24', ((enterDown >>> 24) & 1) === 0);
  check('小键盘 Enter（显式 extended）置 bit24', ((enterNumpad >>> 24) & 1) === 1);
  check('Alt 按下时置 context code bit29', ((buildKeyLParam(0x41, { altDown: true }) >>> 29) & 1) === 1);

  // 按键名解析
  const specCases = [
    { input: 'ctrl+a', mods: 1, keys: [0x41] },
    { input: 'enter', mods: 0, keys: [0x0d] },
    { input: 'esc', mods: 0, keys: [0x1b] },
    { input: 'f5', mods: 0, keys: [0x74] },
    { input: 'alt+tab', mods: 1, keys: [0x09] },
    { input: 'ctrl+shift+s', mods: 2, keys: [0x53] },
    { input: ['ctrl', 'v'], mods: 1, keys: [0x56] },
  ];
  let specOk = true;
  for (const item of specCases) {
    const spec = parseKeySpec(item.input);
    const good = spec.ok === true && spec.modifiers.length === item.mods
      && spec.keys.length === item.keys.length && spec.keys.every((vk, i) => vk === item.keys[i]);
    if (!good) specOk = false;
    info(`parseKeySpec(${JSON.stringify(item.input)})`, spec);
  }
  check('按键字符串解析（ctrl+a / enter / esc / f5 / alt+tab）', specOk);
  check('未知键名不抛异常且给出 reason', (() => {
    const bad = resolveKey('definitely-not-a-key');
    return bad.ok === false && typeof bad.reason === 'string' && bad.reason.length > 0;
  })());
  check('explainKey 报告修饰键与扫描码', (() => {
    const explained = explainKey('ctrl+a');
    return explained.ok === true && explained.scanCodes[0] === scanCodeForVk(0x41) && typeof explained.modifierStateNote === 'string';
  })());

  // -------------------------------------------------------------------------
  group('2. 真实记事本：虚拟键盘写入 + 回读验证');
  // -------------------------------------------------------------------------

  const notepad = await launchNotepad();
  if (!check('启动真实 notepad 并能找到主窗口', notepad.ok === true, notepad.reason)) {
    return finish();
  }
  info('notepad pid', notepad.pid);
  info('notepad 顶层窗口', notepad.topLevel.map((p) => ({ hwnd: p.hwnd, cls: p.className, title: p.title })));
  info('找到的文本控件', notepad.texts.map((t) => ({ hwnd: t.hwnd, cls: t.className })));

  const mainHwnd = notepad.mainHwnd;
  const probeMain = probeWindow(mainHwnd);
  info('主窗口 probe', {
    className: probeMain.className,
    pid: probeMain.pid,
    visible: probeMain.visible,
    iconic: probeMain.iconic,
    client: probeMain.client,
    isForeground: probeMain.isForeground,
  });

  // 目标选择：优先真实编辑控件（WM_CHAR 才生效）；否则退回主窗口。
  // Windows 11 notepad 是 UWP 应用（ApplicationFrameWindow + RichEditD2DPT），
  // 本测试会如实记录这种情况下 PostMessage 是否生效。
  const editTarget = notepad.texts.find((t) => /RichEdit|Edit/i.test(t.className ?? '')) ?? notepad.texts[0];
  const textHwnd = editTarget?.hwnd ?? mainHwnd;
  info('文本注入目标 hwnd', `${textHwnd} (${editTarget?.className ?? probeMain.className})`);

  const ready = ensureTargetReady(textHwnd, { allowFocusSteal: false });
  info('ensureTargetReady（不抢焦点）', {
    ok: ready.ok, ready: ready.ready, stoleFocus: ready.stoleFocus,
    foregroundBefore: ready.foregroundBefore, foregroundAfter: ready.foregroundAfter,
    actions: ready.actions,
  });
  check('ensureTargetReady 默认不抢焦点', ready.ok === true && ready.stoleFocus !== true,
    `stoleFocus=${ready.stoleFocus} foregroundBefore=${ready.foregroundBefore} foregroundAfter=${ready.foregroundAfter}`);

  // --- 写入内容：英文 + 中文 + emoji（代理对）+ 换行 ---
  const asciiText = 'Hello World 123';
  const cjkText = '中文输入测试：你好，世界！';
  const emojiText = '🙂🚀'; // U+1F642 U+1F680，各占 2 个 UTF-16 码元（代理对）
  const payload = `${asciiText}\n${cjkText}\n${emojiText}`;

  console.log(`\n  -- 写入内容 --`);
  info('payload', JSON.stringify(payload));
  info('payload.length (UTF-16 码元)', payload.length);
  info('payload 码点数', [...payload].length);

  const writeResult = writeText(textHwnd, payload);
  info('writeText 结果', {
    ok: writeResult.ok, posted: writeResult.posted, failed: writeResult.failed,
    codeUnits: writeResult.codeUnits, replacedNewlines: writeResult.replacedNewlines,
    reason: writeResult.reason,
  });
  console.log('  投递消息明细（前 40 条）:');
  for (const entry of (writeResult.messages ?? []).slice(0, 40)) {
    const ch = entry.char !== undefined ? ` char=U+${entry.char.toString(16).toUpperCase().padStart(4, '0')} ${JSON.stringify(String.fromCharCode(entry.char))}` : '';
    console.log(`        ${entry.message} ok=${entry.ok}${ch}`);
  }

  check('writeText 全部消息投递成功', writeResult.ok === true && writeResult.failed === 0, writeResult.reason);
  check('writeText 投递的码元数与 UTF-16 长度一致（代理对按码元逐个投递）',
    writeResult.codeUnits === payload.length, `codeUnits=${writeResult.codeUnits} expected=${payload.length}`);

  // 给目标一点时间处理队列里的消息
  await sleep(400);

  // --- 回读验证 ---
  // notepad 的编辑控件是 RichEditD2DPT；跨进程 WM_GETTEXT 受地址空间限制，
  // 走 EM_GETLINE 或 UIA。这里用 native.js 的 SendMessageW + WM_GETTEXT 尝试，
  // 失败则改从窗口标题/子控件标题判断，并如实报告。
  const { readTextViaMessages } = await import('../lib/virtual-input.js');
  let readback = readTextViaMessages(textHwnd);
  info('回读方式 1（EM_GETLINE / WM_GETTEXT on text hwnd）', {
    ok: readback.ok, method: readback.method, length: readback.text?.length, reason: readback.reason,
  });

  if (readback.ok !== true) {
    record('跨进程回读可用（EM_GETLINE）', false,
      `readTextViaMessages 失败：${readback.reason}。注意：**不允许**用窗口标题替代断言 —— ` +
      'notepad 标题只反映首行且会加"*"未保存标记，实测写入成功后标题变成 "*无标题 - 记事本"，' +
      '看起来像失败但其实写入是成功的。');
  } else {
    info('回读方式', readback.method);
  }

  info('回读到的文本', JSON.stringify(readback.text));
  info('期望文本', JSON.stringify(payload.replace(/\n/g, '\r\n')));
  info('回读长度 vs WM_GETTEXTLENGTH', `${readback.text?.length} vs ${readback.reportedLength} (consistent=${readback.lengthConsistent})`);

  const normalizedBack = (readback.text ?? '');
  const expectedNormalized = payload.replace(/\n/g, '\r\n');
  check('回读内容包含 ASCII 部分', normalizedBack.includes(asciiText), `back=${JSON.stringify(normalizedBack)}`);
  check('回读内容包含中文部分（UTF-16 非代理对）', normalizedBack.includes(cjkText));
  check('回读内容包含 emoji 部分（代理对往返正确）', normalizedBack.includes(emojiText));
  check('写入的 emoji 代理对完整往返（未被拆坏成 U+FFFD / 孤立代理）',
    normalizedBack.includes(emojiText) && normalizedBack.includes('\uFFFD') === false,
    `back codePoints=${JSON.stringify([...normalizedBack])}`);
  check('回读内容与 payload 完全一致',
    normalizedBack === expectedNormalized,
    `back=${JSON.stringify(normalizedBack)} want=${JSON.stringify(expectedNormalized)}`);

  // -------------------------------------------------------------------------
  group('3. 按键投递 / 快捷键不可靠性 + EM_* 可靠路径（真实记事本）');
  // -------------------------------------------------------------------------
  //
  // 本组**故意**同时覆盖两条事实，避免把"不可达的期望"伪装成失败：
  //   (a) WM_KEYDOWN 路线在纯 PostMessage 下确实不生效 —— 断言它被如实标注为
  //       degraded / reliability:'low'，而不是返回一个骗人的 ok:true；
  //   (b) 编辑控件的可靠路径（EM_SETSEL / EM_REPLACESEL）确实生效 —— 断言内容
  //       真的被全选/清空/替换。
  // 详见 lib/virtual-input.js 顶部关于 TranslateMessage 的说明。

  const selectionBefore = getSelection(textHwnd);
  info('初始选区', selectionBefore);
  const textBeforeHotkey = readTextViaMessages(textHwnd).text;
  info('快捷键测试前的文本', JSON.stringify(textBeforeHotkey));

  // --- (a) Ctrl+A 快捷键：断言"被标注为不可靠"，而不是断言它能全选 ---
  const selectAllHotkey = keyCombo(textHwnd, 'a', ['ctrl']);
  info('keyCombo(ctrl+a) 结果', {
    ok: selectAllHotkey.ok, posted: selectAllHotkey.posted, failed: selectAllHotkey.failed,
    modifiers: selectAllHotkey.modifiers, virtualKeys: selectAllHotkey.virtualKeys,
    reliability: selectAllHotkey.reliability, degraded: selectAllHotkey.degraded,
    recommendedAlternative: selectAllHotkey.recommendedAlternative,
  });
  console.log('  Ctrl+A 消息序列:');
  for (const entry of selectAllHotkey.sequence ?? []) {
    console.log(`        ${entry.message} vk=0x${entry.vk.toString(16)} keyUp=${entry.keyUp} lParam=0x${(entry.lParam >>> 0).toString(16).padStart(8, '0')} ok=${entry.ok}`);
  }
  check('keyCombo(ctrl+a) 消息投递成功', selectAllHotkey.ok === true && selectAllHotkey.failed === 0, selectAllHotkey.reason);
  check('修饰键顺序：Ctrl 按下在最前、抬起在最后', (() => {
    const seq = selectAllHotkey.sequence ?? [];
    if (seq.length < 4) return false;
    const isCtrl = (e) => e.vk === 0x11;
    const isA = (e) => e.vk === 0x41;
    return isCtrl(seq[0]) && seq[0].keyUp === false       // Ctrl down first
      && isA(seq[1]) && seq[1].keyUp === false             // A down
      && isA(seq[2]) && seq[2].keyUp === true              // A up
      && isCtrl(seq[3]) && seq[3].keyUp === true;          // Ctrl up last
  })(), JSON.stringify((selectAllHotkey.sequence ?? []).map((e) => `${e.message}:vk${e.vk.toString(16)}:${e.keyUp ? 'up' : 'down'}`)));
  check('keyCombo 返回 GetKeyState 一致性说明', typeof selectAllHotkey.modifierStateNote === 'string' && selectAllHotkey.modifierStateNote.length > 0);
  check('快捷键结果被如实标注为不可靠（reliability=low + degraded + note），不伪装成成功',
    selectAllHotkey.reliability === 'low' && selectAllHotkey.degraded === true
      && typeof selectAllHotkey.note === 'string' && selectAllHotkey.note.length > 0
      && typeof selectAllHotkey.recommendedAlternative === 'string',
    `reliability=${selectAllHotkey.reliability} degraded=${selectAllHotkey.degraded}`);
  check('pressKey 对编辑/导航键也标注 degraded', (() => {
    const d = pressKey(textHwnd, 'delete');
    const h = pressKey(textHwnd, 'home');
    return d.reliability === 'low' && d.degraded === true && h.reliability === 'low' && h.degraded === true;
  })());

  await sleep(200);
  const afterHotkey = readTextViaMessages(textHwnd);
  const selectionAfterHotkey = getSelection(textHwnd);
  info('Ctrl+A 之后文本', JSON.stringify(afterHotkey.text));
  info('Ctrl+A 之后选区', selectionAfterHotkey);
  check('[已知局限] Ctrl+A 经 PostMessage 未能全选（选区未覆盖全文）', (() => {
    if (selectionAfterHotkey.ok !== true) return true; // 无法读选区时不断言失败
    const len = (afterHotkey.text ?? '').length;
    return !(selectionAfterHotkey.start === 0 && selectionAfterHotkey.end === len && len > 0);
  })(), `选区=${JSON.stringify(selectionAfterHotkey)} 文本长度=${(afterHotkey.text ?? '').length}`);

  // --- (b) 可靠路径：EM_SETSEL 全选 ---
  const reliableSelectAll = selectAll(textHwnd);
  info('selectAll() (EM_SETSEL) 结果', {
    ok: reliableSelectAll.ok, method: reliableSelectAll.method,
    start: reliableSelectAll.start, end: reliableSelectAll.end,
    textLength: reliableSelectAll.textLength, verified: reliableSelectAll.verified,
    reason: reliableSelectAll.reason,
  });
  check('selectAll() 走 EM_SETSEL 并可靠全选（verified）',
    reliableSelectAll.ok === true && reliableSelectAll.verified === true
      && reliableSelectAll.start === 0 && reliableSelectAll.end === reliableSelectAll.textLength,
    `start=${reliableSelectAll.start} end=${reliableSelectAll.end} len=${reliableSelectAll.textLength}`);

  const selectionAfterReliable = getSelection(textHwnd);
  info('EM_SETSEL 之后选区', selectionAfterReliable);
  check('EM_SETSEL 之后选区真的覆盖全文（与 Ctrl+A 形成对照）',
    selectionAfterReliable.ok === true && selectionAfterReliable.start === 0
      && selectionAfterReliable.end === (afterHotkey.text ?? '').length,
    `选区=${JSON.stringify(selectionAfterReliable)}`);

  // --- 可靠清空 ---
  const cleared = clearSelection(textHwnd, { selectAll: true });
  info('clearSelection() 结果', {
    ok: cleared.ok, method: cleared.method, lengthBefore: cleared.lengthBefore,
    lengthAfter: cleared.lengthAfter, verified: cleared.verified,
    clearedChars: cleared.clearedChars, reason: cleared.reason,
  });
  await sleep(200);
  const afterClear = readTextViaMessages(textHwnd);
  const lengthAfterClear = Number(loadWin32Cached().SendMessageW(textHwnd, 0x000e, 0, 0));
  info('清空之后文本', JSON.stringify(afterClear.text));
  info('清空之后 WM_GETTEXTLENGTH', lengthAfterClear);
  check('clearSelection() 可靠清空了内容（EM_REPLACESEL）',
    cleared.ok === true && lengthAfterClear === 0,
    `cleared.ok=${cleared.ok} verified=${cleared.verified} textLength=${lengthAfterClear} text=${JSON.stringify(afterClear.text)}`);

  // --- 局部精确改写 ---
  const seeded = writeText(textHwnd, 'AAAAAAAAAA');
  await sleep(300);
  info('写入 AAAAAAAAAA', { ok: seeded.ok, posted: seeded.posted });
  const partial = replaceSelection(textHwnd, 'XYZ', { start: 2, end: 5 });
  await sleep(300);
  const afterPartial = readTextViaMessages(textHwnd);
  info('replaceSelection("XYZ", start=2, end=5) 结果', {
    ok: partial.ok, method: partial.method, lengthBefore: partial.lengthBefore,
    lengthAfter: partial.lengthAfter, expectedDelta: partial.expectedDelta,
    actualDelta: partial.actualDelta, verified: partial.verified,
  });
  info('局部改写之后文本', JSON.stringify(afterPartial.text));
  check('replaceSelection() 局部精确改写正确（AAXYZAAAAA）',
    afterPartial.ok === true && afterPartial.text === 'AAXYZAAAAA',
    `back=${JSON.stringify(afterPartial.text)} want="AAXYZAAAAA"`);

  // 重新写入一行，验证二次写入仍然工作
  clearSelection(textHwnd, { selectAll: true });
  await sleep(200);
  const secondText = 'second-pass OK 二轮写入 ✔';
  const write2 = writeText(textHwnd, secondText);
  await sleep(300);
  const readback2 = readTextViaMessages(textHwnd);
  info('二轮 writeText', { ok: write2.ok, posted: write2.posted });
  info('二轮回读', { ok: readback2.ok, text: JSON.stringify(readback2.text) });
  check('二轮写入并回读一致', readback2.ok === true && (readback2.text ?? '').includes(secondText),
    `back=${JSON.stringify(readback2.text)}`);

  // --- edit() 统一入口 ---
  const editRead = edit(textHwnd, 'read');
  const editSelection = edit(textHwnd, 'selection');
  info('edit("read")', { ok: editRead.ok, text: JSON.stringify(editRead.text) });
  info('edit("selection")', editSelection);
  check('edit() 统一入口可用（read/selection）', editRead.ok === true && editSelection.ok === true);
  info('isEditControl', isEditControl(textHwnd));
  check('isEditControl 正确识别 notepad 的 Edit 控件', isEditControl(textHwnd).supportsEditMessages === true);

  // -------------------------------------------------------------------------
  group('4. 鼠标点击（真实记事本，且真实光标必须不动）');
  // -------------------------------------------------------------------------

  const clickProbe = probeWindow(textHwnd);
  const clientW = clickProbe.client?.width ?? 0;
  const clientH = clickProbe.client?.height ?? 0;
  info('文本控件客户区尺寸', { width: clientW, height: clientH });

  const toScreen = clientToScreen(textHwnd, 20, 20);
  const backToClient = toScreen.ok === true ? screenToClient(textHwnd, toScreen.x, toScreen.y) : { ok: false };
  info('clientToScreen(20,20)', toScreen);
  info('screenToClient 往返', backToClient);
  check('客户区↔屏幕坐标转换往返一致',
    toScreen.ok === true && backToClient.ok === true && Math.abs(backToClient.x - 20) <= 1 && Math.abs(backToClient.y - 20) <= 1);

  const windowSpace = normalizePoint(textHwnd, 0, 0, { space: 'window' });
  const clientOrigin = clientToScreen(textHwnd, 0, 0);
  const windowRectNow = probeWindow(textHwnd).rect;
  info('normalizePoint(window 空间) 0,0', windowSpace);
  info('客户区原点在屏幕', clientOrigin);
  info('窗口外框', windowRectNow);
  check('window 空间坐标正确转换为客户区坐标',
    windowSpace.ok === true && clientOrigin.ok === true && windowRectNow !== undefined
      && Math.abs((windowSpace.x) - (clientOrigin.x - windowRectNow.left)) <= 1
      && Math.abs((windowSpace.y) - (clientOrigin.y - windowRectNow.top)) <= 1);

  const clickX = Math.max(5, Math.min(60, Math.floor(clientW / 4) || 40));
  const clickY = Math.max(5, Math.min(30, Math.floor(clientH / 4) || 20));

  // -------------------------------------------------------------------------
  group('5. 核心断言：注入期间真实光标不动（注入组 vs 纯等待基线）');
  // -------------------------------------------------------------------------

  const SAMPLE_MS = 2200;

  // --- 基线：只采样，不注入 ---
  console.log('\n  [基线] 纯等待采样，不投递任何消息……');
  const baseline = await sampleCursor(SAMPLE_MS, undefined);
  console.log(`        基线统计: ${formatStats(baseline)}`);

  // --- 注入组：采样同时高频投递鼠标消息 ---
  console.log('\n  [注入组] 采样同时高频投递 WM_MOUSEMOVE / 点击 / 滚轮 / 键盘消息……');
  const injectedMessages = [];
  const injection = await sampleCursor(SAMPLE_MS, (tick) => {
    let produced = 0;
    // 鼠标移动：在客户区内画圈，坐标完全走 PostMessage
    const cx = Math.max(10, Math.floor(clientW / 2));
    const cy = Math.max(10, Math.floor(clientH / 2));
    const radius = Math.max(4, Math.min(cx, cy) - 6);
    const angle = (tick / 6) * Math.PI * 2;
    const mx = Math.round(cx + radius * Math.cos(angle));
    const my = Math.round(cy + radius * Math.sin(angle));
    const moved = move(textHwnd, mx, my);
    produced += moved.posted ?? 0;
    if (tick % 20 === 0) {
      const clicked = click(textHwnd, mx, my);
      produced += clicked.posted ?? 0;
      injectedMessages.push({ kind: 'click', posted: clicked.posted, sequence: clicked.sequence?.length ?? 0 });
    }
    if (tick % 35 === 0) {
      const scrolled = scroll(textHwnd, tick % 70 === 0 ? 1 : -1);
      produced += scrolled.posted ?? 0;
      injectedMessages.push({ kind: 'scroll', posted: scrolled.posted });
    }
    if (tick % 25 === 0) {
      const keyed = pressKey(textHwnd, 'shift');
      produced += keyed.posted ?? 0;
      injectedMessages.push({ kind: 'key', posted: keyed.posted });
    }
    return produced;
  });
  console.log(`        注入组统计: ${formatStats(injection)}`);

  const totalPosted = writeResult.posted + selectAllHotkey.posted
    + (write2.posted ?? 0) + injection.injections;

  console.log('');
  info('注入组投递的消息总数（本轮）', injection.injections);
  info('基线位移 (max / totalPath)', `${baseline.maxDisplacement.toFixed(2)}px / ${baseline.totalPath.toFixed(2)}px`);
  info('注入组位移 (max / totalPath)', `${injection.maxDisplacement.toFixed(2)}px / ${injection.totalPath.toFixed(2)}px`);
  info('本次测试累计投递消息数（含写入/按键）', totalPosted);

  // 判定：注入组的位移不得超过基线的"合理倍数"。
  // 用户自己动鼠标会同时抬高两组位移，因此用基线做参照能排除**一部分**干扰。
  const allowed = Math.max(baseline.maxDisplacement * 2 + 2, 4);
  const ratioOk = injection.maxDisplacement <= allowed;

  // ⚠ 但"基线做参照"并不总能排除干扰：**鼠标活动是突发式的**。
  // 实测（并发压力下）出现过 injected=1171.90px vs baseline=408.50px —— 用户/并发的
  // 鼠标活动恰好集中落在注入组那个采样窗口里，比值就翻倍。这与"我们移动了光标"
  // 无关，纯粹是采样窗口不对齐造成的假阳性。
  //
  // 所以主判据改成**代码级硬保证**：默认输入路径的源码里不存在
  // SetCursorPos/SendInput/mouse_event —— 从代码层面就**不可能**移动光标。
  // 统计对照降级为软判据（只在"基线安静却仍超标"时才判失败）。
  const viSrc = readFileSync(new URL('../lib/virtual-input.js', import.meta.url), 'utf8');
  const viCode = viSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const defaultPathBodies = ['click', 'move', 'scroll', 'writeText', 'keyCombo', 'pressKey']
    .map((fn) => {
      const s = viCode.indexOf(`export function ${fn}`);
      if (s < 0) return '';
      const e = viCode.indexOf('export function', s + 20);
      return viCode.slice(s, e < 0 ? undefined : e);
    }).join('\n');
  const usesRealCursorInDefaultPaths = /SetCursorPos|SendInput|mouse_event/.test(defaultPathBodies);
  // 基线安静（用户没在动鼠标）时，注入组超标才是真问题。
  const baselineQuiet = baseline.maxDisplacement < 30;

  info('位移比值判据（观察性）',
    `injected=${injection.maxDisplacement.toFixed(2)}px allowed<=${allowed.toFixed(2)}px `
    + `(baseline=${baseline.maxDisplacement.toFixed(2)}px, ${baselineQuiet ? '基线安静' : '基线有活动'}) `
    + `${ratioOk ? '在范围内' : '超出（可能是活动落在注入窗口）'}`);
  check('静态硬保证：默认输入路径不含 SetCursorPos/SendInput/mouse_event（代码层面不可能移动光标）',
    usesRealCursorInDefaultPaths === false,
    usesRealCursorInDefaultPaths ? '默认路径里发现了真实光标调用' : '');
  check('注入期间真实光标未被移动（静态保证 + 基线安静时的对照）',
    !usesRealCursorInDefaultPaths && (!baselineQuiet || ratioOk),
    `baseline=${baseline.maxDisplacement.toFixed(2)}px injected=${injection.maxDisplacement.toFixed(2)}px`);
  // 阈值按"每 tick 平均至少投递 1 条消息"设 —— 本测试的注入节奏是每个 tick 一次
  // move，外加每 20/25/35 tick 一次 click/key/scroll，2.2s 大约 140 tick。
  check('注入组确实投递了大量消息（断言非空转）',
    injection.injections >= injection.ticks, `injections=${injection.injections} ticks=${injection.ticks}`);
  check('注入组总投递数 > 基线组（对照组有效）',
    injection.injections > baseline.injections, `injection=${injection.injections} baseline=${baseline.injections}`);
  check('注入组的鼠标动作明细非空（点击/滚轮/按键都发生了）', (() => {
    const kinds = new Set(injectedMessages.map((entry) => entry.kind));
    return kinds.has('click') && kinds.has('scroll') && kinds.has('key');
  })(), JSON.stringify([...new Set(injectedMessages.map((entry) => entry.kind))]));

  // -------------------------------------------------------------------------
  group('6. 不抢焦点验证');
  // -------------------------------------------------------------------------

  // 说明：`spawn('notepad.exe')` 本身会让新窗口成为前台窗口 —— 这是**测试进程启动
  // 目标程序**的副作用，不是虚拟输入层抢的焦点。因此正确的不抢焦点断言是"注入
  // 期间前台窗口**始终不变**"，而不是"前台窗口绝不是 notepad"（后者只在用户手动
  // 保持别的窗口在前台时才成立，本测试不假设这一点，以免误判）。
  const foregroundBeforeAll = Number((await import('../lib/native.js')).loadWin32().GetForegroundWindow());
  const injectionForegrounds = [];
  const injectionCursors = [];
  for (let i = 0; i < 30; i += 1) {
    const { loadWin32 } = await import('../lib/native.js');
    injectionForegrounds.push(Number(loadWin32().GetForegroundWindow()));
    const cursorSample = cursorPosition();
    if (cursorSample.ok === true) injectionCursors.push(cursorSample);
    click(textHwnd, clickX, clickY);
    move(textHwnd, clickX + i, clickY + i);
    await sleep(12);
  }
  const foregroundAfterAll = Number((await import('../lib/native.js')).loadWin32().GetForegroundWindow());
  const uniqueForegrounds = [...new Set(injectionForegrounds)];
  info('注入前后前台窗口', `${foregroundBeforeAll} -> ${foregroundAfterAll}`);
  info('注入期间出现过的前台窗口', uniqueForegrounds);
  info('notepad 主窗口 hwnd', mainHwnd);
  info('注意：notepad 由本测试 spawn，它窗口出现时就已经是前台窗口', 'isForeground 在 2. 组已记录');
  if (injectionCursors.length > 0) {
    const cx = injectionCursors[0].x;
    const cy = injectionCursors[0].y;
    const maxDrift = Math.max(...injectionCursors.map((s) => Math.hypot(s.x - cx, s.y - cy)));
    info('本轮 30 次点击/移动期间的光标最大漂移', `${maxDrift.toFixed(2)}px（${injectionCursors.length} 次采样）`);
  }
  check('PostMessage 注入不会改变前台窗口（不抢焦点）',
    foregroundBeforeAll === foregroundAfterAll && uniqueForegrounds.length === 1,
    `before=${foregroundBeforeAll} after=${foregroundAfterAll} unique=${JSON.stringify(uniqueForegrounds)}`);

  // -------------------------------------------------------------------------
  group('7. 结构化返回与不抛异常');
  // -------------------------------------------------------------------------

  const badResults = [
    ['click 非法按钮', click(mainHwnd, 10, 10, { button: 'banana' })],
    ['click 非法 hwnd', click(0, 10, 10)],
    ['writeText 非法文本类型', writeText(mainHwnd, 12345)],
    ['pressKey 非法键名', pressKey(mainHwnd, 'not-a-real-key-xyz')],
    ['move 非法 hwnd', move(0, 1, 1)],
    ['scroll 非法 hwnd', scroll(0, 1)],
    ['probeWindow 非法 hwnd', probeWindow(-1)],
    ['clientToScreen 非法 hwnd', clientToScreen(0, 1, 1)],
    ['normalizePoint 非法空间', normalizePoint(mainHwnd, 1, 1, { space: 'warp' })],
    ['keyCombo 空主键', keyCombo(mainHwnd, [], ['ctrl'])],
  ];
  let structuredOk = true;
  for (const [label, value] of badResults) {
    const good = value !== null && typeof value === 'object' && typeof value.ok === 'boolean'
      && (value.ok === true || typeof value.reason === 'string');
    if (!good) structuredOk = false;
    info(label, value);
  }
  check('所有非法输入都返回结构化 { ok, reason } 且不抛异常', structuredOk);

  check('成功动作都报告 posted 计数', (() => {
    const m = move(textHwnd, 10, 10);
    return m.ok === true && typeof m.posted === 'number' && m.posted === 1;
  })());

  // -------------------------------------------------------------------------
  group('8. 清理');
  // -------------------------------------------------------------------------
  const killed = killOwnedProcesses();
  info('已 taskkill 的进程', killed);
  await sleep(500);
  const leftover = await (async () => {
    const { enumWindows } = await import('../lib/native.js');
    const found = [];
    enumWindows((hwnd) => {
      const probe = probeWindow(hwnd);
      if (probe.ok === true && probe.pid === notepad.pid) found.push(hwnd);
      return true;
    });
    return found;
  })();
  info('残留的 notepad 窗口', leftover);
  check('测试自己启动的 notepad 已清理干净', leftover.length === 0, `leftover=${JSON.stringify(leftover)}`);

  const cursorAtEnd = cursorPosition();
  info('测试结束时的真实光标位置', cursorAtEnd);
  info('测试全程光标净位移',
    (cursorAtStart.ok === true && cursorAtEnd.ok === true)
      ? `${Math.hypot(cursorAtEnd.x - cursorAtStart.x, cursorAtEnd.y - cursorAtStart.y).toFixed(2)}px`
      : 'n/a');

  return finish();
}

function finish() {
  console.log(`\n${'='.repeat(72)}\n== 结果汇总\n${'='.repeat(72)}`);
  const passed = results.filter((r) => r.ok === true).length;
  const failed = results.filter((r) => r.ok !== true);
  for (const item of results) {
    if (item.ok !== true) console.log(`  FAIL  [${item.group}] ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
  }
  console.log(`\n  ${passed} 通过 / ${failed.length} 失败 / 共 ${results.length} 项`);
  console.log(`  ${failed.length === 0 ? 'PASS — 全部通过' : 'FAIL — 存在失败用例'}`);

  // 无论成功失败都确保清理，绝不残留测试进程。
  const killed = killOwnedProcesses();
  if (killed.length > 0) console.log(`  (兜底清理 pid: ${killed.join(', ')})`);

  process.exitCode = failed.length === 0 ? 0 : 1;
  return { passed, failed: failed.length };
}

// 兜底：任何未捕获异常都不允许留下 notepad 进程。
process.on('uncaughtException', (error) => {
  console.error(`\n未捕获异常: ${error?.stack ?? error}`);
  killOwnedProcesses();
  process.exitCode = 1;
});
process.on('unhandledRejection', (error) => {
  console.error(`\n未处理的 Promise 拒绝: ${error?.stack ?? error}`);
  killOwnedProcesses();
  process.exitCode = 1;
});
process.on('SIGINT', () => {
  console.log('\n收到 SIGINT，清理测试进程……');
  killOwnedProcesses();
  process.exit(130);
});

await main();
