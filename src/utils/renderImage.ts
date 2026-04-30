import * as zlib from "zlib";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ASCII characters from dark to light
const ASCII_CHARS = " .'`^\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";

/**
 * Render a base64-encoded PNG image as ASCII art in the terminal.
 * Works on Linux, macOS, and Windows (cmd/PowerShell).
 * Also writes a temp PNG for fallback viewing.
 */
export async function renderBase64Image(base64: string): Promise<string> {
  const buf = Buffer.from(base64, "base64");
  const { width, height, pixels } = parsePNG(buf);

  // Write temp PNG for fallback
  const tmpPath = path.join(os.tmpdir(), `llm_cli_qr_${Date.now()}.png`);
  fs.writeFileSync(tmpPath, buf);

  // Determine target width (chars are taller than wide, ratio ~0.6)
  const termWidth = process.stdout.columns || 80;
  const targetWidth = Math.max(Math.min(termWidth - 2, 120), 40);
  const aspectRatio = 0.6; // char width / char height
  const targetHeight = Math.max(Math.round(targetWidth / width * height * aspectRatio), 1);

  // Scale image
  const scaled = nearestNeighbor(pixels, width, height, targetWidth, targetHeight, 4);

  // Convert to ASCII
  const lines: string[] = [];
  for (let y = 0; y < targetHeight; y++) {
    let line = "";
    for (let x = 0; x < targetWidth; x++) {
      const idx = (y * targetWidth + x) * 4;
      const r = clamp(scaled[idx]);
      const g = clamp(scaled[idx + 1]);
      const b = clamp(scaled[idx + 2]);
      // Brightness (luminance)
      const brightness = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      // Map brightness to character
      const charIdx = Math.floor((1 - brightness / 255) * (ASCII_CHARS.length - 1));
      line += ASCII_CHARS[charIdx];
    }
    lines.push(line);
  }

  console.log("\n" + lines.join("\n") + "\n");
  console.log(`  Or open this file in a browser/image viewer: ${tmpPath}\n`);

  return tmpPath;
}

function clamp(v: number): number {
  return Math.max(0, Math.min(255, v | 0));
}

function parsePNG(buffer: Buffer): {
  width: number;
  height: number;
  pixels: Uint8Array;
} {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== sig[i]) throw new Error("Invalid PNG signature");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (offset < buffer.length - 8) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;

    if (type === "IHDR") {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      colorType = buffer[dataStart + 9];
    } else if (type === "IDAT") {
      idatChunks.push(buffer.slice(dataStart, dataStart + length));
    } else if (type === "IEND") {
      break;
    }

    offset = dataStart + length + 4;
  }

  if (idatChunks.length === 0) throw new Error("No IDAT data in PNG");

  const idatData = Buffer.concat(idatChunks);
  const decompressed = zlib.inflateSync(idatData);

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`Unsupported PNG color type: ${colorType}`);

  const raw = unfilter(decompressed, width, height, channels);
  const rgba = toRGBA(raw, width, height, channels);

  return { width, height, pixels: rgba };
}

function unfilter(data: Uint8Array, w: number, h: number, ch: number): Uint8Array {
  const rowBytes = w * ch + 1;
  const out = new Uint8Array(w * h * ch);

  for (let y = 0; y < h; y++) {
    const off = y * rowBytes;
    const filterType = data[off];
    const src = data.slice(off + 1, off + rowBytes);
    const dest = out.subarray(y * w * ch);
    const prev = y > 0 ? out.subarray((y - 1) * w * ch) : new Uint8Array(w * ch);

    switch (filterType) {
      case 0:
        dest.set(src);
        break;
      case 1:
        for (let i = 0; i < src.length; i++) {
          dest[i] = (src[i] + (i >= ch ? dest[i - ch] : 0)) & 0xff;
        }
        break;
      case 2:
        for (let i = 0; i < src.length; i++) {
          dest[i] = (src[i] + prev[i]) & 0xff;
        }
        break;
      case 3:
        for (let i = 0; i < src.length; i++) {
          dest[i] = (src[i] + ((i >= ch ? dest[i - ch] : 0) + prev[i]) / 2 | 0) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < src.length; i++) {
          const a = i >= ch ? dest[i - ch] : 0;
          const b = prev[i];
          const c = i >= ch ? prev[i - ch] : 0;
          dest[i] = (src[i] + paeth(a, b, c)) & 0xff;
        }
        break;
    }
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function toRGBA(raw: Uint8Array, w: number, h: number, ch: number): Uint8Array {
  if (ch === 4) return raw;
  const out = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += 3) {
    out[i * 4] = raw[j];
    out[i * 4 + 1] = raw[j + 1];
    out[i * 4 + 2] = raw[j + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

function nearestNeighbor(src: Uint8Array, sw: number, sh: number, dw: number, dh: number, ch: number): Uint8Array {
  const out = new Uint8Array(dw * dh * ch);
  const xScale = sw / dw;
  const yScale = sh / dh;
  for (let dy = 0; dy < dh; dy++) {
    const sy = Math.min((dy * yScale) | 0, sh - 1);
    for (let dx = 0; dx < dw; dx++) {
      const sx = Math.min((dx * xScale) | 0, sw - 1);
      const si = (sy * sw + sx) * ch;
      const di = (dy * dw + dx) * ch;
      for (let c = 0; c < ch; c++) out[di + c] = src[si + c];
    }
  }
  return out;
}
