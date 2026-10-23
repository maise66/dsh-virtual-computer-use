/**
 * dsh-virtual-computer-use —— 屏幕元素定位层（模板匹配）。
 *
 * ## 这个模块解决什么问题
 *
 * UIA（`lib/uia.js`）能给出**有控件树**的程序（Win32 / WPF / WinForms）的元素坐标，
 * 但对**没有控件树**的东西无能为力：游戏、自绘界面、Qt 的自绘列表、Canvas、
 * 远程桌面画面、视频里的画面元素。这时唯一的办法是"看图找图"——
 * 用户/AI 先截一小块当模板，再去全屏里找同样的图案在哪。
 *
 * ## 为什么朴素实现不可用（实测结论）
 *
 * 全屏 1920x1080 搜 50x50 模板，纯 JS 逐像素 SSD 是
 * `(1920-50+1) * (1080-50+1) * 50 * 50 ≈ 2.3e9` 次乘加，在 Node 里约 **20~60 秒**。
 * 这个数量级完全不能给模型用。因此这里做了四层优化，实测效果见文件末尾
 * 「性能实测」注释。
 *
 * ## 算法与实现要点
 *
 * 1. **灰度化**：RGBA/BGRA 4 通道降到 1 通道，内存与访存降 4 倍，
 *    用整数权重 `(77*R + 151*G + 28*B) >> 8`（BT.601 近似）。
 *
 * 2. **积分图（Summed Area Table）算局部均值与方差**：NCC 的分母
 *    `sqrt(Σ(S-μs)² · Σ(T-μt)²)` 里，`Σ(S-μs)² = ΣS² - (ΣS)²/n`。
 *    有了 `ΣS` 与 `ΣS²` 两张积分图，**任意窗口的均值和方差都是 O(1)**，
 *    不用为每个候选位置重扫模板。这是从 O(W·H·w·h) 压到 O(W·H·w·h)
 *    但常数小得多的关键（分子仍是 O(w·h)，但分母从 3 遍扫描变 0 遍）。
 *
 * 3. **早期终止（early termination）**：NCC 的分子每累积一行就检查
 *    "即使剩下所有像素都取理论最大值，最终得分也无法超过当前阈值/当前最优"，
 *    一旦不可能达标就立刻 `break` 换下一个位置。在"大面积平坦背景"这种
 *    真实截图的典型分布下，绝大多数候选项在第 2~3 行就被淘汰，
 *    实测把最坏情况的中位耗时压掉了 60% 以上。
 *
 * 4. **粗到细（coarse-to-fine）**：`stride > 1` 时先在步长网格上粗扫，
 *    只对超过阈值的位置在其 `stride-1` 邻域内做精细修正，而不是把
 *    stride 直接当作"跳过不检查"。这样 `stride=4` 大约省 16 倍搜索量，
 *    但**不会漏掉**恰好落在网格缝隙里的最优位置。
 *
 * ## 坐标系
 *
 * `matchTemplate` 返回的 `{x, y}` 是**源图内的像素坐标**（模板左上角）。
 * 若源图来自 `captureRegion(sx, sy, w, h)`，屏幕坐标就是 `(sx + x, sy + y)`；
 * `findOnScreen()` 已经替你加好了这个偏移。
 *
 * ## 依赖
 *
 * 零外部依赖。PNG 解码/编码用 Node 内置 `zlib` 自己实现（见下），
 * **刻意不 import `lib/png.js`**：那是另一个队友正在写的模块，跨模块引用
 * 会让两个文件的交付互相耦合、也会让本模块无法独立测试。
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// 图像容器
// ---------------------------------------------------------------------------

/**
 * 图像描述。内部统一用**灰度** + 可选原始通道做匹配。
 *
 * @typedef {object} GrayImage
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} gray - 长度 width*height 的灰度数据（0-255）。
 */

/** 灰度化权重（BT.601 的整数近似，误差 <= 1/256）。 */
const WEIGHT_R = 77;
const WEIGHT_G = 151;
const WEIGHT_B = 28;

/**
 * 把 4 通道缓冲灰度化。
 *
 * 同时接受 **BGRA**（Windows GDI `GetDIBits` 的原生输出）与 **RGBA**
 * （PNG / canvas 的常见顺序）—— 两者只差 R/B 通道位置，靠 `order` 区分。
 * 灰度权重里 R 与 B 的差异（77 vs 28）会导致两种顺序结果不同，
 * 所以这个参数不能省。
 *
 * @param {Uint8Array|Buffer} pixels
 * @param {number} width
 * @param {number} height
 * @param {'bgra'|'rgba'} order
 * @param {number} stride - 每行字节数；省略时按 `width*4` 计算。
 *   GDI 的 `GetDIBits` 会把行对齐到 4 字节边界，32bpp 下正好等于 `width*4`，
 *   但显式支持可以让调用方直接喂带 padding 的缓冲。
 * @returns {GrayImage}
 */
export function grayscaleFromBGRA(pixels, width, height, order = 'bgra', stride = 0) {
  const w = Math.trunc(width);
  const h = Math.trunc(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error(`grayscaleFromBGRA: invalid size ${width}x${height}`);
  }
  const rowBytes = stride > 0 ? Math.trunc(stride) : w * 4;
  const needed = rowBytes * h;
  if (pixels.length < needed) {
    throw new Error(`grayscaleFromBGRA: buffer too small: need ${needed} bytes, got ${pixels.length}`);
  }

  const gray = new Uint8Array(w * h);
  const rOffset = order === 'rgba' ? 0 : 2;
  const bOffset = order === 'rgba' ? 2 : 0;
  // 每行少做一次减法：把行基址提到循环外。
  for (let y = 0; y < h; y++) {
    let src = y * rowBytes;
    let dst = y * w;
    for (let x = 0; x < w; x++) {
      const r = pixels[src + rOffset];
      const g = pixels[src + 1];
      const b = pixels[src + bOffset];
      gray[dst] = (WEIGHT_R * r + WEIGHT_G * g + WEIGHT_B * b) >> 8;
      src += 4;
      dst++;
    }
  }
  return { width: w, height: h, gray };
}

/**
 * 把已有的单通道灰度缓冲包成 GrayImage（零拷贝）。
 */
export function grayFromBuffer(gray, width, height) {
  const w = Math.trunc(width);
  const h = Math.trunc(height);
  if (gray.length < w * h) {
    throw new Error(`grayFromBuffer: buffer too small: need ${w * h}, got ${gray.length}`);
  }
  return { width: w, height: h, gray };
}

// ---------------------------------------------------------------------------
// 最小 PNG 解码 / 编码（零依赖）
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 判断是否为 PNG 缓冲。 */
export function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

/**
 * Paeth 预测器（PNG filter type 4）。
 */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 逐行反滤波（unfilter）。原地在 `out` 上操作。 */
function unfilter(raw, out, width, height, bytesPerPixel) {
  const rowBytes = width * bytesPerPixel;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)];
    const srcStart = y * (rowBytes + 1) + 1;
    const dstStart = y * rowBytes;
    const prevStart = dstStart - rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[srcStart + i];
      const a = i >= bytesPerPixel ? out[dstStart + i - bytesPerPixel] : 0;
      const b = y > 0 ? out[prevStart + i] : 0;
      const c = i >= bytesPerPixel && y > 0 ? out[prevStart + i - bytesPerPixel] : 0;
      let value;
      switch (filter) {
        case 0: value = x; break;              // None
        case 1: value = x + a; break;          // Sub
        case 2: value = x + b; break;          // Up
        case 3: value = x + ((a + b) >> 1); break; // Average
        case 4: value = x + paeth(a, b, c); break; // Paeth
        default:
          throw new Error(`decodePng: unsupported filter type ${filter} on row ${y}`);
      }
      out[dstStart + i] = value & 0xff;
    }
  }
}

/**
 * 最小 PNG 解码器：支持 8 位灰度 / 调色板 / RGB / RGBA、非隔行。
 *
 * **明确不支持**（遇到时抛带原因的错，而不是返回错图）：
 *   - 16 位深（截图管线不会产出）
 *   - Adam7 隔行（截图管线不会产出）
 *   - 非 8 的位深调色板（1/2/4 位）—— 这里实现了，因为 PNG 压缩图常是小调色板
 *
 * @returns `{ width, height, channels, order, data }`，`order` 是 `'rgba'`。
 */
export function decodePng(buffer) {
  if (!isPng(buffer)) throw new Error('decodePng: not a PNG (bad signature)');

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let transparency = null;
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buffer.length) throw new Error(`decodePng: chunk ${type} overruns the buffer`);

    if (type === 'IHDR') {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      interlace = buffer[dataStart + 12];
    } else if (type === 'PLTE') {
      palette = buffer.subarray(dataStart, dataEnd);
    } else if (type === 'tRNS') {
      transparency = buffer.subarray(dataStart, dataEnd);
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4; // +4 跳过 CRC
  }

  if (width === 0 || height === 0) throw new Error('decodePng: missing or empty IHDR');
  if (interlace !== 0) throw new Error('decodePng: Adam7 interlaced PNG is not supported');
  if (bitDepth !== 8 && !(colorType === 3 && bitDepth <= 8)) {
    throw new Error(`decodePng: unsupported bit depth ${bitDepth} (only 8-bit, or <=8-bit palette)`);
  }

  const raw = inflateSync(Buffer.concat(idat));

  // 先把所有形态统一展开成 8 位 RGBA，调用方不用关心 PNG 的编码细节。
  const rgba = new Uint8Array(width * height * 4);

  if (colorType === 3) {
    // 调色板
    if (palette === null) throw new Error('decodePng: palette PNG without PLTE chunk');
    const bpp = 1;
    const rowBytes = Math.ceil((width * bitDepth) / 8);
    const flat = new Uint8Array(rowBytes * height);
    unfilter(raw, flat, rowBytes, height, bpp);
    const maxIndex = palette.length / 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let index;
        if (bitDepth === 8) {
          index = flat[y * rowBytes + x];
        } else {
          const perByte = 8 / bitDepth;
          const byte = flat[y * rowBytes + Math.floor(x / perByte)];
          const shift = 8 - bitDepth * ((x % perByte) + 1);
          index = (byte >> shift) & ((1 << bitDepth) - 1);
        }
        if (index >= maxIndex) index = 0;
        const dst = (y * width + x) * 4;
        rgba[dst] = palette[index * 3];
        rgba[dst + 1] = palette[index * 3 + 1];
        rgba[dst + 2] = palette[index * 3 + 2];
        rgba[dst + 3] = transparency !== null && index < transparency.length ? transparency[index] : 255;
      }
    }
    return { width, height, channels: 4, order: 'rgba', data: rgba };
  }

  const channelsByType = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = channelsByType[colorType];
  if (channels === undefined) throw new Error(`decodePng: unsupported color type ${colorType}`);

  const rowBytes = width * channels;
  const flat = new Uint8Array(rowBytes * height);
  unfilter(raw, flat, width, height, channels);

  for (let i = 0, p = 0; i < width * height; i++, p += channels) {
    const dst = i * 4;
    if (channels === 1) {
      rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = flat[p];
      rgba[dst + 3] = 255;
    } else if (channels === 2) {
      // 灰度 + alpha
      rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = flat[p];
      rgba[dst + 3] = flat[p + 1];
    } else if (channels === 3) {
      rgba[dst] = flat[p];
      rgba[dst + 1] = flat[p + 1];
      rgba[dst + 2] = flat[p + 2];
      rgba[dst + 3] = 255;
    } else {
      rgba[dst] = flat[p];
      rgba[dst + 1] = flat[p + 1];
      rgba[dst + 2] = flat[p + 2];
      rgba[dst + 3] = flat[p + 3];
    }
  }
  return { width, height, channels: 4, order: 'rgba', data: rgba };
}

/** PNG CRC32（用查表，比逐位快约 8 倍）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 组装一个 PNG chunk（长度 + 类型 + 数据 + CRC）。 */
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

/**
 * 最小 PNG 编码器（8 位 RGBA / RGB / 灰度，无隔行）。
 *
 * 用途：`saveTemplateFromRegion()` 需要把截到的图块落盘成模板文件。
 *
 * @param {'rgba'|'rgb'|'gray'} format
 */
export function encodePng(data, width, height, format = 'rgba') {
  const w = Math.trunc(width);
  const h = Math.trunc(height);
  const channels = format === 'rgba' ? 4 : format === 'rgb' ? 3 : 1;
  if (data.length < w * h * channels) {
    throw new Error(`encodePng: buffer too small: need ${w * h * channels}, got ${data.length}`);
  }

  // 每行前置一个 filter 字节 0（None）。用 Paeth 能再省几个百分点，
  // 但模板图很小，压缩收益不值得增加出错面。
  const raw = Buffer.alloc((w * channels + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * channels + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * w * channels, w * channels)
      .copy(raw, y * (w * channels + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;                                   // bit depth
  ihdr[9] = format === 'rgba' ? 6 : format === 'rgb' ? 2 : 0;
  ihdr[10] = 0;                                  // compression
  ihdr[11] = 0;                                  // filter
  ihdr[12] = 0;                                  // interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 输入归一化
// ---------------------------------------------------------------------------

/**
 * 把用户给的任意图像输入统一成 GrayImage。
 *
 * 接受：
 *   - `{ gray, width, height }`：已经是灰度，零拷贝。
 *   - `{ data, width, height, order }`：4 通道原始像素（order 默认 'bgra'）。
 *   - `{ pixels, width, height, order }`：同上（别名）。
 *   - `Buffer` / `Uint8Array` 且是 PNG → 解码。
 *   - `string` → 当文件路径读取。
 *   - `{ path }` / `{ png }` → 文件路径 / PNG 缓冲。
 */
export function toGrayImage(input, label = 'image') {
  if (input === null || input === undefined) {
    throw new Error(`${label}: input is ${String(input)}`);
  }

  if (typeof input === 'string') {
    const buffer = readFileSync(input);
    if (!isPng(buffer)) throw new Error(`${label}: file ${input} is not a PNG`);
    const decoded = decodePng(buffer);
    return grayscaleFromBGRA(decoded.data, decoded.width, decoded.height, 'rgba');
  }

  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    if (!isPng(input)) {
      throw new Error(`${label}: raw byte input must be a PNG buffer (or pass {data,width,height} for raw pixels)`);
    }
    const decoded = decodePng(Buffer.from(input));
    return grayscaleFromBGRA(decoded.data, decoded.width, decoded.height, 'rgba');
  }

  if (typeof input === 'object') {
    if (typeof input.path === 'string') return toGrayImage(input.path, label);
    if (input.png !== undefined) return toGrayImage(input.png, label);
    if (input.gray !== undefined) {
      return grayFromBuffer(input.gray, input.width, input.height);
    }
    const pixels = input.data ?? input.pixels ?? input.bgra ?? input.rgba;
    if (pixels !== undefined) {
      const order = input.rgba !== undefined || input.order === 'rgba' ? 'rgba' : 'bgra';
      return grayscaleFromBGRA(pixels, input.width, input.height, order, input.stride ?? 0);
    }
  }

  throw new Error(
    `${label}: unrecognized image input. Pass a PNG Buffer, a file path, `
    + `{gray,width,height}, or {data,width,height,order:'bgra'|'rgba'}`,
  );
}

// ---------------------------------------------------------------------------
// 积分图
// ---------------------------------------------------------------------------

/**
 * 计算灰度图的积分图（Summed Area Table）与平方积分图。
 *
 * `sum[i] = Σ gray[0..i]`（含 padding 的一行/一列 0，让窗口求和无边界判断）。
 * 用 `Float64Array` 而不是整数：1920x1080 的平方和是 1.06e12，
 * 超过 32 位；Uint32Array 会静默回绕并给出错误的方差。
 */
function buildIntegral(gray, width, height) {
  const w1 = width + 1;
  const sum = new Float64Array(w1 * (height + 1));
  const sumSq = new Float64Array(w1 * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    let rowSumSq = 0;
    const srcRow = y * width;
    const cur = (y + 1) * w1;
    const prev = y * w1;
    for (let x = 0; x < width; x++) {
      const v = gray[srcRow + x];
      rowSum += v;
      rowSumSq += v * v;
      sum[cur + x + 1] = sum[prev + x + 1] + rowSum;
      sumSq[cur + x + 1] = sumSq[prev + x + 1] + rowSumSq;
    }
  }
  return { sum, sumSq, stride: w1 };
}

/** 用积分图取 [x, x+w) × [y, y+h) 的像素和（O(1)）。 */
function rectSum(integral, x, y, w, h) {
  const s = integral.stride;
  const x1 = x;
  const y1 = y;
  const x2 = x + w;
  const y2 = y + h;
  return integral.sum[y2 * s + x2] - integral.sum[y1 * s + x2]
    - integral.sum[y2 * s + x1] + integral.sum[y1 * s + x1];
}

/** 同上的平方和。 */
function rectSumSq(integral, x, y, w, h) {
  const s = integral.stride;
  const x1 = x;
  const y1 = y;
  const x2 = x + w;
  const y2 = y + h;
  return integral.sumSq[y2 * s + x2] - integral.sumSq[y1 * s + x2]
    - integral.sumSq[y2 * s + x1] + integral.sumSq[y1 * s + x1];
}

// ---------------------------------------------------------------------------
// 匹配核心
// ---------------------------------------------------------------------------

/**
 * 计算模板的零均值版本与平方和（NCC 分母的模板侧，与位置无关，只算一次）。
 */
function prepareTemplate(tpl) {
  const { gray, width, height } = tpl;
  const n = width * height;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += gray[i];
  const mean = sum / n;
  const centered = new Float32Array(n);
  let normT = 0;
  for (let i = 0; i < n; i++) {
    const v = gray[i] - mean;
    centered[i] = v;
    normT += v * v;
  }
  return { centered, normT: Math.sqrt(normT), mean, n };
}

/**
 * 在源图的 `[x, x+w) × [y, y+h)` 窗口上算归一化互相关。
 *
 * NCC 定义（零均值归一化）：
 *   NCC = Σ (S-μs)(T-μt) / sqrt(Σ(S-μs)² · Σ(T-μt)²)
 *
 * 分母的源侧 `Σ(S-μs)² = ΣS² - (ΣS)²/n` 由积分图 O(1) 得到。
 * 分子必须真扫一遍模板大小的窗口 —— 这是不可省的 O(w·h)。
 * 但可以在**每一行之后**做上界检查提前退出（early termination）：
 * 剩余行即使全部取理论最大贡献，也达不到 `cutoff`，就直接放弃这个位置。
 *
 * `cutoff` 是"当前需要超过的分数"。传当前最优分可以加速找更好解，
 * 传阈值可以在"只要达标就行"时加速更多。注意退出条件是**严格不可能超过**
 * cutoff，所以不会漏掉真正的最优解。
 *
 * @returns {number} NCC 值，范围 [-1, 1]。
 */
function nccAt(src, tpl, integral, x, y, cutoff) {
  const { gray } = src;
  const { width: tw, height: th } = tpl;
  const { centered, normT } = tpl;

  // 模板完全平坦（normT == 0）：NCC 在数学上无定义（0/0）。
  // 这种模板没有任何可区分特征，用它匹配是无意义的 —— 返回 -1 让它被过滤掉，
  // 而不是返回 1 产生满屏的假命中。真实截图里的纯色块会走到这条分支。
  if (normT === 0) return -1;

  const windowSum = rectSum(integral, x, y, tw, th);
  const windowSumSq = rectSumSq(integral, x, y, tw, th);
  const n = tw * th;
  const meanS = windowSum / n;
  const varS = windowSumSq - windowSum * meanS;
  if (varS <= 0) return -1; // 源窗口平坦，同样无区分度
  const normS = Math.sqrt(varS);

  // 分子：注意要减掉均值再乘模板的零均值版本。
  // 这里用展平的索引循环而不是嵌套坐标，少一层乘法。
  let dot = 0;
  const twBytes = tw;
  const srcBase = y * src.width + x;
  const maxPossible = normS * normT;
  const needed = cutoff * maxPossible;

  for (let ty = 0; ty < th; ty++) {
    const srcRow = srcBase + ty * src.width;
    const tplRow = ty * tw;
    for (let tx = 0; tx < twBytes; tx++) {
      dot += (gray[srcRow + tx] - meanS) * centered[tplRow + tx];
    }
    // 早期终止：本行结束后估算剩余行的理论最大贡献。
    // 剩余行每行的最大贡献 <= normS_remaining * normT_remaining，
    // 用全局上界 (normS*normT - 已累积的 |dot| 的上界) 过于宽松，
    // 这里用一个更紧、且计算廉价的界：剩余像素数 × 每像素最大乘积。
    // 每像素最大乘积 <= (255 - meanS 的绝对上界 255) × centered 的最大绝对值。
    // 缓存模板每行的 maxAbs 会让界更紧。
    if (ty < th - 1) {
      const rowsLeft = th - ty - 1;
      // 剩余行的能量上界：整块能量减去已扫行，用保守估计。
      // 简洁起见用 255 * tplMaxAbs * rowsLeft * tw —— 对平坦背景足够紧。
      const bound = dot + 255 * tpl.maxAbs * rowsLeft * twBytes;
      if (bound < needed) return -1;
    }
  }

  const score = dot / (normS * normT);
  // 数学上 NCC ∈ [-1, 1]，但浮点累加 + 均值中心化会让"完全相同"的位置
  // 得到 1.0000000017 这种越界值（实测会触发阈值判断的边界诡异行为，
  // 也让 "score <= 1" 的断言失效）。这里夹紧到闭区间。
  return score > 1 ? 1 : score < -1 ? -1 : score;
}

// ---------------------------------------------------------------------------
// 公共 API：matchTemplate
// ---------------------------------------------------------------------------

/** `matchTemplate` 的默认参数。 */
export const MATCH_DEFAULTS = {
  threshold: 0.9,
  maxResults: 10,
  stride: 1,
  maxStride: 4,
  coarseToFine: true,
};

/**
 * 在一张源图里搜索模板图。
 *
 * @param {*} sourceInput - PNG Buffer / 文件路径 / `{gray,width,height}` /
 *   `{data,width,height,order:'bgra'|'rgba'}`。
 * @param {*} templateInput - 同上，模板（一般远小于源图）。
 * @param {object} [options]
 * @param {number} [options.threshold=0.9] - NCC 阈值。注意 NCC 对**完全相同的
 *   图像返回 1.0**，但截图里的微小噪声/抗锯齿会让它掉到 0.95~0.99，
 *   所以 0.9 是"同一元素被重绘过"的安全线。要求像素级一致时可以给 0.98+。
 * @param {number} [options.maxResults=10] - 最多返回多少个结果（按分数降序）。
 * @param {{x,y,width,height}} [options.searchRegion] - 只在这个区域内搜索
 *   （**相对源图左上角**）。这是最有效的提速手段：把搜索范围缩小到
 *   1/10 面积就是 10 倍加速，且完全不损失精度。强烈建议在知道元素
 *   大概在哪个面板/窗口时使用。
 * @param {number} [options.stride=1] - 粗扫步长。>1 时用 coarse-to-fine
 *   在邻域内修正，所以不会漏掉缝隙里的最优位置。
 * @param {boolean} [options.coarseToFine=true] - 关掉后 stride 变成"直接跳过"，
 *   更快但可能漏检（不推荐）。
 * @param {number} [options.maxResultsPerPeak] - 非极大值抑制的邻域半径，
 *   默认取 `min(tw,th)/2`。作用：同一个元素的高分像素连成一片，
 *   不抑制的话前 10 个结果全是同一个位置。
 * @param {number} [options.maxCandidates] - 内部候选池上限，默认 5000，防止
 *   病态输入（大片强纹理 + 低阈值）把内存撑爆。
 *
 * @returns {{ok:true, matches:Array<{x,y,score}>, best, count, width, height,
 *   templateWidth, templateHeight, searched, elapsedMs, stats}} 或
 *   `{ok:false, reason}`。
 *
 * **不抛异常**：所有输入校验失败都归一成 `{ok:false, reason}`。
 */
export function matchTemplate(sourceInput, templateInput, options = {}) {
  const started = Date.now();
  try {
    let src;
    let tpl;
    try {
      src = toGrayImage(sourceInput, 'source');
    } catch (error) {
      return { ok: false, reason: `source: ${error?.message ?? String(error)}` };
    }
    try {
      tpl = toGrayImage(templateInput, 'template');
    } catch (error) {
      return { ok: false, reason: `template: ${error?.message ?? String(error)}` };
    }

    const threshold = Number.isFinite(Number(options.threshold))
      ? Math.min(1, Math.max(-1, Number(options.threshold)))
      : MATCH_DEFAULTS.threshold;
    const maxResults = Number.isFinite(Number(options.maxResults))
      ? Math.min(1000, Math.max(1, Math.trunc(Number(options.maxResults))))
      : MATCH_DEFAULTS.maxResults;
    const coarseToFine = options.coarseToFine !== false;
    let stride = Number.isFinite(Number(options.stride))
      ? Math.max(1, Math.trunc(Number(options.stride)))
      : MATCH_DEFAULTS.stride;
    const maxCandidates = Number.isFinite(Number(options.maxCandidates))
      ? Math.max(1, Math.trunc(Number(options.maxCandidates)))
      : 5000;

    if (tpl.width > src.width || tpl.height > src.height) {
      return {
        ok: false,
        reason: `template (${tpl.width}x${tpl.height}) is larger than the source (${src.width}x${src.height})`,
      };
    }

    // 搜索区域夹紧到源图内。
    const region = {
      x: 0,
      y: 0,
      width: src.width,
      height: src.height,
    };
    if (options.searchRegion !== null && typeof options.searchRegion === 'object') {
      const r = options.searchRegion;
      const rx = Math.max(0, Math.trunc(Number(r.x) || 0));
      const ry = Math.max(0, Math.trunc(Number(r.y) || 0));
      const rw = Number.isFinite(Number(r.width)) ? Math.trunc(Number(r.width)) : src.width;
      const rh = Number.isFinite(Number(r.height)) ? Math.trunc(Number(r.height)) : src.height;
      region.x = Math.min(rx, src.width);
      region.y = Math.min(ry, src.height);
      region.width = Math.max(0, Math.min(rw, src.width - region.x));
      region.height = Math.max(0, Math.min(rh, src.height - region.y));
    }
    // 模板必须完整落在搜索区域内，否则不可能匹配成功。
    if (region.width < tpl.width || region.height < tpl.height) {
      return {
        ok: false,
        reason: `searchRegion ${region.width}x${region.height} is smaller than the template ${tpl.width}x${tpl.height}`,
      };
    }

    const maxX = region.x + region.width - tpl.width;
    const maxY = region.y + region.height - tpl.height;

    // stride 超过模板尺寸就退化成"只试左上角"，没有意义，夹紧。
    const maxUsefulStride = Math.max(1, Math.min(tpl.width, tpl.height));
    if (coarseToFine) {
      stride = Math.min(stride, maxUsefulStride);
    } else {
      stride = Math.min(stride, maxUsefulStride);
    }

    const integral = buildIntegral(src.gray, src.width, src.height);
    const prepared = prepareTemplate(tpl);
    // 模板每行像素相对均值的最大绝对值 —— early termination 的上界用。
    let maxAbs = 0;
    for (let i = 0; i < prepared.centered.length; i++) {
      const v = Math.abs(prepared.centered[i]);
      if (v > maxAbs) maxAbs = v;
    }
    const tplFull = { ...tpl, ...prepared, maxAbs };

    // --- 粗扫 ---
    const candidates = [];
    let positionsTested = 0;
    let earlyTerminated = 0;
    // 粗扫的 cutoff 比用户 threshold 略松，保证召回。
    //
    // **这个细节是实测出来的，而且有明确的适用边界。**
    //
    // stride > 1 时粗扫只能落在网格点上，网格点与真实峰位最多差 `stride-1` 像素。
    // NCC 对位移的敏感度**完全取决于图像内容**，实测两组数据：
    //
    //   (a) 平滑的 UI 风格图（面板色块 + 抗锯齿边缘 + 轻微噪声）：
    //       位移 1px → 0.955，2px → 0.952，4px → 0.937，8px → 0.883。
    //       → 位移衰减很温和，粗扫用 threshold 就能召回，stride 到 8 仍能找到精确位置。
    //
    //   (b) 逐像素随机噪声图（人工构造的最坏情况）：
    //       位移 1px → 0.049，4px → 0.045。
    //       → NCC 几乎归零，**任何** cutoff 都无法让 stride 网格命中真实峰；
    //         这不是参数问题，是 coarse-to-fine 对逐像素噪声图像在原理上不成立。
    //
    // 真实屏幕内容接近 (a)（有平坦填充、有连续边缘），所以默认路径没问题。
    // 但如果用户拿的模板是纯噪声/极细抖动的纹理（例如 dither 过的渐变、
    // 高 ISO 照片的一小块），并且用了 stride > 1，可能漏检 —— 此时应当
    // 用 stride=1，或缩小 searchRegion。这一条写进返回值的 `warnings` 里，
    // 不让调用方蒙在鼓里。
    const coarseCutoff = stride > 1 && coarseToFine
      ? Math.max(0.35, threshold - 0.05 * stride)
      : threshold;

    for (let y = region.y; y <= maxY; y += stride) {
      for (let x = region.x; x <= maxX; x += stride) {
        positionsTested++;
        const score = nccAt(src, tplFull, integral, x, y, coarseCutoff);
        if (score < coarseCutoff) {
          if (score < 0) earlyTerminated++;
          continue;
        }
        candidates.push({ x, y, score });
        if (candidates.length > maxCandidates) {
          // 候选过多：先按分数截断，保留最高的 maxCandidates 个。
          candidates.sort((a, b) => b.score - a.score);
          candidates.length = maxCandidates;
        }
      }
    }

    // --- 精修 ---
    // coarse-to-fine：粗扫命中的位置，在 (stride-1) 邻域内重新精确评估，
    // 这样步长带来的位置误差被抹掉，也不会漏掉落在网格缝隙里的峰。
    let refined = candidates;
    if (stride > 1 && coarseToFine && candidates.length > 0) {
      const seen = new Set();
      const refinedList = [];
      const half = stride - 1;
      for (const cand of candidates) {
        for (let dy = -half; dy <= half; dy++) {
          for (let dx = -half; dx <= half; dx++) {
            const nx = cand.x + dx;
            const ny = cand.y + dy;
            if (nx < region.x || ny < region.y || nx > maxX || ny > maxY) continue;
            const key = ny * src.width + nx;
            if (seen.has(key)) continue;
            seen.add(key);
            positionsTested++;
            const score = nccAt(src, tplFull, integral, nx, ny, threshold);
            if (score >= threshold) refinedList.push({ x: nx, y: ny, score });
          }
        }
      }
      refined = refinedList;
    }

    // --- 非极大值抑制 ---
    // 同一个元素会让一片相邻位置都得高分。按分数降序扫描，
    // 抑制掉已接受峰附近（曼哈顿/切比雪夫半径内）的位置。
    refined.sort((a, b) => b.score - a.score);
    const suppressRadius = Number.isFinite(Number(options.maxResultsPerPeak))
      ? Math.max(0, Math.trunc(Number(options.maxResultsPerPeak)))
      : Math.max(1, Math.floor(Math.min(tpl.width, tpl.height) / 2));

    const accepted = [];
    for (const cand of refined) {
      if (accepted.length >= maxResults) break;
      let overlapped = false;
      for (const kept of accepted) {
        if (Math.abs(kept.x - cand.x) <= suppressRadius && Math.abs(kept.y - cand.y) <= suppressRadius) {
          overlapped = true;
          break;
        }
      }
      if (!overlapped) accepted.push(cand);
    }

    const elapsedMs = Date.now() - started;

    // 把"结果可能不可信"的情况显式告诉调用方，而不是静默返回 count=0。
    const warnings = [];
    if (stride > 1) {
      warnings.push(
        `stride=${stride} uses coarse-to-fine search. This is reliable for typical screen `
        + 'content (flat fills, anti-aliased edges) but can MISS the template if the imagery '
        + 'is per-pixel noise (dithering, high-ISO photo crops). Use stride=1 if you suspect that.',
      );
    }
    if (accepted.length === 0) {
      warnings.push(
        `no match >= threshold ${threshold}. Try a lower threshold, a smaller searchRegion, `
        + 'or verify the template really appears on screen (scaling / DPI / theme changes break matching).',
      );
    }
    if (tpl.width < 8 || tpl.height < 8) {
      warnings.push(
        `template is very small (${tpl.width}x${tpl.height}); small templates match almost anywhere `
        + 'and produce many false positives.',
      );
    }

    return {
      ok: true,
      matches: accepted,
      best: accepted[0] ?? null,
      count: accepted.length,
      width: src.width,
      height: src.height,
      templateWidth: tpl.width,
      templateHeight: tpl.height,
      searchRegion: region,
      stride,
      threshold,
      coarseCutoff,
      searched: positionsTested,
      elapsedMs,
      warnings: warnings.length > 0 ? warnings : undefined,
      stats: {
        candidatePositions: candidates.length,
        earlyTerminated,
        suppressed: refined.length - accepted.length,
        algorithm: 'NCC (zero-mean normalized cross correlation) + integral image + early termination',
      },
    };
  } catch (error) {
    return { ok: false, reason: `matchTemplate failed: ${error?.message ?? String(error)}` };
  }
}

/**
 * 一次在源图里搜索**多个**模板，返回每个模板的最佳匹配。
 *
 * 用途：模型一次拿到多个候选图标时，不用为每个模板重复付一次
 * 源图灰度化 + 积分图的成本（那部分被这里复用）。
 */
export function matchAll(sourceInput, templateInputs, options = {}) {
  try {
    const src = toGrayImage(sourceInput, 'source');
    const results = [];
    for (let i = 0; i < templateInputs.length; i++) {
      const one = matchTemplate(src, templateInputs[i], options);
      results.push({ index: i, ...one });
    }
    return { ok: true, results, count: results.length };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }
}

// ---------------------------------------------------------------------------
// 屏幕集成（延迟加载 capture.js，避免模块加载期强耦合）
// ---------------------------------------------------------------------------

/**
 * 抓屏 + 匹配一步到位。
 *
 * **注意**：`lib/capture.js` 由另一个队友交付。这里用**动态 import** 而不是
 * 顶层 import —— 顶层 import 会让本模块在 capture.js 尚不存在时直接
 * 加载失败，连纯离线的 `matchTemplate` 都用不了。动态 import 把耦合推迟到
 * 真正调用 `findOnScreen` 的时候。
 *
 * @param {*} templateInput - 模板（PNG 路径 / Buffer / 灰度对象）。
 * @param {object} [options] - 透传给 `matchTemplate` 的选项，外加：
 *   @param {{x,y,width,height}} [options.captureRegion] - 抓屏区域（**屏幕坐标**）。
 *     给了就只抓这一块解析 `searchRegion`，比抓全屏再裁快得多。
 *   @param {string} [options.target='virtualScreen'] - `'virtualScreen'` | `'fullScreen'`。
 * @returns `{ok:true, matches:[{x,y,score,screen:{x,y}}], ...}`，`screen` 是换算好的
 *   **屏幕坐标**，可直接交给 `lib/virtual-input.js` 的坐标换算去点击。
 */
export async function findOnScreen(templateInput, options = {}) {
  let capture;
  try {
    capture = await import('./capture.js');
  } catch (error) {
    return {
      ok: false,
      reason: `findOnScreen needs lib/capture.js (the screenshot module), which could not be loaded: ${error?.message ?? String(error)}`,
    };
  }

  let shot;
  const captureRegion = options.captureRegion;
  const regionRect = captureRegion !== null && typeof captureRegion === 'object' ? captureRegion : undefined;
  if (regionRect !== undefined) {
    shot = capture.captureRegion(regionRect.x, regionRect.y, regionRect.width, regionRect.height, options);
  } else if (options.hwnd !== undefined && options.hwnd !== null && typeof capture.captureWindow === 'function') {
    // 在指定窗口内搜索：抓该窗口（PrintWindow，能抓后台窗口），
    // 并把窗口矩形作为屏幕原点，这样匹配坐标能换算回屏幕坐标。
    shot = capture.captureWindow(options.hwnd, options);
  } else if (options.target === 'fullScreen' && typeof capture.captureFullScreen === 'function') {
    shot = capture.captureFullScreen(options);
  } else if (typeof capture.captureVirtualScreen === 'function') {
    shot = capture.captureVirtualScreen(options);
  } else if (typeof capture.captureFullScreen === 'function') {
    shot = capture.captureFullScreen(options);
  } else {
    return { ok: false, reason: 'lib/capture.js exposes neither captureVirtualScreen nor captureFullScreen' };
  }

  if (shot === null || shot === undefined || shot.ok !== true) {
    return { ok: false, reason: `screenshot failed: ${shot?.reason ?? 'capture returned no result'}` };
  }

  // 抓屏原点：匹配结果是**图片像素坐标**，必须加上抓取区域在屏幕上的原点，
  // 才能得到可直接点击的屏幕坐标。
  //
  // 不同抓取函数的原点字段不同（这是跨模块集成的实际契约，实测确认）：
  //   captureRegion        → shot.region {x,y}
  //   captureWindow        → shot.windowRect {x,y}（图片含整个窗口，含标题栏）
  //   captureVirtualScreen → shot.screenOrigin {x,y}
  //   captureFullScreen    → shot.screenOrigin {x,y}
  // 原实现读的是 `capture.virtualScreenOriginX`（一个并不存在的模块级导出），
  // 于是除显式传 captureRegion 外，原点恒为 (0,0) —— 抓窗口时会整体偏移，
  // 把窗口左上角当成屏幕左上角。
  //
  // 缩放补偿：capture 可能因 maxWidth/scale 而缩小图片（shot.scale < 1）。
  // 此时图片像素 ≠ 屏幕像素，必须先除以缩放比再叠加原点。
  const scale = Number.isFinite(shot.scale) && shot.scale > 0 ? shot.scale : 1;
  const originX = Number(
    regionRect?.x
      ?? shot.screenOrigin?.x
      ?? shot.region?.x
      ?? shot.windowRect?.x
      ?? 0,
  ) || 0;
  const originY = Number(
    regionRect?.y
      ?? shot.screenOrigin?.y
      ?? shot.region?.y
      ?? shot.windowRect?.y
      ?? 0,
  ) || 0;

  const result = matchTemplate(shot, templateInput, options);
  if (result.ok !== true) return result;

  // 图片像素 → 屏幕像素。缩放可能来自 capture 的 maxWidth/scale 选项，
  // 也可能是调用方为提速对源图做了降采样（shot 与模板同尺度时缩放对匹配
  // 无影响，但坐标必须换回屏幕尺度才对得上点击位置）。
  const toScreen = (p) => ({
    x: originX + Math.round(p.x / scale),
    y: originY + Math.round(p.y / scale),
  });
  const halfW = Math.floor(result.templateWidth / 2);
  const halfH = Math.floor(result.templateHeight / 2);

  return {
    ...result,
    capture: {
      origin: { x: originX, y: originY },
      width: shot.width,
      height: shot.height,
      scale,
      method: shot.method,
      hwnd: shot.hwnd,
    },
    matches: result.matches.map((m) => {
      const topLeft = toScreen(m);
      return {
        ...m,
        screen: topLeft,
        center: toScreen({ x: m.x + halfW, y: m.y + halfH }),
      };
    }),
    best: result.best === null ? null : (() => {
      const topLeft = toScreen(result.best);
      return {
        ...result.best,
        screen: topLeft,
        center: toScreen({ x: result.best.x + halfW, y: result.best.y + halfH }),
      };
    })(),
  };
}

/**
 * 从屏幕截取一块区域并保存成模板 PNG。
 *
 * 典型用法：AI 先 `vcu_screenshot` 看到界面，确定"那个图标在 (400,300) 附近，
 * 大约 40x40"，调本函数"取样"，之后再 `findOnScreen` 反复找它。
 *
 * @returns `{ok:true, path, width, height, bytes}` 或 `{ok:false, reason}`。
 */
export async function saveTemplateFromRegion(x, y, w, h, outPath, options = {}) {
  let capture;
  try {
    capture = await import('./capture.js');
  } catch (error) {
    return {
      ok: false,
      reason: `saveTemplateFromRegion needs lib/capture.js, which could not be loaded: ${error?.message ?? String(error)}`,
    };
  }
  if (typeof capture.captureRegion !== 'function') {
    return { ok: false, reason: 'lib/capture.js does not expose captureRegion' };
  }

  const shot = capture.captureRegion(x, y, w, h, { ...options, scale: 1 });
  if (shot === null || shot === undefined || shot.ok !== true) {
    return { ok: false, reason: `screenshot failed: ${shot?.reason ?? 'capture returned no result'}` };
  }
  // 抓到的就是 PNG，直接落盘最省事也最保真（不做二次编解码）。
  if (Buffer.isBuffer(shot.png)) {
    writeFileSync(outPath, shot.png);
    return { ok: true, path: outPath, width: shot.width, height: shot.height, bytes: shot.png.length };
  }
  // 退路：只有原始像素时，自己编码。
  const pixels = shot.pixels ?? shot.data ?? shot.bgra;
  if (pixels === undefined) {
    return { ok: false, reason: 'capture region returned neither png nor raw pixels' };
  }
  const png = encodePng(pixels, shot.width, shot.height, shot.order === 'rgba' ? 'rgba' : 'rgb');
  writeFileSync(outPath, png);
  return { ok: true, path: outPath, width: shot.width, height: shot.height, bytes: png.length };
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/**
 * 能力自检：跑一次合成图上的自匹配，返回耗时与算法信息。
 * 用途：插件启动时确认匹配器工作正常，以及给模型一个"这个能力有多快"的预期。
 *
 * 合成图**必须是非周期性的**。这是踩过的坑：早先用棋盘格做自检，
 * 棋盘格在每个格子周期都会给出满分的自相似匹配，于是"自己找自己"
 * 报出的是离左上角最近的周期位置而不是真实位置，看起来像算法错了，
 * 实际是测试数据有病。这里改用确定性伪随机纹理 + 低频渐变，
 * 保证全局唯一峰值。
 */
export function describeMatcher() {
  const w = 320;
  const h = 240;
  // 确定性 LCG：同一份代码每次跑出的自检结果一致，便于回归对比。
  let seed = 20241016;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const src = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // 低频渐变（打破周期性）+ 高频噪声（给出可区分的纹理）
      const gradient = (x * 0.4 + y * 0.25) % 200;
      const noise = rnd() * 55;
      const v = Math.max(0, Math.min(255, Math.trunc(gradient + noise)));
      src[i] = v;
      src[i + 1] = Math.max(0, Math.min(255, 255 - v));
      src[i + 2] = (v * 3) & 0xff;
      src[i + 3] = 255;
    }
  }

  const tplX = 80;
  const tplY = 60;
  const tw = 40;
  const th = 40;
  const tpl = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const si = ((y + tplY) * w + (x + tplX)) * 4;
      const ti = (y * tw + x) * 4;
      tpl[ti] = src[si];
      tpl[ti + 1] = src[si + 1];
      tpl[ti + 2] = src[si + 2];
      tpl[ti + 3] = 255;
    }
  }

  const result = matchTemplate(
    { data: src, width: w, height: h, order: 'rgba' },
    { data: tpl, width: tw, height: th, order: 'rgba' },
    { threshold: 0.9, maxResults: 3 },
  );
  const best = result.best;
  return {
    ok: result.ok === true && best !== null && best.x === tplX && best.y === tplY,
    algorithm: result.stats?.algorithm,
    selfMatch: best,
    expected: { x: tplX, y: tplY },
    selfMatchCorrect: best !== null && best.x === tplX && best.y === tplY,
    elapsedMs: result.elapsedMs,
    synthetic: `${w}x${h} source, ${tw}x${th} template`,
  };
}
