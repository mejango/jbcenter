/** A small QR encoder (byte mode, error level M, versions 1–10, mask chosen by penalty) that renders
 * an SVG path. Enough for a short link; nothing else on the account pages needs a code. */
const BLOCKS_M: [number, number, number, number][] = [ // [blocks1, data1, blocks2, data2]
  [1, 16, 0, 0], [1, 28, 0, 0], [1, 44, 0, 0], [2, 32, 0, 0], [2, 43, 0, 0], [4, 27, 0, 0], [4, 31, 0, 0], [2, 38, 2, 39], [3, 36, 2, 37], [4, 43, 1, 44]];
const EC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const ALIGN: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
const mul = (a: number, b: number) => a && b ? EXP[LOG[a]! + LOG[b]!]! : 0;
function generator(count: number) {
  let poly = [1];
  for (let i = 0; i < count; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) { next[j] = (next[j] ?? 0) ^ poly[j]!; next[j + 1] = (next[j + 1] ?? 0) ^ mul(poly[j]!, EXP[i]!); }
    poly = next;
  }
  return poly;
}
function ecc(data: number[], count: number) {
  const poly = generator(count), out = new Array<number>(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ out.shift()!; out.push(0);
    if (factor) for (let j = 0; j < poly.length - 1; j++) out[j] = (out[j] ?? 0) ^ mul(poly[j + 1]!, factor);
  }
  return out;
}
function formatBits(mask: number) {
  const data = (0b00 << 3) | mask; // level M = 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
function versionBits(version: number) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
  return (version << 12) | rem;
}
export function qrModules(text: string, forcedMask?: number): { size: number; dark: (x: number, y: number) => boolean; version: number; mask: number } {
  const bytes = new TextEncoder().encode(text);
  let version = -1;
  for (let v = 0; v < 10; v++) {
    const [b1, d1, b2, d2] = BLOCKS_M[v]!, capacityBits = (b1 * d1 + b2 * d2) * 8, needed = 4 + (v >= 9 ? 16 : 8) + bytes.length * 8;
    if (needed <= capacityBits) { version = v; break; }
  }
  if (version < 0) throw new Error('Too long for this QR encoder.');
  const [b1, d1, b2, d2] = BLOCKS_M[version]!, capacity = b1 * d1 + b2 * d2;
  const bits: number[] = [];
  const push = (value: number, count: number) => { for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1); };
  push(0b0100, 4); push(bytes.length, version >= 9 ? 16 : 8);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  for (let pad = 0; data.length < capacity; pad++) data.push(pad % 2 ? 0x11 : 0xec);
  const blocks: number[][] = [], eccs: number[][] = [];
  let offset = 0;
  for (let b = 0; b < b1 + b2; b++) {
    const length = b < b1 ? d1 : d2, block = data.slice(offset, offset + length); offset += length;
    blocks.push(block); eccs.push(ecc(block, EC_PER_BLOCK[version]!));
  }
  const codewords: number[] = [];
  const longest = Math.max(d1, d2 || 0);
  for (let i = 0; i < longest; i++) for (const block of blocks) if (i < block.length) codewords.push(block[i]!);
  for (let i = 0; i < EC_PER_BLOCK[version]!; i++) for (const block of eccs) codewords.push(block[i]!);
  const size = 21 + version * 4, grid = new Uint8Array(size * size), reserved = new Uint8Array(size * size);
  const set = (x: number, y: number, dark: boolean, reserve = true) => { grid[y * size + x] = dark ? 1 : 0; if (reserve) reserved[y * size + x] = 1; };
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy)); set(x, y, d <= 3 && d !== 2);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  for (let i = 8; i < size - 8; i++) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0); }
  for (const cy of ALIGN[version]!) for (const cx of ALIGN[version]!) {
    // Alignment patterns skip only the three finder corners; they do overlay the timing patterns.
    if ((cx <= 8 && cy <= 8) || (cx >= size - 9 && cy <= 8) || (cx <= 8 && cy >= size - 9)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  for (let i = 0; i < 8; i++) { reserved[8 * size + i] = 1; reserved[i * size + 8] = 1; reserved[8 * size + size - 1 - i] = 1; reserved[(size - 1 - i) * size + 8] = 1; }
  reserved[8 * size + 8] = 1; set(8, size - 8, true);
  if (version >= 6) for (let i = 0; i < 18; i++) { reserved[Math.floor(i / 3) * size + size - 11 + (i % 3)] = 1; reserved[(size - 11 + (i % 3)) * size + Math.floor(i / 3)] = 1; }
  // Data placement in the zigzag order.
  let index = 0, upward = true;
  const bitAt = (i: number) => (codewords[i >> 3]! >> (7 - (i & 7))) & 1;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right--;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (reserved[y * size + x]) continue;
        grid[y * size + x] = index < codewords.length * 8 ? bitAt(index) : 0; index++;
      }
    }
    upward = !upward;
  }
  const masks: ((x: number, y: number) => boolean)[] = [(x, y) => (x + y) % 2 === 0, (_x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0];
  const apply = (mask: number) => {
    const out = new Uint8Array(grid);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!reserved[y * size + x] && masks[mask]!(x, y)) out[y * size + x] = (out[y * size + x] ?? 0) ^ 1;
    const format = formatBits(mask);
    const bit = (i: number) => (format >> i) & 1;
    const put = (x: number, y: number, value: number) => { out[y * size + x] = value; };
    // First copy around the top-left finder, second copy split between the other two.
    for (let i = 0; i <= 5; i++) put(8, i, bit(i));
    put(8, 7, bit(6)); put(8, 8, bit(7)); put(7, 8, bit(8));
    for (let i = 9; i <= 14; i++) put(14 - i, 8, bit(i));
    for (let i = 0; i <= 7; i++) put(size - 1 - i, 8, bit(i));
    for (let i = 8; i <= 14; i++) put(8, size - 15 + i, bit(i));
    put(8, size - 8, 1);
    if (version >= 6) { const v = versionBits(version + 1); for (let i = 0; i < 18; i++) { const b = (v >> i) & 1; out[Math.floor(i / 3) * size + size - 11 + (i % 3)] = b; out[(size - 11 + (i % 3)) * size + Math.floor(i / 3)] = b; } }
    return out;
  };
  const penalty = (m: Uint8Array) => {
    let score = 0;
    for (let y = 0; y < size; y++) for (let x = 0, run = 0, last = -1; x < size; x++) { const v = m[y * size + x]!; if (v === last) { if (++run === 5) score += 3; else if (run > 5) score++; } else { last = v; run = 1; } }
    for (let x = 0; x < size; x++) for (let y = 0, run = 0, last = -1; y < size; y++) { const v = m[y * size + x]!; if (v === last) { if (++run === 5) score += 3; else if (run > 5) score++; } else { last = v; run = 1; } }
    let dark = 0; for (const v of m) dark += v;
    score += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
    return score;
  };
  let best = apply(forcedMask ?? 0), bestScore = penalty(best), chosen = forcedMask ?? 0;
  if (forcedMask === undefined) for (let mask = 1; mask < 8; mask++) { const candidate = apply(mask), score = penalty(candidate); if (score < bestScore) { best = candidate; bestScore = score; chosen = mask; } }
  return { size, dark: (x, y) => best[y * size + x] === 1, version: version + 1, mask: chosen };
}
/** An SVG the page can inline; the quiet zone is part of the viewBox. */
export function qrSvg(text: string, label: string): string {
  const { size, dark } = qrModules(text), quiet = 4;
  let path = '';
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (dark(x, y)) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  const box = size + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}" role="img" aria-label="${label.replaceAll('"', '&quot;')}" shape-rendering="crispEdges"><rect width="${box}" height="${box}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
