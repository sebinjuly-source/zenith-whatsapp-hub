// Draws the app icon (green rounded square with a white chat bubble) as PNGs, no extra packages.
const fs = require('fs');
const zlib = require('zlib');
function png(size, file) {
  const px = Buffer.alloc(size * size * 4);
  const R = size * 0.22; // corner radius
  const set = (x, y, [r, g, b, a]) => { const i = (y * size + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a; };
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, R), size - R), cy = Math.min(Math.max(y, R), size - R);
    return (x - cx) ** 2 + (y - cy) ** 2 <= R * R;
  };
  const c = size / 2, br = size * 0.29;
  const inBubble = (x, y) => {
    if ((x - c) ** 2 + (y - c * 0.96) ** 2 <= br * br) return true;
    // tail at bottom-left
    const tx = x - (c - br * 0.75), ty = y - (c + br * 0.55);
    return tx >= -br * 0.05 && ty >= 0 && ty <= br * 0.55 && tx <= br * 0.5 - ty * 0.9;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (!inRounded(x + 0.5, y + 0.5)) set(x, y, [0, 0, 0, 0]);
    else if (inBubble(x + 0.5, y + 0.5)) set(x, y, [255, 255, 255, 255]);
    else set(x, y, [31, 122, 85, 255]);
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
function crc32(buf) { let c, crc = 0xffffffff; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return crc ^ 0xffffffff; }
for (const s of [180, 192, 512]) png(s, `public/icon-${s}.png`);
console.log('icons written');
