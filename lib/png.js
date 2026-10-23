/**
 * 零依赖 PNG 编解码器。
 *
 * 为什么自己写：插件要求**零依赖安装**（宿主自带 koffi 已用三级回退解决，不能再引入
 * 需要下载的包）。Node 内置 `zlib` 已经提供了 PNG 需要的 deflate/inflate，
 * 剩下的只是 chunk 封装、CRC32 与逐行 filter —— 都是几十行的事。
 *
 * 设计要点：
 *
 * 1. **编码走"原始 BGRA 像素 → RGBA → PNG"**。GDI 的 `GetDIBits` 给出的是
 *    top-down 32bpp **BGRA**（`BI_RGB`），而 PNG 要求 **RGBA** 且每行前有一个
 *    filter 字节。这两个转换在本模块里一次做完，调用方（capture.js）只管给像素。
 *
 * 2. **filter 用 Up（2）而不是 None（0）**。实测截图（大面积纯白 + 少量文字）
 *    用 None 时 IDAT 约 12KB，用 Up 能压到 1/3 左右。对"把图喂给模型"这个场景，
 *    体积直接决定 token 与传输开销，所以值得多这十几行。代价是逐行多一次减法。
 *
 * 3. **解码只实现"自己编出来的那一种子集"**：8bit、非隔行、colorType 0/2/4/6。
 *    本模块的解码主要用于**回读校验**（测试里验证 IHDR 与像素往返），不是通用
 *    PNG 库；遇到不支持的形式明确返回 `{ok:false, reason}`，不猜、不糊弄。
 *
 * 4. **绝不抛异常**：解码公开函数全部返回 `{ok,...}`；编码在输入非法时抛，
 *    因为它是内部调用（capture.js 已经校验过宽高），且失败必须让上层知道。
 */

import { deflateSync, inflateSync } from 'node:zlib';

/** PNG 文件签名。 */
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC32 查表（模块级只建一次）。 */
let crcTable;

function ensureCrcTable() {
  if (crcTable !== undefined) return crcTable;
  crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  return crcTable;
}

/** 计算 PNG chunk 的 CRC32（对 type+data 求值）。 */
export function crc32(buffer) {
  const table = ensureCrcTable();
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = table[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 封装一个 PNG chunk：length(4) + type(4) + data + crc(4)。 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/**
 * BGRA（GDI `GetDIBits` 的 top-down 32bpp 输出）转 RGBA。
 *
 * 顺带把 alpha 全部置为 255：`GetDIBits` 在 `BI_RGB` 下返回的第 4 字节是**未定义
 * 的填充值**（实测常为 0），直接用会让整张图在 PNG 里变全透明，模型看到一片空白。
 * 截图必然是"所见即所得"的不透明内容，所以强制不透明是正确语义。
 */
export function bgraToRgba(bgra) {
  const out = Buffer.allocUnsafe(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    out[i] = bgra[i + 2];
    out[i + 1] = bgra[i + 1];
    out[i + 2] = bgra[i];
    out[i + 3] = 255;
  }
  return out;
}

/** RGBA 转 BGRA（写回 GDI 或做往返校验时用）。 */
export function rgbaToBgra(rgba) {
  const out = Buffer.allocUnsafe(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = rgba[i + 2];
    out[i + 1] = rgba[i + 1];
    out[i + 2] = rgba[i];
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

/**
 * 用 Up(2) filter 把 RGBA 打包成 PNG 的 raw 扫描线流。
 *
 * Up filter：`out[i] = cur[i] - prev[i]`（按字节、模 256）。首行的 prev 视为全 0，
 * 于是首行退化成 None。解码时反向累加即可还原。
 */
function packScanlines(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y += 1) {
    const dest = y * (1 + stride);
    raw[dest] = 2; // filter type: Up
    const src = y * stride;
    if (y === 0) {
      rgba.copy(raw, dest + 1, src, src + stride);
    } else {
      const prev = src - stride;
      for (let i = 0; i < stride; i += 1) {
        raw[dest + 1 + i] = (rgba[src + i] - rgba[prev + i]) & 0xff;
      }
    }
  }
  return raw;
}

/**
 * 把 RGBA 像素编码为 PNG。
 *
 * @param rgba - 长度必须 >= width*height*4。
 * @param width,height - 正整数。
 * @param options.level - zlib 压缩级别（默认 6；截图场景 6 已经比 9 快很多而体积接近）。
 * @returns PNG 文件 Buffer。
 */
export function encodePngRgba(rgba, width, height, options = {}) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new Error(`encodePngRgba: invalid size ${String(width)}x${String(height)}`);
  }
  const need = w * h * 4;
  if (!Buffer.isBuffer(rgba) || rgba.length < need) {
    throw new Error(`encodePngRgba: expected at least ${need} bytes, got ${Buffer.isBuffer(rgba) ? rgba.length : typeof rgba}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: truecolor + alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  const level = Number.isInteger(options.level) ? Math.min(9, Math.max(0, options.level)) : 6;
  const idat = deflateSync(packScanlines(rgba, w, h), { level });

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 把 GDI 的 BGRA 像素编码为 PNG（capture.js 的主路径）。
 */
export function encodePngFromBgra(bgra, width, height, options = {}) {
  return encodePngRgba(bgraToRgba(bgra), width, height, options);
}

/** 判断是否是一个 PNG（只校验 8 字节签名）。 */
export function isPng(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= 8
    && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

/**
 * 读取 IHDR 的头几个字段，用于**不完整解码**的快速校验。
 *
 * 这是测试里"截图是否合法且尺寸正确"的主要判据：比全量解码便宜得多，
 * 而且能识别出"签名对但 IHDR 被写坏"这种半失败状态。
 */
export function readPngHeader(buffer) {
  if (!isPng(buffer)) return { ok: false, reason: 'not a PNG (bad 8-byte signature)' };
  if (buffer.length < 8 + 8 + 13 + 4) {
    return { ok: false, reason: `PNG truncated: ${buffer.length} bytes is too short for IHDR` };
  }
  // 第一个 chunk 必须是 IHDR，否则不是我们认识的 PNG。
  const type = buffer.toString('latin1', 12, 16);
  if (type !== 'IHDR') return { ok: false, reason: `first chunk is ${type}, expected IHDR` };

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  const interlace = buffer[28];
  const dataLength = buffer.readUInt32BE(8);
  if (dataLength !== 13) return { ok: false, reason: `IHDR length is ${dataLength}, expected 13` };

  return {
    ok: true,
    width,
    height,
    bitDepth,
    colorType,
    interlace,
    bytes: buffer.length,
    /** 逐字节校验 IHDR 的 CRC，能发现"写得看似正常但内容损坏"的图。 */
    ihdrCrcValid: (() => {
      try {
        // CRC 覆盖 **type + data**（即偏移 12..28，共 4+13=17 字节），
        // 存放在 data 之后的 4 字节（偏移 29..32）。
        // 这里曾经写成从偏移 16 起算、并去偏移 21 读校验值，导致所有 PNG 都被判为
        // CRC 错误 —— 一个把"健康"误报成"损坏"的假阴性，测试因此抓到了它。
        const declared = buffer.readUInt32BE(12 + 4 + 13);
        const actual = crc32(buffer.subarray(12, 12 + 4 + 13));
        return declared === actual;
      } catch {
        return false;
      }
    })(),
  };
}

/**
 * 解码 PNG（**仅支持本模块自己编出来的形式**）。
 *
 * 支持：8bit、非隔行、colorType 6(RGBA) / 2(RGB) / 4(灰度+alpha) / 0(灰度)。
 * 不支持就返回 `{ok:false, reason}` —— 不静默返回半张图。
 *
 * 用途是测试与校验（例如"编码 → 解码 → 像素一致"），不是给用户读任意 PNG。
 *
 * @returns `{ok, width, height, colorType, rgba}` 或 `{ok:false, reason}`。
 */
export function decodePng(buffer) {
  try {
    const header = readPngHeader(buffer);
    if (header.ok !== true) return header;
    if (header.bitDepth !== 8) return { ok: false, reason: `unsupported bit depth ${header.bitDepth} (only 8)` };
    if (header.interlace !== 0) return { ok: false, reason: 'interlaced PNG is not supported' };

    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header.colorType];
    if (channels === undefined) {
      return { ok: false, reason: `unsupported color type ${header.colorType} (only 0/2/4/6)` };
    }

    // 收集所有 IDAT（PNG 允许分片）。
    const parts = [];
    let offset = 8;
    while (offset + 8 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.toString('latin1', offset + 4, offset + 8);
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd + 4 > buffer.length) return { ok: false, reason: `chunk ${type} runs past end of file` };
      if (type === 'IDAT') parts.push(buffer.subarray(dataStart, dataEnd));
      if (type === 'IEND') break;
      offset = dataEnd + 4;
    }
    if (parts.length === 0) return { ok: false, reason: 'no IDAT chunk found' };

    const raw = inflateSync(Buffer.concat(parts));
    const { width, height } = header;
    const stride = width * channels;
    const expected = height * (1 + stride);
    if (raw.length < expected) {
      return { ok: false, reason: `inflated data is ${raw.length} bytes, expected at least ${expected}` };
    }

    // 逐行反 filter（只实现 0..4 全部五种，代价很低且更稳）。
    const flat = Buffer.alloc(height * stride);
    for (let y = 0; y < height; y += 1) {
      const filter = raw[y * (1 + stride)];
      const src = y * (1 + stride) + 1;
      const dst = y * stride;
      const up = dst - stride; // 上一行；首行为 -stride（视作 0）
      for (let x = 0; x < stride; x += 1) {
        const cur = raw[src + x];
        const a = x >= channels ? flat[dst + x - channels] : 0; // 左
        const b = up >= 0 ? flat[up + x] : 0;                   // 上
        const c = (x >= channels && up >= 0) ? flat[up + x - channels] : 0; // 左上
        let value;
        switch (filter) {
          case 0: value = cur; break;
          case 1: value = cur + a; break;
          case 2: value = cur + b; break;
          case 3: value = cur + ((a + b) >> 1); break;
          case 4: {
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            value = cur + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c));
            break;
          }
          default:
            return { ok: false, reason: `unknown filter type ${filter} on row ${y}` };
        }
        flat[dst + x] = value & 0xff;
      }
    }

    // 统一展开成 RGBA，方便调用方只处理一种布局。
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0, p = 0; i < width * height; i += 1, p += channels) {
      if (channels === 4) {
        rgba[i * 4] = flat[p];
        rgba[i * 4 + 1] = flat[p + 1];
        rgba[i * 4 + 2] = flat[p + 2];
        rgba[i * 4 + 3] = flat[p + 3];
      } else if (channels === 3) {
        rgba[i * 4] = flat[p];
        rgba[i * 4 + 1] = flat[p + 1];
        rgba[i * 4 + 2] = flat[p + 2];
        rgba[i * 4 + 3] = 255;
      } else if (channels === 2) {
        rgba[i * 4] = flat[p];
        rgba[i * 4 + 1] = flat[p];
        rgba[i * 4 + 2] = flat[p];
        rgba[i * 4 + 3] = flat[p + 1];
      } else {
        rgba[i * 4] = flat[p];
        rgba[i * 4 + 1] = flat[p];
        rgba[i * 4 + 2] = flat[p];
        rgba[i * 4 + 3] = 255;
      }
    }

    return { ok: true, width, height, colorType: header.colorType, channels, rgba };
  } catch (error) {
    return { ok: false, reason: `PNG decode failed: ${error?.message ?? String(error)}` };
  }
}

/**
 * 高质量降采样（box filter 均值）。
 *
 * 用**面积平均**而不是最近邻：截图里大量是文字，最近邻降采样会让笔画断裂、出现
 * 摩尔纹，OCR 识别率明显下降；面积平均虽然慢一点（O(输出像素) 且有整数加权），
 * 但保留文字可读性好得多。这是"给模型看的图"最关键的一步。
 *
 * 实现上按目标像素做矩形覆盖求和，用整数累加避免浮点误差累积。
 *
 * @param rgba - 源 RGBA（srcWidth*srcHeight*4）。
 * @param options.allowUpscale - 目标大于源时是否允许放大（默认 false，直接返回源）。
 * @returns `{rgba, width, height}`。
 */
export function resizeRgba(rgba, srcWidth, srcHeight, dstWidth, dstHeight) {
  const sw = Math.max(1, Math.trunc(srcWidth));
  const sh = Math.max(1, Math.trunc(srcHeight));
  const dw = Math.max(1, Math.trunc(dstWidth));
  const dh = Math.max(1, Math.trunc(dstHeight));

  if (dw === sw && dh === sh) return { rgba, width: sw, height: sh };

  // 源图必须是完整尺寸，否则下面的索引会越界。
  const need = sw * sh * 4;
  if (!Buffer.isBuffer(rgba) || rgba.length < need) {
    throw new Error(`resizeRgba: expected at least ${need} bytes, got ${Buffer.isBuffer(rgba) ? rgba.length : typeof rgba}`);
  }

  const out = Buffer.allocUnsafe(dw * dh * 4);
  // 每个目标像素覆盖的源区间 [x0,x1) x [y0,y1)，边界用整数除法算，避免浮点。
  for (let dy = 0; dy < dh; dy += 1) {
    const y0 = Math.floor((dy * sh) / dh);
    let y1 = Math.floor(((dy + 1) * sh) / dh);
    if (y1 <= y0) y1 = y0 + 1; // 放大时保证至少覆盖 1 行

    for (let dx = 0; dx < dw; dx += 1) {
      const x0 = Math.floor((dx * sw) / dw);
      let x1 = Math.floor(((dx + 1) * sw) / dw);
      if (x1 <= x0) x1 = x0 + 1;

      let r = 0; let g = 0; let b = 0; let a = 0; let count = 0;
      for (let sy = y0; sy < y1 && sy < sh; sy += 1) {
        let index = (sy * sw + x0) * 4;
        for (let sx = x0; sx < x1 && sx < sw; sx += 1) {
          r += rgba[index];
          g += rgba[index + 1];
          b += rgba[index + 2];
          a += rgba[index + 3];
          index += 4;
          count += 1;
        }
      }
      const o = (dy * dw + dx) * 4;
      if (count === 0) {
        // 理论上不会发生（上面的 y1/x1 保证 >=1），兜底取最近像素。
        const index = (Math.min(sh - 1, y0) * sw + Math.min(sw - 1, x0)) * 4;
        out[o] = rgba[index];
        out[o + 1] = rgba[index + 1];
        out[o + 2] = rgba[index + 2];
        out[o + 3] = rgba[index + 3];
      } else {
        out[o] = Math.round(r / count);
        out[o + 1] = Math.round(g / count);
        out[o + 2] = Math.round(b / count);
        out[o + 3] = Math.round(a / count);
      }
    }
  }
  return { rgba: out, width: dw, height: dh };
}

/**
 * 统计图像的基本特征，用于"这张图到底有没有内容"的客观判断。
 *
 * `nonBlackRatio` 是测试里判断 PrintWindow 是否真抓到内容的核心指标：
 * 抓取失败（例如硬件加速窗口、被 DWM 拒绝）的典型表现就是全黑，
 * 只看 `PrintWindow` 的返回值 true/false 会漏判。
 */
export function imageStats(rgba) {
  const total = Math.floor(rgba.length / 4);
  if (total === 0) return { ok: false, reason: 'empty image' };
  let nonBlack = 0;
  let nonWhite = 0;
  let sum = 0;
  // 大图按步长采样，避免为了统计把大图全扫一遍（1080p 是 200 万像素）。
  const step = total > 500000 ? Math.floor(total / 500000) : 1;
  let sampled = 0;
  for (let i = 0; i < total; i += step) {
    const o = i * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    if (r > 16 || g > 16 || b > 16) nonBlack += 1;
    if (r < 240 || g < 240 || b < 240) nonWhite += 1;
    sum += (r + g + b) / 3;
    sampled += 1;
  }
  return {
    ok: true,
    pixels: total,
    sampled,
    nonBlackRatio: nonBlack / sampled,
    nonWhiteRatio: nonWhite / sampled,
    meanLuma: sum / sampled,
  };
}
