// Generates assets/icon.ico (multi-size, PNG-compressed entries) from the same design
// as icon.png — a rounded magenta square with a white ">_" prompt. Windows shortcuts
// need an .ico; this packs 16/32/48/64/128/256 so it renders crisply at any size.
import { deflateSync } from 'zlib';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const BG = [193, 68, 126];
const FG = [255, 255, 255];

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function inRoundedRect(x, y, w, h, r) {
  const rx = Math.min(Math.max(x, r), w - r);
  const ry = Math.min(Math.max(y, r), h - r);
  return Math.hypot(x - rx, y - ry) <= r;
}

/** Raw RGBA for the icon at a given size (design scaled from the 256px reference). */
function pixel(x, y, size) {
  const s = size / 256;
  if (!inRoundedRect(x + 0.5, y + 0.5, size, size, 52 * s)) return [0, 0, 0, 0];
  const strokeW = 15 * s;
  const dChevron = Math.min(
    distToSeg(x, y, 92 * s, 78 * s, 156 * s, 128 * s),
    distToSeg(x, y, 156 * s, 128 * s, 92 * s, 178 * s),
  );
  const inUnderscore = x >= 92 * s && x <= 176 * s && y >= 190 * s && y <= 206 * s;
  if (dChevron <= strokeW || inUnderscore) return [...FG, 255];
  return [...BG, 255];
}

// --- PNG encoder ---
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function makePng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) { raw[o++] = 0; for (let x = 0; x < size; x++) { const [r, g, b, a] = pixel(x, y, size); raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a; } }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

// --- ICO container (each entry stores a PNG) ---
const sizes = [16, 32, 48, 64, 128, 256];
const pngs = sizes.map(makePng);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = [];
sizes.forEach((size, i) => {
  const e = Buffer.alloc(16);
  e[0] = size >= 256 ? 0 : size; // 0 means 256
  e[1] = size >= 256 ? 0 : size;
  e[2] = 0; e[3] = 0;
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  entries.push(e);
});
const ico = Buffer.concat([header, ...entries, ...pngs]);

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, 'icon.ico');
writeFileSync(outPath, ico);
console.log(`Wrote ${outPath} (${ico.length} bytes, sizes ${sizes.join('/')})`);
