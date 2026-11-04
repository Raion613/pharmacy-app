// QR コード（JIS X 0510 / ISO/IEC 18004）を作る。電子版お薬手帳のデータ（JAHIS 形式）を載せるためだけの最小限：
// 8ビットバイトモード、誤り訂正レベル M、型番は入る中で最小のもの（1〜40）。
// 返すのは真偽値の2次元配列（true が黒）。手順は規格のとおり：データのビット列 → リード・ソロモン符号 → 配置 → マスク選択。

// 誤り訂正レベル M の、型番ごとの [1ブロックの誤り訂正コード語数, [ブロック数, データコード語数], ...]
const BLOCKS_M = [null,
  [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]], [16, [4, 27]], [18, [4, 31]],
  [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]], [30, [1, 50], [4, 51]], [22, [6, 36], [2, 37]],
  [22, [8, 37], [1, 38]], [24, [4, 40], [5, 41]], [24, [5, 41], [5, 42]], [28, [7, 45], [3, 46]], [28, [10, 46], [1, 47]],
  [26, [9, 43], [4, 44]], [26, [3, 44], [11, 45]], [26, [3, 41], [13, 42]], [26, [17, 42]], [28, [17, 46]], [28, [4, 47], [14, 48]],
  [28, [6, 45], [14, 46]], [28, [8, 47], [13, 48]], [28, [19, 46], [4, 47]], [28, [22, 45], [3, 46]], [28, [3, 45], [23, 46]],
  [28, [21, 45], [7, 46]], [28, [19, 47], [10, 48]], [28, [2, 46], [29, 47]], [28, [10, 46], [23, 47]], [28, [14, 46], [21, 47]],
  [28, [14, 46], [23, 47]], [28, [12, 47], [26, 48]], [28, [6, 47], [34, 48]], [28, [29, 46], [14, 47]], [28, [13, 46], [32, 47]],
  [28, [40, 47], [7, 48]], [28, [18, 47], [31, 48]],
];
const ECL_M_BITS = 0b00;

export function encodeQr(bytes) {
  const version = pickVersion(bytes.length);
  const codewords = addErrorCorrection(dataCodewords(bytes, version), version);
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => Array(size).fill(false)); // 機能パターン（マスクしない）
  drawFunctionPatterns(m, fixed, version);
  drawCodewords(m, fixed, codewords);
  // 8種類のマスクを全部試し、失点がいちばん小さいものを選ぶ
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const t = m.map((row) => row.slice());
    applyMask(t, fixed, mask);
    drawFormatBits(t, fixed, mask);
    const score = penalty(t);
    if (best === null || score < best.score) best = { score, matrix: t };
  }
  return best.matrix;
}

// 総コード語数（データ＋誤り訂正）。型番の大きさから機能パターンの分を引いたもの
function rawCodewords(ver) {
  let modules = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    modules -= (25 * n - 10) * n - 55;
    if (ver >= 7) modules -= 36;
  }
  return Math.floor(modules / 8);
}

function dataCapacity(ver) {
  const [, ...groups] = BLOCKS_M[ver];
  return groups.reduce((s, [n, d]) => s + n * d, 0);
}

function pickVersion(length) {
  for (let v = 1; v <= 40; v++) {
    const countBits = v <= 9 ? 8 : 16;
    if (4 + countBits + length * 8 <= dataCapacity(v) * 8) return v;
  }
  throw new RangeError(`QR コード1つに入りません（${length}バイト）`);
}

function dataCodewords(bytes, version) {
  const bits = [];
  const put = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4); // バイトモード
  put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCapacity(version) * 8;
  put(0, Math.min(4, capacity - bits.length)); // 終端
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < capacity / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

// ブロックに分けてリード・ソロモン符号を付け、規格の順に交互に並べる
function addErrorCorrection(data, version) {
  const [ecLen, ...groups] = BLOCKS_M[version];
  const blocks = [];
  let k = 0;
  for (const [n, d] of groups) for (let i = 0; i < n; i++) { blocks.push(data.slice(k, k + d)); k += d; }
  const gen = rsGenerator(ecLen);
  const ecs = blocks.map((b) => rsRemainder(b, gen));
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const e of ecs) out.push(e[i]);
  if (out.length !== rawCodewords(version)) throw new Error(`型番 ${version} のコード語数が合いません`);
  return out;
}

// GF(2^8)、原始多項式 x^8 + x^4 + x^3 + x^2 + 1（0x11D）
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsGenerator(degree) {
  let poly = Array(degree - 1).fill(0).concat([1]);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < poly.length; j++) {
      poly[j] = gfMul(poly[j], root);
      if (j + 1 < poly.length) poly[j] ^= poly[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return poly;
}

function rsRemainder(data, gen) {
  const result = gen.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    gen.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

function drawFunctionPatterns(m, fixed, version) {
  const size = m.length;
  const set = (x, y, dark) => { m[y][x] = dark; fixed[y][x] = true; };
  // タイミングパターン
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // 位置検出パターン（3隅）と分離パターン
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  }
  // 位置合わせパターン
  const pos = alignmentPositions(version);
  for (const y of pos) for (const x of pos) {
    if ((x === 6 && y === 6) || (x === 6 && y === size - 7) || (x === size - 7 && y === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // 形式情報の場所を先に確保する（中身はマスクを決めてから書く）
  drawFormatBits(m, fixed, 0);
  // 型番情報（7以上）
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
}

function alignmentPositions(version) {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const n = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (n * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < n; pos -= step) result.splice(1, 0, pos);
  return result;
}

function drawFormatBits(m, fixed, mask) {
  const size = m.length;
  const data = (ECL_M_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const set = (x, y, i) => { m[y][x] = ((bits >>> i) & 1) === 1; fixed[y][x] = true; };
  for (let i = 0; i <= 5; i++) set(8, i, i);
  set(8, 7, 6);
  set(8, 8, 7);
  set(7, 8, 8);
  for (let i = 9; i < 15; i++) set(14 - i, 8, i);
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, i);
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, i);
  m[size - 8][8] = true; // 常に黒のモジュール
  fixed[size - 8][8] = true;
}

// 右下から2列ずつ、上下にジグザグに置く
function drawCodewords(m, fixed, codewords) {
  const size = m.length;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fixed[y][x] && i < codewords.length * 8) {
          m[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

function applyMask(m, fixed, mask) {
  const f = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ][mask];
  for (let y = 0; y < m.length; y++) for (let x = 0; x < m.length; x++) if (!fixed[y][x] && f(x, y)) m[y][x] = !m[y][x];
}

// マスクの失点（規格の4つの規則）
function penalty(m) {
  const size = m.length;
  let score = 0;
  const lines = [];
  for (let i = 0; i < size; i++) { lines.push(m[i]); lines.push(m.map((row) => row[i])); }
  for (const line of lines) {
    // 規則1：同じ色が5つ以上続く
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    // 規則3：1:1:3:1:1 の並び（前後に4つの白）
    for (let i = 0; i + 11 <= size; i++) {
      const s = line.slice(i, i + 11).map((d) => (d ? 1 : 0)).join("");
      if (s === "10111010000" || s === "00001011101") score += 40;
    }
  }
  // 規則2：2×2 の同じ色
  for (let y = 0; y + 1 < size; y++) for (let x = 0; x + 1 < size; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
  }
  // 規則4：黒の割合が50%から離れるほど
  const dark = m.reduce((s, row) => s + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return score;
}

// SVG にする（白い余白 4 モジュール）
export function qrSvg(matrix, moduleSize = 4) {
  const n = matrix.length + 8;
  let path = "";
  matrix.forEach((row, y) => row.forEach((dark, x) => { if (dark) path += `M${x + 4},${y + 4}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * moduleSize}" height="${n * moduleSize}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
