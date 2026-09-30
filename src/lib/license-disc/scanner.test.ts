import { describe, it } from 'node:test';
import assert from 'node:assert';
import QRCode from 'qrcode';
// ZXing's own PDF417 codeword/bar-pattern tables, used only to BUILD test images below.
import PDF417Common from '@zxing/library/cjs/core/pdf417/PDF417Common';
import {
  computeDecodeScales,
  decodePdf417FromImageData,
  decodePdf417FromLuminance,
  isNativePdf417Supported,
  rgbaToLuminance,
  rotateLuminance90,
  scanPdf417
} from './scanner';
import { parseSouthAfricanLicenseDisc } from './parser';

// ---------------------------------------------------------------------------
// Test fixtures: a minimal PDF417 *encoder* (byte compaction, EC level 2) and a QR renderer.
// They generate input images; the code under test is the production decoder in ./scanner.
// ---------------------------------------------------------------------------

const GF = 929;
const START_PATTERN = 0x1fea8; // 17 modules
const STOP_PATTERN = 0x3fa29; // 18 modules

/** codeword → 17-module bar pattern for clusters 0, 3, 6 (derived from ZXing's decode tables). */
const PATTERNS: number[][] = (() => {
  const tables: number[][] = [new Array(GF), new Array(GF), new Array(GF)];
  // CODEWORD_TABLE is declared private in ZXing's typings but is a plain static at runtime.
  const common = PDF417Common as unknown as { SYMBOL_TABLE: Int32Array; CODEWORD_TABLE: Int32Array };
  const symbols = common.SYMBOL_TABLE;
  const codewords = common.CODEWORD_TABLE;
  for (let i = 0; i < symbols.length; i++) {
    const v = codewords[i] - 1;
    tables[Math.floor(v / GF)][v % GF] = symbols[i];
  }
  return tables;
})();

function ecCodewords(data: number[], level: number): number[] {
  const k = 2 ** (level + 1);
  // Generator g(x) = Π (x − 3^i), i = 1..k over GF(929); coefficients ascending, leading 1 dropped.
  let g = [1];
  let root = 1;
  for (let i = 1; i <= k; i++) {
    root = (root * 3) % GF;
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j + 1] = (next[j + 1] + g[j]) % GF;
      next[j] = (next[j] + g[j] * (GF - root)) % GF;
    }
    g = next;
  }
  const coeff = g.slice(0, k);
  const e = new Array(k).fill(0);
  for (const d of data) {
    const t1 = (d + e[k - 1]) % GF;
    for (let j = k - 1; j >= 1; j--) e[j] = (e[j - 1] + GF - ((t1 * coeff[j]) % GF)) % GF;
    e[0] = (GF - ((t1 * coeff[0]) % GF)) % GF;
  }
  return e.reverse().map((x) => (x !== 0 ? GF - x : 0));
}

function byteCompaction(bytes: number[]): number[] {
  // 924 when the byte count is a multiple of 6, else 901 (last partial group one byte per codeword)
  const out = [bytes.length % 6 === 0 ? 924 : 901];
  const b256 = BigInt(256);
  const b900 = BigInt(900);
  let i = 0;
  for (; i + 6 <= bytes.length; i += 6) {
    let value = BigInt(0);
    for (let j = 0; j < 6; j++) value = value * b256 + BigInt(bytes[i + j]);
    const group: number[] = [];
    for (let j = 0; j < 5; j++) {
      group.unshift(Number(value % b900));
      value /= b900;
    }
    out.push(...group);
  }
  for (; i < bytes.length; i++) out.push(bytes[i]);
  return out;
}

function renderPdf417(text: string, columns = 6, level = 2, moduleWidth = 3, rowHeight = 9, quiet = 12) {
  const payload = byteCompaction(Array.from(new TextEncoder().encode(text)));
  const ecCount = 2 ** (level + 1);
  const rows = Math.max(3, Math.ceil((payload.length + 1 + ecCount) / columns));
  const dataCount = rows * columns - ecCount;
  const data = [dataCount, ...payload];
  while (data.length < dataCount) data.push(900); // pad
  const all = [...data, ...ecCodewords(data, level)];

  const bits: number[][] = [];
  for (let y = 0; y < rows; y++) {
    const cluster = y % 3;
    const base = 30 * Math.floor(y / 3);
    const rInfo = Math.floor((rows - 1) / 3);
    const lInfo = level * 3 + ((rows - 1) % 3);
    const left = cluster === 0 ? base + rInfo : cluster === 1 ? base + lInfo : base + columns - 1;
    const right = cluster === 0 ? base + columns - 1 : cluster === 1 ? base + rInfo : base + lInfo;
    const row: number[] = [];
    const put = (pattern: number, len: number) => {
      for (let b = len - 1; b >= 0; b--) row.push((pattern >> b) & 1);
    };
    put(START_PATTERN, 17);
    put(PATTERNS[cluster][left], 17);
    for (let x = 0; x < columns; x++) put(PATTERNS[cluster][all[y * columns + x]], 17);
    put(PATTERNS[cluster][right], 17);
    put(STOP_PATTERN, 18);
    bits.push(row);
  }

  const width = bits[0].length * moduleWidth + quiet * 2;
  const height = rows * rowHeight + quiet * 2;
  const data8 = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < bits[y].length; x++) {
      if (!bits[y][x]) continue;
      for (let dy = 0; dy < rowHeight; dy++) {
        for (let dx = 0; dx < moduleWidth; dx++) {
          const o = ((quiet + y * rowHeight + dy) * width + quiet + x * moduleWidth + dx) * 4;
          data8[o] = data8[o + 1] = data8[o + 2] = 0;
        }
      }
    }
  }
  return { data: data8, width, height };
}

function renderQr(text: string, scale = 6, quiet = 4) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const dim = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!qr.modules.get(y, x)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const o = (((y + quiet) * scale + dy) * dim + (x + quiet) * scale + dx) * 4;
          data[o] = data[o + 1] = data[o + 2] = 0;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

/** Test fixture: rotates an RGBA image 90° clockwise (a phone held sideways). */
function rotateRgba90(img: { data: Uint8ClampedArray; width: number; height: number }) {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      const dst = (x * h + (h - 1 - y)) * 4;
      out[dst] = data[src];
      out[dst + 1] = data[src + 1];
      out[dst + 2] = data[src + 2];
      out[dst + 3] = data[src + 3];
    }
  }
  return { data: out, width: h, height: w };
}

/** Minimal canvas stand-in exposing getImageData (the only API the ZXing path uses). */
function fakeCanvas(img: { data: Uint8ClampedArray; width: number; height: number }) {
  return {
    width: img.width,
    height: img.height,
    getContext: () => ({ getImageData: () => ({ data: img.data, width: img.width, height: img.height }) })
  } as unknown as HTMLCanvasElement;
}

const DISC =
  '%MVL1CC61%0164%4025T0HR%1%4025001C2GTP%CJZ297GP%JYJ128C%Sedan (closed top)%TOYOTA%COROLLA%White%AHTBB3QE300012345%2ZR1234567%2019-11-30%';

describe('PDF417 decoder (production ZXing path)', () => {
  it('decodes a synthetic PDF417 licence-disc barcode end-to-end into the parser', () => {
    const img = renderPdf417(DISC);
    const text = decodePdf417FromImageData(img);
    assert.strictEqual(text, DISC);
    const disc = parseSouthAfricanLicenseDisc(text!, { today: '2026-09-30' });
    assert.strictEqual(disc?.plate, 'CJZ297GP');
    assert.strictEqual(disc?.vin, 'AHTBB3QE300012345');
    assert.strictEqual(disc?.isExpired, true);
  });

  it('scanPdf417 uses ZXing on the canvas buffer when there is no native detector', async () => {
    assert.strictEqual(await isNativePdf417Supported(), false);
    const canvas = fakeCanvas(renderPdf417(DISC));
    assert.strictEqual(await scanPdf417(canvas, canvas), DISC);
  });

  it('decodes a disc photographed sideways: 90°, 180° and 270° (review reproduction)', () => {
    const r0 = renderPdf417(DISC);
    const r90 = rotateRgba90(r0);
    const r180 = rotateRgba90(r90);
    const r270 = rotateRgba90(r180);
    for (const [name, img] of [['0', r0], ['90', r90], ['180', r180], ['270', r270]] as const) {
      assert.strictEqual(decodePdf417FromImageData(img), DISC, `${name}°`);
    }
    // Restricting to the captured orientation reproduces ZXing's own limitation.
    assert.strictEqual(decodePdf417FromImageData(r90, 0), null);
    assert.strictEqual(decodePdf417FromImageData(r90, 90), DISC);
  });

  it('live frames alternate 0°/90° per canvas, so a sideways disc is found by the second frame', async () => {
    const canvas = fakeCanvas(rotateRgba90(renderPdf417(DISC)));
    assert.strictEqual(await scanPdf417(canvas, canvas), null, 'frame 1: upright pass only');
    assert.strictEqual(await scanPdf417(canvas, canvas), DISC, 'frame 2: rotated pass');
    // Photos (orientation 'both') find it on the first call.
    const photo = fakeCanvas(rotateRgba90(renderPdf417(DISC)));
    assert.strictEqual(await scanPdf417(photo, photo, { orientation: 'both' }), DISC);
  });

  it('ignores QR codes in frame (hints restricted to PDF_417; audit reproduction)', async () => {
    for (const payload of ['PLAAS-CP:cp-main-gate', 'EE-CP-MAIN-GATE-01', 'https://example.org/some/long/url?x=1']) {
      const img = renderQr(payload);
      assert.strictEqual(decodePdf417FromImageData(img), null, payload);
      assert.strictEqual(await scanPdf417(fakeCanvas(img), fakeCanvas(img)), null, payload);
    }
  });

  it('returns null for blank and noisy frames', () => {
    const w = 320;
    const h = 200;
    const blank = new Uint8ClampedArray(w * h).fill(255);
    assert.strictEqual(decodePdf417FromLuminance(blank, w, h), null);
    const noise = new Uint8ClampedArray(w * h);
    let s = 7;
    for (let i = 0; i < noise.length; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      noise[i] = (s >>> 16) & 0xff;
    }
    assert.strictEqual(decodePdf417FromLuminance(noise, w, h), null);
    assert.strictEqual(decodePdf417FromImageData({ data: new Uint8ClampedArray(0), width: 0, height: 0 }), null);
  });
});

describe('native BarcodeDetector capability check', () => {
  const g = globalThis as unknown as { BarcodeDetector?: unknown };
  async function withDetector(detector: unknown, fn: () => Promise<void>) {
    const had = 'BarcodeDetector' in g;
    const prev = g.BarcodeDetector;
    g.BarcodeDetector = detector;
    try {
      await fn();
    } finally {
      if (had) g.BarcodeDetector = prev;
      else delete g.BarcodeDetector;
    }
  }

  it('is supported only when getSupportedFormats() lists pdf417', async () => {
    class WithPdf417 {
      static getSupportedFormats = async () => ['qr_code', 'pdf417'];
    }
    class QrOnly {
      static getSupportedFormats = async () => ['qr_code', 'ean_13'];
    }
    class NoFormatsApi {}
    class Throwing {
      static getSupportedFormats = async () => {
        throw new Error('unavailable');
      };
    }
    await withDetector(WithPdf417, async () => assert.strictEqual(await isNativePdf417Supported(), true));
    await withDetector(QrOnly, async () => assert.strictEqual(await isNativePdf417Supported(), false));
    await withDetector(NoFormatsApi, async () => assert.strictEqual(await isNativePdf417Supported(), false));
    await withDetector(Throwing, async () => assert.strictEqual(await isNativePdf417Supported(), false));
  });
});

describe('scanner helpers', () => {
  it('rotates a luminance buffer 90° clockwise', () => {
    // 3×2 image:  1 2 3      rotated (2×3):  4 1
    //             4 5 6                      5 2
    //                                        6 3
    const rotated = rotateLuminance90(new Uint8ClampedArray([1, 2, 3, 4, 5, 6]), 3, 2);
    assert.deepStrictEqual(Array.from(rotated), [4, 1, 5, 2, 6, 3]);
    assert.throws(() => rotateLuminance90(new Uint8ClampedArray(2), 3, 2), RangeError);
  });

  it('converts RGBA to luminance', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
    assert.deepStrictEqual(Array.from(rgbaToLuminance(rgba, 3, 1)), [255, 0, (255 * 306) >> 10]);
    assert.throws(() => rgbaToLuminance(new Uint8ClampedArray(4), 2, 1), RangeError);
  });

  it('uses the reference 2000/1400/2800 ladder and skips duplicate sizes', () => {
    assert.deepStrictEqual(computeDecodeScales(4000, 3000), [
      { width: 2000, height: 1500 },
      { width: 1400, height: 1050 },
      { width: 2800, height: 2100 }
    ]);
    // 1600 px photo: 2000 and 2800 would both be the original size → tried once.
    assert.deepStrictEqual(computeDecodeScales(1600, 1200), [
      { width: 1600, height: 1200 },
      { width: 1400, height: 1050 }
    ]);
    assert.deepStrictEqual(computeDecodeScales(900, 600), [{ width: 900, height: 600 }]);
    assert.deepStrictEqual(computeDecodeScales(0, 600), []);
  });
});
