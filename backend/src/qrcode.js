'use strict';
/* Minimal QR Code generator (pure JS, no dependencies).
 * Supports byte mode, error correction level L, versions 1-3. */

const DATA_CODEWORDS = { 1: 19, 2: 34, 3: 55 };
const EC_CODEWORDS = { 1: 7, 2: 10, 3: 15 };

function gfMul(a, b) {
  let result = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) result ^= a;
    const high = a & 0x80;
    a = (a << 1) & 0xff;
    if (high) a ^= 0x1d;
    b >>>= 1;
  }
  return result;
}

function rsEncode(data, degree) {
  let generator = [1];
  let root = 1;
  for (let i = 0; i < degree; i++) {
    const next = Array(generator.length + 1).fill(0);
    for (let j = 0; j < generator.length; j++) {
      next[j] ^= generator[j];
      next[j + 1] ^= gfMul(generator[j], root);
    }
    generator = next;
    root = gfMul(root, 2);
  }
  const result = new Uint8Array(data.length + degree);
  result.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = result[i];
    if (factor) for (let j = 0; j < generator.length; j++) result[i + j] ^= gfMul(generator[j], factor);
  }
  return result.slice(data.length);
}

function pushBits(target, value, count) { for (let i = count - 1; i >= 0; i--) target.push((value >>> i) & 1); }
function encodeByte(data) {
  const bytes = Buffer.from(data);
  const bits = [0, 1, 0, 0]; // byte mode
  pushBits(bits, bytes.length, 8);
  for (const byte of bytes) pushBits(bits, byte, 8);
  return bits;
}
function makeDataCodewords(data, version) {
  const capacity = DATA_CODEWORDS[version] * 8;
  const bits = encodeByte(data);
  if (bits.length > capacity) throw new Error('Verification link exceeds QR capacity.');
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  const pads = [0xec, 0x11];
  for (let i = 0; bytes.length < DATA_CODEWORDS[version]; i++) bytes.push(pads[i % 2]);
  return bytes;
}

function setFinder(matrix, row, col) {
  const size = matrix.length;
  for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) {
    const r = row + dy, c = col + dx;
    if (r < 0 || c < 0 || r >= size || c >= size) continue;
    const inside = dy >= 0 && dy <= 6 && dx >= 0 && dx <= 6;
    const dark = inside && (dy === 0 || dy === 6 || dx === 0 || dx === 6 || (dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4));
    matrix[r][c] = dark ? 1 : 0;
  }
}

function setAlignment(matrix, centerRow, centerCol) {
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    matrix[centerRow + dy][centerCol + dx] = Math.max(Math.abs(dx), Math.abs(dy)) !== 1 ? 1 : 0;
  }
}

function setFunctionPatterns(matrix, version) {
  const size = matrix.length;
  setFinder(matrix, 0, 0);
  setFinder(matrix, 0, size - 7);
  setFinder(matrix, size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    if (matrix[6][i] === null) matrix[6][i] = i % 2 === 0 ? 1 : 0;
    if (matrix[i][6] === null) matrix[i][6] = i % 2 === 0 ? 1 : 0;
  }
  if (version === 2) setAlignment(matrix, 18, 18);
  if (version === 3) setAlignment(matrix, 22, 22);
  matrix[size - 8][8] = 1; // fixed dark module
}

function formatBits(mask) {
  const data = (1 << 3) | mask; // error correction level L, mask pattern 0
  let remainder = data << 10;
  for (let bit = 14; bit >= 10; bit--) if ((remainder >>> bit) & 1) remainder ^= 0x537 << (bit - 10);
  return ((data << 10) | remainder) ^ 0x5412;
}

function setFormat(matrix, mask = 0) {
  const size = matrix.length, value = formatBits(mask);
  const bit = i => (value >>> i) & 1;
  for (let i = 0; i <= 5; i++) matrix[i][8] = bit(i);
  matrix[7][8] = bit(6); matrix[8][8] = bit(7); matrix[8][7] = bit(8);
  for (let i = 9; i < 15; i++) matrix[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i++) matrix[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) matrix[size - 15 + i][8] = bit(i);
  matrix[size - 8][8] = 1;
}

function placeData(matrix, codewords) {
  const size = matrix.length;
  const bits = [];
  for (const byte of codewords) pushBits(bits, byte, 8);
  let bitIndex = 0, upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right--;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let offset = 0; offset < 2; offset++) {
        const col = right - offset;
        if (matrix[row][col] !== null) continue;
        const raw = bitIndex < bits.length ? bits[bitIndex++] : 0;
        matrix[row][col] = raw ^ (((row + col) % 2) === 0 ? 1 : 0);
      }
    }
    upward = !upward;
  }
}

function generateMatrix(text) {
  const bytes = Buffer.from(text, 'utf8');
  if (!bytes.length) throw new Error('QR content cannot be empty.');
  const version = bytes.length <= 17 ? 1 : bytes.length <= 32 ? 2 : 3;
  const size = (version - 1) * 4 + 21;
  const dataBytes = makeDataCodewords(bytes, version);
  const ecBytes = rsEncode(dataBytes, EC_CODEWORDS[version]);
  const allBytes = Uint8Array.from([...dataBytes, ...ecBytes]);
  const matrix = Array.from({ length: size }, () => Array(size).fill(null));
  setFunctionPatterns(matrix, version);
  setFormat(matrix, 0); // reserve the format modules before placing payload bits
  placeData(matrix, allBytes);
  setFormat(matrix, 0);
  return matrix;
}

function renderQR(text, scale) {
  const matrix = generateMatrix(text);
  const size = matrix.length;
  const imgSize = size * scale;
  const buf = Buffer.alloc(3 * imgSize * imgSize);
  for (let y = 0; y < imgSize; y++) { for (let x = 0; x < imgSize; x++) { const dark = matrix[Math.floor(y / scale)][Math.floor(x / scale)]; const i = (y * imgSize + x) * 3; buf[i] = dark ? 0 : 255; buf[i + 1] = dark ? 0 : 255; buf[i + 2] = dark ? 0 : 255; } }
  return { buffer: buf, width: imgSize, height: imgSize };
}

module.exports = { renderQR };
