// Generates assets/icon.png — a 256x256 app icon: a rounded magenta square with a
// white ">_" prompt glyph. No image libraries: raw RGBA -> zlib -> PNG chunks.
import { deflateSync } from 'zlib';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const SIZE = 256;
const BG = [193, 68, 126]; // #C1447E magenta
const FG = [255, 255, 255];
const RADIUS = 52;

// distance from point (px,py) to segment (ax,ay)-(bx,by)
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// rounded-rect membership with anti-alias-ish edge
function inRoundedRect(x, y, w, h, r) {
  const rx = Math.min(Math.max(x, r), w - r);
  const ry = Math.min(Math.max(y, r), h - r);
  return Math.hypot(x - rx, y - ry) <= r;
}

function pixel(x, y) {
  // background rounded square (transparent outside)
  if (!inRoundedRect(x + 0.5, y + 0.5, SIZE, SIZE, RADIUS)) return [0, 0, 0, 0];
  // chevron ">": two thick strokes
  const strokeW = 15;
  const dChevron = Math.min(
    distToSeg(x, y, 92, 78, 156, 128),
    distToSeg(x, y, 156, 128, 92, 178),
  );
  // underscore "_"
  const inUnderscore = x >= 92 && x <= 176 && y >= 190 && y <= 206;
  if (dChevron <= strokeW || inUnderscore) return [...FG, 255];
  return [...BG, 255];
}

// Build raw scanlines: each row prefixed with filter byte 0.
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b, a] = pixel(x, y);
    raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
  }
}

// --- PNG assembly ---
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const idat = deflateSync(raw, { level: 9 });
const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, 'icon.png');
writeFileSync(outPath, png);
console.log(`Wrote ${outPath} (${png.length} bytes, ${SIZE}x${SIZE})`);
