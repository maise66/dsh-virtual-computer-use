/**
 * Windows 内置 OCR 引擎封装（`Windows.Media.Ocr`）。
 *
 * ## 为什么走子进程
 *
 * WinRT 的 `Windows.Media.Ocr.OcrEngine` 只能从 WinRT 语言投影调用，Node 没有这条投影。
 * 本机上唯一**零依赖**可用的通道是 Windows PowerShell 5.1（`powershell.exe`）——
 * 它能通过 `[Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime]`
 * 拿到引擎类型。
 *
 * ⚠️ **`pwsh`（PowerShell 7）在本机不存在**，必须用 `powershell.exe`。这是本仓库
 * 反复踩过的坑，所以下面用绝对路径 + 存在性探测来确定解释器。
 *
 * ## 关键设计：像素直喂，不走文件/Storage API
 *
 * 起初的实现是把 PNG 落盘，再在 PowerShell 里用
 * `StorageFile.GetFileFromPathAsync()` → `BitmapDecoder` → `SoftwareBitmap` 打开。
 * **实测在本机直接失败**（`参数错误：在指定的路径中找不到某个项目`），即使 `Test-Path`
 * 对该路径返回 true —— 说明这条 WinRT Storage 路线在当前会话/权限模型下不可用。
 *
 * 改用**原始 BGRA 像素**（`SoftwareBitmap.CreateCopyFromBuffer`）后立即成功：
 * 用 `System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions::AsBuffer`
 * 把字节数组转成 `IBuffer`，再创建 `SoftwareBitmap(Bgra8)`。
 * 好处有三个：
 *   1. 绕开了整个 Storage/文件系统权限模型，不依赖任何临时文件权限
 *   2. 省掉 PNG 编码 + 解码两次 CPU 开销（对"抓屏 → OCR"闭环是明显的延迟优势）
 *   3. 不存在临时文件残留与清理问题
 *
 * 所以本模块的**主路径是"传原始像素"**；`ocrImage()` 接受 PNG 时会先用
 * `lib/png.js` 解码成像素再走同一条路（不落盘）。
 *
 * ## 中文编码
 *
 * PowerShell 的输出默认是 OEM 代码页（实测 GBK），中文经 stdout 传回会变成乱码
 * （实测把 `中文识别测试` 读成了一串问号方块）。两个措施一起用：
 *   - 在脚本里设 `[Console]::OutputEncoding = [Text.Encoding]::UTF8`（实测有效）
 *   - 结果**同时写入 UTF-8 临时文件**，优先读文件（双保险，避免任何 stdout 乱码）
 *
 * ## 超时
 *
 * `execFile` 的 `timeout` 到点会**杀掉子进程**（实测 10s 的 Start-Sleep 在
 * 1500ms 超时下被终止，回调收到错误）。这就是"绝不能永远挂住"的保障。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { captureRegion, captureWindow, imagePointToClient, imagePointToScreen, listMonitors } from './capture.js';
import { decodePng } from './png.js';

/** 默认超时（毫秒）。OCR 是交互路径上的操作，超过 20s 已经说明环境有问题。 */
const DEFAULT_TIMEOUT_MS = 20000;

/** PowerShell 解释器候选（绝对路径优先，避免依赖 PATH 上有没有 pwsh）。 */
const POWERSHELL_CANDIDATES = [
  join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'powershell.exe',
];

/** 本机可用的 OCR 语言缓存（探测一次即可）。 */
let interpreterCache;
let languageCache;

/**
 * 找可用的 PowerShell 解释器。
 *
 * 刻意**只认 powershell.exe**：`pwsh` 在本机不存在，若在候选列表里靠前会浪费一次
 * 启动失败。Windows PowerShell 5.1 是 Windows 自带的，最可靠。
 */
export function findInterpreter() {
  if (interpreterCache !== undefined) return interpreterCache;
  for (const candidate of POWERSHELL_CANDIDATES) {
    try {
      // 绝对路径直接判存在；裸名字交给 PATH（existsSync 会返回 false，这时只能赌一次）。
      if (candidate.includes('\\') && !existsSync(candidate)) continue;
      interpreterCache = candidate;
      return interpreterCache;
    } catch {
      // 继续试下一个
    }
  }
  interpreterCache = undefined;
  return interpreterCache;
}

/** 把一段 PowerShell 脚本跑起来，返回 stdout/stderr/退出码，并保证超时被杀。 */
function runPowerShell(script, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const interpreter = findInterpreter();
  if (interpreter === undefined) {
    return Promise.resolve({ ok: false, reason: 'powershell.exe not found (Windows PowerShell 5.1 is required for OCR)' });
  }

  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      interpreter,
      // -NoProfile 保证不受用户 profile 干扰；-NonInteractive 避免任何提示卡住；
      // -ExecutionPolicy Bypass 允许直接执行内联脚本（不写 .ps1 文件）。
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        windowsHide: true,
        timeout: timeoutMs,
        // 16MB 足够容纳词级 JSON；超大图也不会爆。
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1' },
      },
      (error, stdout, stderr) => {
        const elapsedMs = Date.now() - started;
        if (error !== null && error !== undefined) {
          const killed = error.killed === true || error.signal !== null && error.signal !== undefined;
          resolve({
            ok: false,
            timedOut: killed && elapsedMs >= timeoutMs - 200,
            elapsedMs,
            reason: killed
              ? `PowerShell was terminated after ${elapsedMs}ms (timeout ${timeoutMs}ms)`
              : `PowerShell exited with an error: ${error?.message ?? String(error)}`,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
          });
          return;
        }
        resolve({ ok: true, elapsedMs, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

/**
 * 构造"等待 WinRT IAsyncOperation"的公共脚本前缀。
 *
 * PS 5.1 没有 `await` 语法，必须用 `System.WindowsRuntimeSystemExtensions.AsTask`：
 * 先反射找出**泛型重载**（参数只有 1 个且形参类型名为 `IAsyncOperation\`1`），
 * 再用 `MakeGenericMethod(结果类型)` 实例化，`Wait(-1)` 阻塞直到完成。
 *
 * 这个反射是必须的：直接写 `AsTask($op)` 在 PS 里会因重载解析失败而报
 * "使用"1"个参数调用"Wait"时发生异常"，实测正是这个错误。
 */
const PS_PRELUDE = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  return $task.Result
}
$SG   = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$BPF  = [Windows.Graphics.Imaging.BitmapPixelFormat,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$OCR  = [Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime]
$OCRR = [Windows.Media.Ocr.OcrResult,Windows.Media.Ocr,ContentType=WindowsRuntime]
`;

/** 把 JSON 用 UTF-8 **无 BOM** 写到文件（走文件是为了绕开 stdout 编码问题）。 */
function jsonToFileScript(objectJson, outPath) {
  const escaped = outPath.replace(/\\/g, '\\\\');
  return `
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText('${escaped}', @'
${objectJson}
'@, $utf8)
`;
}

/** 探测本机可用的 OCR 语言。 */
export async function listOcrLanguages(options = {}) {
  if (languageCache !== undefined && options.refresh !== true) return languageCache;

  const script = `${PS_PRELUDE}
try {
  $langs = @()
  foreach ($l in $OCR::AvailableRecognizerLanguages) { $langs += $l.LanguageTag }
  $engine = $OCR::TryCreateFromUserProfileLanguages()
  $user = if ($null -eq $engine) { $null } else { $engine.RecognizerLanguage.LanguageTag }
  @{ ok = $true; languages = $langs; userProfileLanguage = $user } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; reason = $_.Exception.GetBaseException().Message } | ConvertTo-Json -Compress
}`;

  const run = await runPowerShell(script, { timeoutMs: options.timeoutMs ?? 15000 });
  if (run.ok !== true) {
    languageCache = {
      ok: false,
      languages: [],
      reason: run.reason ?? 'listing OCR languages failed',
      stderr: run.stderr ? run.stderr.slice(0, 800) : undefined,
      installHint: ocrInstallHint(),
    };
    return languageCache;
  }

  const parsed = parseJsonFromOutput(run.stdout);
  if (parsed === undefined) {
    languageCache = {
      ok: false,
      languages: [],
      reason: `could not parse OCR language list from PowerShell output: ${JSON.stringify(run.stdout.slice(0, 300))}`,
      installHint: ocrInstallHint(),
    };
    return languageCache;
  }

  languageCache = {
    ok: parsed.ok === true,
    languages: Array.isArray(parsed.languages) ? parsed.languages : [],
    userProfileLanguage: parsed.userProfileLanguage ?? undefined,
    reason: parsed.ok === true ? undefined : (parsed.reason ?? 'unknown error'),
    installHint: parsed.ok === true ? undefined : ocrInstallHint(),
  };
  return languageCache;
}

/** 从可能混有噪声的输出里抽 JSON（单行压缩 JSON 是我们自己的约定）。 */
function parseJsonFromOutput(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return undefined;

  // 正常情况下整段就是一个 JSON 对象。
  try {
    return JSON.parse(trimmed);
  } catch {
    // 否则找最后一行能解析的（PowerShell 可能先输出别的）。
  }
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try {
      return JSON.parse(line);
    } catch {
      // 继续往上找
    }
  }
  // 再退一步：抓第一个 { 到最后一个 } 之间的内容。
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** 环境缺失时给用户的安装提示（诚实降级，而不是假装成功）。 */
function ocrInstallHint() {
  return {
    howToInstall: [
      'Windows PowerShell (as Administrator):',
      '  Get-WindowsCapability -Online | Where-Object Name -like "Language.OCR*" | Select-Object Name, State',
      '  # install Simplified Chinese OCR (and/or English):',
      '  Add-WindowsCapability -Online -Name "Language.OCR~~~zh-CN~0.0.1.0"',
      '  Add-WindowsCapability -Online -Name "Language.OCR~~~en-GB~0.0.1.0"',
      'Or via Settings > Time & Language > Language & region > (your language) > Language options > Optical character recognition.',
    ],
    note: 'OCR requires the Windows.Media.Ocr engine plus at least one installed OCR language pack. '
      + 'Without a pack, AvailableRecognizerLanguages is empty and no text can be recognized.',
  };
}

/**
 * 核心：把 BGRA 像素交给 Windows OCR，拿回文本与词级边界框。
 *
 * @param bgra - top-down 32bpp BGRA 像素。
 * @param width,height - 像素尺寸。
 * @param options.language - 语言标签（如 'zh-Hans-CN' / 'en-GB'），省略或 'auto' 时用用户配置语言。
 * @param options.timeoutMs - 子进程超时，默认 20000。
 * @returns `{ok, text, lines, language, engineLanguage, elapsedMs}` 或 `{ok:false, reason, installHint}`。
 */
async function recognizeBgra(bgra, width, height, options = {}) {
  const w = Math.trunc(Number(width));
  const h = Math.trunc(Number(height));
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    return { ok: false, reason: `invalid image size ${String(width)}x${String(height)}` };
  }
  if (!Buffer.isBuffer(bgra) || bgra.length < w * h * 4) {
    return {
      ok: false,
      reason: `expected ${w * h * 4} BGRA bytes, got ${Buffer.isBuffer(bgra) ? bgra.length : typeof bgra}`,
    };
  }

  // OCR 引擎对过小的图会直接返回空结果；太小的输入明确告知而不是静默返回空文本。
  if (w < 8 || h < 8) {
    return { ok: false, reason: `image is too small for OCR (${w}x${h}); Windows OCR needs at least a few pixels per glyph` };
  }

  const language = typeof options.language === 'string' && options.language !== '' && options.language !== 'auto'
    ? options.language
    : undefined;

  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), 'vcu-ocr-'));
  } catch (error) {
    return { ok: false, reason: `could not create a temp directory: ${error?.message ?? String(error)}` };
  }

  const pixelPath = join(dir, 'px.bin');
  const resultPath = join(dir, 'result.json');
  const escapedPixelPath = pixelPath.replace(/\\/g, '\\\\');
  const escapedResultPath = resultPath.replace(/\\/g, '\\\\');

  try {
    await writeFile(pixelPath, bgra);

    // 语言选择：显式语言优先；'auto'/未指定时用 TryCreateFromUserProfileLanguages，
    // 失败再退回"第一个可用语言"，最后才是明确失败。
    const languageScript = language === undefined
      ? `
$engine = $OCR::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
  $avail = @($OCR::AvailableRecognizerLanguages)
  if ($avail.Count -gt 0) {
    $engine = $OCR::TryCreateFromLanguage($avail[0])
  }
}
`
      : `
$engine = $null
$want = '${language.replace(/'/g, "''")}'
try {
  $tag = [Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]::new($want)
  $engine = $OCR::TryCreateFromLanguage($tag)
} catch { $engine = $null }
`;

    const script = `${PS_PRELUDE}
$resultPath = '${escapedResultPath}'
function Fail($message) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($resultPath, (@{ ok = $false; reason = $message } | ConvertTo-Json -Compress -Depth 6), $utf8)
  Write-Output 'VCU_OCR_FAILED'
  exit 0
}
try {
  ${languageScript}
  if ($null -eq $engine) {
    $avail = @($OCR::AvailableRecognizerLanguages) | ForEach-Object { $_.LanguageTag }
    Fail ("no OCR engine available for the requested language; installed languages: " + ($(if ($avail.Count -eq 0) { '(none)' } else { $avail -join ', ' })))
  }

  $bytes = [System.IO.File]::ReadAllBytes('${escapedPixelPath}')
  if ($bytes.Length -ne (${w} * ${h} * 4)) {
    Fail ("pixel buffer size mismatch: " + $bytes.Length + " bytes, expected " + (${w} * ${h} * 4))
  }

  $buffer = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($bytes, 0, $bytes.Length)
  $bitmap = $SG::CreateCopyFromBuffer($buffer, $BPF::Bgra8, ${w}, ${h})
  if ($null -eq $bitmap) { Fail 'SoftwareBitmap.CreateCopyFromBuffer returned null' }

  $result = Await ($engine.RecognizeAsync($bitmap)) $OCRR

  $lines = New-Object System.Collections.ArrayList
  foreach ($line in $result.Lines) {
    $words = New-Object System.Collections.ArrayList
    foreach ($word in $line.Words) {
      $r = $word.BoundingRect
      [void]$words.Add([ordered]@{
        text = $word.Text
        bbox = [ordered]@{
          x = [double]$r.X; y = [double]$r.Y
          width = [double]$r.Width; height = [double]$r.Height
        }
      })
    }
    [void]$lines.Add([ordered]@{ text = $line.Text; words = @($words) })
  }

  $payload = [ordered]@{
    ok = $true
    text = $result.Text
    lines = @($lines)
    engineLanguage = $engine.RecognizerLanguage.LanguageTag
  }
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($resultPath, ($payload | ConvertTo-Json -Compress -Depth 8), $utf8)
  Write-Output 'VCU_OCR_OK'
} catch {
  Fail ($_.Exception.GetBaseException().Message)
}
`;

    const run = await runPowerShell(script, { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });

    if (run.timedOut === true) {
      return {
        ok: false,
        reason: run.reason,
        timedOut: true,
        elapsedMs: run.elapsedMs,
        hint: 'OCR did not finish in time. A very large image or a busy/paged-out OCR engine can cause this; '
          + 'try a smaller region (captureRegion) or raise options.timeoutMs.',
      };
    }

    // 结果优先从文件读（UTF-8 无 BOM，绕开 stdout 代码页问题）。
    let payload;
    try {
      payload = JSON.parse(await readFile(resultPath, 'utf8'));
    } catch (error) {
      // 文件读不到时才退回解析 stdout。
      payload = parseJsonFromOutput(run.stdout);
      if (payload === undefined) {
        return {
          ok: false,
          reason: `OCR subprocess produced no parsable result (exit ok=${run.ok}): ${run.stderr ? run.stderr.slice(0, 600) : run.reason ?? 'no output'}`,
          elapsedMs: run.elapsedMs,
          stdout: run.stdout.slice(0, 600),
          stderr: run.stderr ? run.stderr.slice(0, 600) : undefined,
        };
      }
    }

    if (payload.ok !== true) {
      return {
        ok: false,
        reason: payload.reason ?? 'OCR failed for an unknown reason',
        elapsedMs: run.elapsedMs,
        installHint: ocrInstallHint(),
      };
    }

    // 规范化成稳定结构：lines[].words[].bbox 一定是 {x,y,width,height} 数字。
    const lines = (Array.isArray(payload.lines) ? payload.lines : []).map((line) => ({
      text: String(line?.text ?? ''),
      words: (Array.isArray(line?.words) ? line.words : []).map((word) => ({
        text: String(word?.text ?? ''),
        bbox: {
          x: Number(word?.bbox?.x ?? 0),
          y: Number(word?.bbox?.y ?? 0),
          width: Number(word?.bbox?.width ?? 0),
          height: Number(word?.bbox?.height ?? 0),
        },
      })),
    }));

    return {
      ok: true,
      text: String(payload.text ?? ''),
      lines,
      lineCount: lines.length,
      wordCount: lines.reduce((total, line) => total + line.words.length, 0),
      engineLanguage: payload.engineLanguage ?? undefined,
      elapsedMs: run.elapsedMs,
    };
  } catch (error) {
    return { ok: false, reason: `OCR pipeline failed: ${error?.message ?? String(error)}` };
  } finally {
    // 临时目录必须清掉：宿主长期存活，逐次泄漏小文件最终会占满磁盘。
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响 OCR 结果。
    }
  }
}

/**
 * 对一张图做 OCR。
 *
 * 接受的输入：
 *   - `{bgra, width, height}`：原始像素（**最快，无编解码**，`capturePixels()` 可直接喂）
 *   - `captureWindow/FullScreen/Region` 的返回值：内部已带像素时会走快路径
 *   - PNG `Buffer`：用 lib/png.js 解码（不落盘）
 *   - PNG 文件路径 `string`：读文件后解码
 *
 * @param options.language - 'zh-Hans-CN' | 'en-GB' | 'auto'（默认 auto = 用户配置语言）
 * @param options.timeoutMs - 子进程超时，默认 20000
 * @param options.attachCoordinates - true 时给每个 word 附加屏幕/客户区坐标（需图上带 origin 信息）
 * @returns `{ok, text, lines, language, elapsedMs}` 或 `{ok:false, reason, installHint}`
 */
export async function ocrImage(input, options = {}) {
  const started = Date.now();

  let bgra;
  let width;
  let height;
  /** 图片像素 → 屏幕/客户区 的换算所需的元信息（有则附加坐标）。 */
  let origin;

  try {
    if (Buffer.isBuffer(input)) {
      if (input.length >= 8 && input[0] === 0x89 && input[1] === 0x50) {
        const decoded = decodePng(input);
        if (decoded.ok !== true) return { ok: false, reason: `could not decode the PNG: ${decoded.reason}` };
        // OCR 要 BGRA；解码给的是 RGBA。
        bgra = Buffer.allocUnsafe(decoded.rgba.length);
        for (let i = 0; i < decoded.rgba.length; i += 4) {
          bgra[i] = decoded.rgba[i + 2];
          bgra[i + 1] = decoded.rgba[i + 1];
          bgra[i + 2] = decoded.rgba[i];
          bgra[i + 3] = 255;
        }
        width = decoded.width;
        height = decoded.height;
      } else {
        return {
          ok: false,
          reason: 'raw Buffer input is not supported: pass {bgra,width,height} for pixels, a PNG Buffer, or a file path',
        };
      }
    } else if (typeof input === 'string') {
      let bytes;
      try {
        bytes = await readFile(input);
      } catch (error) {
        return { ok: false, reason: `could not read ${input}: ${error?.message ?? String(error)}` };
      }
      const decoded = decodePng(bytes);
      if (decoded.ok !== true) return { ok: false, reason: `could not decode ${input}: ${decoded.reason}` };
      bgra = Buffer.allocUnsafe(decoded.rgba.length);
      for (let i = 0; i < decoded.rgba.length; i += 4) {
        bgra[i] = decoded.rgba[i + 2];
        bgra[i + 1] = decoded.rgba[i + 1];
        bgra[i + 2] = decoded.rgba[i];
        bgra[i + 3] = 255;
      }
      width = decoded.width;
      height = decoded.height;
    } else if (input !== null && typeof input === 'object') {
      if (Buffer.isBuffer(input.bgra)) {
        bgra = input.bgra;
        width = input.width;
        height = input.height;
        origin = input;
      } else if (Buffer.isBuffer(input.png)) {
        const decoded = decodePng(input.png);
        if (decoded.ok !== true) return { ok: false, reason: `could not decode the capture PNG: ${decoded.reason}` };
        bgra = Buffer.allocUnsafe(decoded.rgba.length);
        for (let i = 0; i < decoded.rgba.length; i += 4) {
          bgra[i] = decoded.rgba[i + 2];
          bgra[i + 1] = decoded.rgba[i + 1];
          bgra[i + 2] = decoded.rgba[i];
          bgra[i + 3] = 255;
        }
        width = decoded.width;
        height = decoded.height;
        origin = input;
      } else if (Buffer.isBuffer(input.rgba)) {
        // 调用方给的是 RGBA（例如 png.js 解码结果），转成 BGRA。
        bgra = Buffer.allocUnsafe(input.rgba.length);
        for (let i = 0; i < input.rgba.length; i += 4) {
          bgra[i] = input.rgba[i + 2];
          bgra[i + 1] = input.rgba[i + 1];
          bgra[i + 2] = input.rgba[i];
          bgra[i + 3] = 255;
        }
        width = input.width;
        height = input.height;
        origin = input;
      } else {
        return {
          ok: false,
          reason: 'unsupported image input: expected {bgra,width,height}, {png}, {rgba}, a PNG Buffer, or a file path',
        };
      }
    } else {
      return { ok: false, reason: `unsupported image input type: ${typeof input}` };
    }

    const result = await recognizeBgra(bgra, width, height, options);
    if (result.ok !== true) return result;

    const enriched = {
      ...result,
      width: Math.trunc(Number(width)),
      height: Math.trunc(Number(height)),
      language: result.engineLanguage ?? (options.language ?? 'auto'),
      elapsedMs: Date.now() - started,
      /** 每行的整体 bbox（由词框并集推出，模型更常直接用行级坐标来点）。 */
      lines: result.lines.map((line, index) => ({
        index,
        text: line.text,
        bbox: unionBbox(line.words.map((word) => word.bbox)),
        words: line.words,
      })),
    };

    // 附加坐标换算：把词/行的图片像素坐标同时给出屏幕坐标（有 origin 时还给客户区坐标）。
    if (options.attachCoordinates !== false && origin !== undefined && origin.ok === true && origin.width === width) {
      enriched.coordinates = attachCoordinates(enriched.lines, origin);
    }
    return enriched;
  } catch (error) {
    return { ok: false, reason: `ocrImage failed: ${error?.message ?? String(error)}` };
  }
}

/** 求一组 bbox 的并集（行级框）。 */
function unionBbox(boxes) {
  if (!Array.isArray(boxes) || boxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    if (!Number.isFinite(box?.x) || !Number.isFinite(box?.y)) continue;
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + (Number(box.width) || 0));
    maxY = Math.max(maxY, box.y + (Number(box.height) || 0));
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) };
}

/**
 * 给每行/每词附加屏幕坐标与客户区坐标。
 *
 * 这是本模块**最有产品价值的一步**：模型看到 "OK 按钮在 (412,336)" 之后，
 * 需要一个能直接喂给 `vcu_click` 的**客户区坐标**。换算链条：
 *
 *   OCR 的 bbox（图片像素）
 *     → ÷ scale（截图可能被缩小过）
 *     → + 图片原点在屏幕上的偏移（窗口位置 / region 的 x,y）
 *     = 屏幕坐标
 *     → − 客户区原点在屏幕上的位置
 *     = 客户区坐标（`vcu_click` 要的就是这个）
 *
 * 同时给出 `center`，因为点文字通常应该点它的中心而不是左上角。
 *
 * 若截图结果里没有 hwnd（例如 captureRegion / captureFullScreen），只给屏幕坐标。
 */
export function attachCoordinates(lines, capture) {
  if (capture === null || capture === undefined || capture.ok !== true) return undefined;
  const hwnd = Number(capture.hwnd);
  const hasHwnd = Number.isInteger(hwnd) && hwnd !== 0;

  const convert = (bbox) => {
    // 取框中心，而不是左上角。
    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + bbox.height / 2;
    const screen = imagePointToScreen(capture, { x: cx, y: cy });
    if (screen.ok !== true) return undefined;

    const entry = {
      centerImage: { x: Math.round(cx * 100) / 100, y: Math.round(cy * 100) / 100 },
      screen: { x: Math.round(screen.x), y: Math.round(screen.y) },
      bboxImage: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
    };
    if (hasHwnd) {
      const client = imagePointToClient(capture, { x: cx, y: cy });
      if (client.ok === true) {
        entry.client = { x: client.clientX, y: client.clientY };
        entry.clickHint = `vcu_click(hwnd=${hwnd}, x=${client.clientX}, y=${client.clientY})`;
      }
    }
    return entry;
  };

  return {
    hwnd: hasHwnd ? hwnd : undefined,
    /** 图片尺寸与缩放比：换算结果的中间量，暴露出来便于调用方核对。 */
    image: {
      width: capture.width,
      height: capture.height,
      sourceWidth: capture.sourceWidth,
      sourceHeight: capture.sourceHeight,
      scale: capture.scale,
    },
    lines: lines.map((line) => ({
      index: line.index,
      text: line.text,
      line: convert(line.bbox),
      words: line.words.map((word) => ({
        text: word.text,
        ...convert(word.bbox),
      })),
    })),
  };
}

/**
 * 抓屏 + OCR 一步到位（**最常见的用法**）。
 *
 * @param x,y,width,height - 屏幕坐标区域；省略则抓整个虚拟屏。
 * @param options.language / timeoutMs / maxWidth / maxBytes / attachCoordinates
 * @param options.hwnd - 传窗口句柄时改抓该窗口（可用 PrintWindow 抓后台窗口），
 *                       并让 bbox 能换算成**客户区坐标**。
 * @returns `{ok, text, lines, language, capture, ...}`
 */
export async function ocrScreenRegion(x, y, width, height, options = {}) {
  let capture;
  let mode;

  if (options.hwnd !== undefined && options.hwnd !== null) {
    mode = 'window';
    capture = captureWindow(options.hwnd, options);
  } else if (x === undefined || width === undefined) {
    mode = 'virtual-screen';
    const { captureFullScreen } = await import('./capture.js');
    capture = captureFullScreen(options);
  } else {
    mode = 'region';
    capture = captureRegion(x, y, width, height, options);
  }

  if (capture.ok !== true) {
    return { ok: false, reason: `screen capture failed: ${capture.reason}`, captureFailed: true };
  }

  // 直接用 capture 结果里的像素快路径会更好，但 capture 返回的是 PNG；
  // 这里走 PNG 解码（不落盘），避免为了 OCR 再抓一次屏。
  const result = await ocrImage(capture, options);
  if (result.ok !== true) {
    return { ...result, capture: summarizeCapture(capture) };
  }

  return {
    ...result,
    mode,
    capture: summarizeCapture(capture),
    text: result.text,
  };
}

/** 截图结果的精简摘要（PNG 本体太大，不塞进 OCR 返回值里）。 */
function summarizeCapture(capture) {
  return {
    ok: capture.ok,
    method: capture.method,
    width: capture.width,
    height: capture.height,
    sourceWidth: capture.sourceWidth,
    sourceHeight: capture.sourceHeight,
    scale: capture.scale,
    bytes: capture.bytes,
    content: capture.content,
    windowRect: capture.windowRect,
    clientOrigin: capture.clientOrigin,
    region: capture.region,
    screenOrigin: capture.screenOrigin,
    cursorUntouched: capture.cursorUntouched,
  };
}

/**
 * 对窗口截图并 OCR（PrintWindow 语义：**被遮挡/后台窗口也能读**）。
 *
 * 这是"AI 看一眼这个窗口里有什么字"的最直接入口。
 *
 * @returns `{ok, text, lines, coordinates, capture, ...}`
 */
export async function ocrWindow(hwnd, options = {}) {
  return ocrScreenRegion(undefined, undefined, undefined, undefined, { ...options, hwnd });
}

/**
 * 在 OCR 结果里按文本查找（大小写不敏感的包含匹配），返回带坐标的命中项。
 *
 * 把"看到字"变成"能点击"的桥梁：模型可以直接拿 `clickHint` 去调 `vcu_click`。
 *
 * @param ocrResult - `ocrImage` / `ocrWindow` 的返回值（必须开了 attachCoordinates）。
 * @param query - 要查找的文本。
 * @param options.exact - true 时要求完全相等（默认子串匹配）。
 */
export function findText(ocrResult, query, options = {}) {
  if (ocrResult === null || ocrResult === undefined || ocrResult.ok !== true) {
    return { ok: false, reason: 'findText needs a successful OCR result' };
  }
  const needle = String(query ?? '');
  if (needle === '') return { ok: false, reason: 'query is empty' };
  const want = needle.toLowerCase();
  const exact = options.exact === true;

  const coordinates = ocrResult.coordinates;
  const matches = [];

  for (const line of ocrResult.lines ?? []) {
    const lineText = String(line.text ?? '');
    const lineMatches = exact ? lineText.toLowerCase() === want : lineText.toLowerCase().includes(want);
    if (lineMatches) {
      const coord = coordinates?.lines?.find((entry) => entry.index === line.index);
      matches.push({
        scope: 'line',
        text: lineText,
        bbox: line.bbox,
        screen: coord?.line?.screen,
        client: coord?.line?.client,
        clickHint: coord?.line?.clickHint,
      });
    }
    for (const word of line.words ?? []) {
      const wordText = String(word.text ?? '');
      const wordMatches = exact ? wordText.toLowerCase() === want : wordText.toLowerCase().includes(want);
      if (!wordMatches) continue;
      const coord = coordinates?.lines
        ?.find((entry) => entry.index === line.index)
        ?.words?.find((entry) => entry.text === word.text);
      matches.push({
        scope: 'word',
        text: wordText,
        lineText,
        bbox: word.bbox,
        screen: coord?.screen,
        client: coord?.client,
        clickHint: coord?.clickHint,
      });
    }
  }

  return {
    ok: true,
    query: needle,
    count: matches.length,
    /** 优先返回词级命中（更精确），行级命中作为兜底。 */
    matches,
    best: matches.find((entry) => entry.scope === 'word' && entry.clickHint !== undefined)
      ?? matches.find((entry) => entry.clickHint !== undefined)
      ?? matches[0],
  };
}

/**
 * 能力自检：OCR 能不能用、有哪些语言、装在哪。
 *
 * 这是 `vcu_status` 的视觉部分要用的；它**真的去启动一次引擎**（而不是只看
 * 文件存在），因为"引擎类型能反射到"和"有可用语言包"是两回事。
 */
export async function describeOcr(options = {}) {
  const interpreter = findInterpreter();
  const languages = await listOcrLanguages(options);

  const ok = interpreter !== undefined && languages.ok === true && languages.languages.length > 0;

  return {
    ok,
    supported: ok,
    interpreter,
    /** 首选语言：用户配置语言，其次列表里的第一个。 */
    preferredLanguage: languages.userProfileLanguage ?? languages.languages[0],
    availableLanguages: languages.languages,
    userProfileLanguage: languages.userProfileLanguage,
    reason: ok
      ? undefined
      : (languages.reason
        ?? (interpreter === undefined ? 'powershell.exe not found' : 'no OCR language pack is installed')),
    installHint: ok ? undefined : (languages.installHint ?? ocrInstallHint()),
    timeoutMs: Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS,
    /** 如实说明局限，避免调用方以为 OCR 无所不能。 */
    limitations: [
      'Recognition quality depends heavily on font size, contrast and anti-aliasing. Small UI text ' +
        '(<= 10px), thin fonts and low-contrast text are frequently misread or dropped. Scaling the ' +
        'capture up (options.scale > 1) before OCR usually helps.',
      'Windows OCR is a line/word recognizer: it returns text and axis-aligned boxes, not structure. ' +
        'There is no confidence score exposed through this API.',
      'Mixed CJK+Latin text is recognized with the CJK engine (zh-Hans-CN), which sometimes turns ' +
        'Latin digits/letters into visually similar CJK glyphs (measured: "2026" -> "2926", "Hello" -> "He110").',
      'bbox coordinates are in IMAGE pixels. Always convert with the "coordinates" section (or ' +
        'imagePointToClient) before clicking; a scaled or region capture is off by the scale factor otherwise.',
      'Each OCR call spawns a PowerShell process (roughly 300-500ms of fixed overhead on this machine). ' +
        'Batch work into region captures instead of calling per-tile.',
    ],
    monitors: (() => {
      const listed = listMonitors();
      return listed.ok === true ? listed.monitors.length : undefined;
    })(),
  };
}

/** 模块导出清单（供 tools 层与诊断展示）。 */
export const PUBLIC_API = {
  ocrImage,
  ocrScreenRegion,
  ocrWindow,
  findText,
  attachCoordinates,
  listOcrLanguages,
  describeOcr,
  findInterpreter,
};
