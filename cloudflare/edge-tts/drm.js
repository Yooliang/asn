// SPDX-License-Identifier: LGPL-3.0-only
// 本檔逐行移植自 edge-tts（https://github.com/rany2/edge-tts）的 drm.py，原作照 LGPLv3 授權；本檔與它的修改同樣照 LGPL-3.0，不受 ASN 主授權影響（見 THIRD_PARTY_NOTICES.md）。
// Sec-MS-GEC v2 token：逐行移植自 Python edge-tts 7.3.1 的 drm.py（generate_sec_ms_gec_v2）。
// 格式 "<16 hex>-<64 hex>"＝CS64 摘要 + 改過初始狀態的 SHA-256 摘要。
// 全程用 BigInt，語意跟 Python 的無限精度整數一致（Python 有些中間值故意不遮罩，晚一點才 & 0xFFFFFFFF）。
// 微軟再改版時：升級 edge-tts、對照 drm.py，再跑 cloudflare/edge-tts/drm.test.mjs（標準答案由 Python 產生）。

export const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
export const WIN_EPOCH = 11644473600;

const M = 0xffffffffn;

const SHA256_INITIAL = [
  0x6a09e667n, 0xbb67ae85n, 0x3c6ef372n, 0xa54ff53an, 0x510e527fn, 0x9b05688cn, 0x1f83d9abn, 0x5be0cd19n,
];
const SHA256_STATE = [
  0xfd9fbea2n, 0x91243ce7n, 0xbe499094n, 0xcd2e1e0an, 0x6c006f49n, 0x04bd35abn, 0xfeb0a7e4n, 0x03effbd2n,
];
const SHA256_SCHEDULE = [
  0xeb24bf9en, 0x1558691fn, 0xa0c09ee2n, 0x0cfa32ban, 0xa622ee8cn, 0xd1dd9491n, 0xc0dd25a0n,
  0xf9e70ab6n, 0xf0c31573n, 0x7058ce4en, 0x7188e606n, 0x00e5ab33n, 0xd258b060n, 0x72766564n,
];
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
].map(BigInt);
const SHA256_ADJUSTMENT = 0xc9dc06a7n;
const SHA256_BLOCK_CONSTANTS = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14), SHA256_ADJUSTMENT, ...SHA256_ROUND_CONSTANTS.slice(15),
];
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80n;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0n;

const CS64_COEFFICIENTS = [
  [0xe82e91b1n, 0xb32700d0n], [0x44de24c6n, 0x88dff51dn], [0x3beb65bcn, 0x29514038n],
  [0xc89c5933n, 0xb328cbdfn], [0x8d1ec211n, 0xd405b4d5n], [0x314ef5d5n, 0x26e55f3cn],
  [0xe92491b1n, 0x607801c6n], [0xf0a5b9d5n, 0x82b2c1fbn], [0x06064cf3n, 0xfa51a3dan],
  [0xda79fa60n, 0x207cc464n], [0xbed20560n, 0x3c3c74f3n], [0x89f9c9f8n, 0xd2d14b61n],
  [0x35fa38c6n, 0xbb04a2c1n], [0xcb49e3c6n, 0xc5626167n],
];
const CS64_FACTOR = 0x82893933n;
const CS64_ADJUSTMENT0 = 0xf2f90b1an;
const CS64_ADJUSTMENT1 = 0x0b1a0000n;

const rol16 = (v) => {
  const x = v & M;
  return ((x << 16n) | (x >> 16n)) & M;
};

const readBE = (b, off, len) => {
  let v = 0n;
  for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(b[off + i]);
  return v;
};
const readLE32 = (b, off) =>
  BigInt(b[off]) | (BigInt(b[off + 1]) << 8n) | (BigInt(b[off + 2]) << 16n) | (BigInt(b[off + 3]) << 24n);

// 小端 32 位元字組，補零到 4 的倍數，字組數補成偶數
function wordsLe4Even(data) {
  const padded = new Uint8Array(Math.ceil(data.length / 4) * 4);
  padded.set(data);
  const words = [];
  for (let i = 0; i < padded.length; i += 4) words.push(readLE32(padded, i));
  if (words.length % 2) words.push(0n);
  return words;
}

const sigma0 = (v) => ((v >> 7n) ^ (v << 25n) ^ (v >> 18n) ^ (v << 14n) ^ (v >> 3n)) & M;
const sigma1 = (v) => ((v >> 17n) ^ (v << 15n) ^ (v >> 19n) ^ (v << 13n) ^ (v >> 10n)) & M;

// SHA-256 回合；firstRound=14 時從第一個區塊中段接續（用調整過的常數）。
// Python 版把後段展開成每 8 回合一組只是換暫存器名稱，數學上與逐回合相同。
function sha256Rounds(state, words, firstRound = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  for (let i = firstRound; i < 64; i++) {
    const rotE = e * 0x100000001n;
    const rotA = a * 0x100000001n;
    const t1 = h + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (g ^ (e & (f ^ g))) + constants[i] + words[i];
    const t2 = ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((a & b) | (c & (a | b)));
    [a, b, c, d, e, f, g, h] = [(t1 + t2) & M, a, b, c, (d + t1) & M, e, f, g];
  }
  return [a, b, c, d, e, f, g, h];
}

function expandSchedule(words, firstWord = 16) {
  for (let i = firstWord; i < 64; i++) {
    const x = words[i - 2];
    const y = words[i - 15];
    const s1 = (x >> 17n) ^ (x << 15n) ^ (x >> 19n) ^ (x << 13n) ^ (x >> 10n);
    const s0 = (y >> 7n) ^ (y << 25n) ^ (y >> 18n) ^ (y << 14n) ^ (y >> 3n);
    words.push((s1 + words[i - 7] + s0 + words[i - 16]) & M);
  }
  return words;
}

// 前 7 個位元組 → 初始狀態（對應 _sha256_init）
function sha256Init(data7) {
  const words = [...Array(14).fill(0n), readBE(data7, 0, 3), readBE(data7, 3, 4)];
  for (let i = 16; i < 30; i++) {
    let value = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) value += i === 16 ? sigma1(words[i - 2]) ^ SHA256_SIGMA1_ADJUSTMENT : sigma1(words[i - 2]);
    if (i - 7 >= 14) value += words[i - 7];
    if (i - 15 >= 14) value += i === 29 ? sigma0(words[i - 15]) ^ SHA256_SIGMA0_ADJUSTMENT : sigma0(words[i - 15]);
    words.push(value & M);
  }
  words.push(
    (sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] + SHA256_ADJUSTMENT - SHA256_ROUND_CONSTANTS[14]) & M,
  );
  expandSchedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((x, i) => (x + working[i]) & M);
}

function sha256Digest(data) {
  if (data.length < 7) throw new Error("Token salt must contain at least seven bytes");
  const length = 57 + data.length;
  const zeros = (((55 - length) % 64) + 64) % 64; // Python 的 % 恆非負
  const padded = new Uint8Array(data.length - 7 + 1 + zeros + 8);
  padded.set(data.subarray(7));
  padded[data.length - 7] = 0x80;
  const bits = BigInt(length * 8);
  for (let i = 0; i < 8; i++) padded[padded.length - 1 - i] = Number((bits >> BigInt(8 * i)) & 0xffn);
  let state = sha256Init(data.subarray(0, 7));
  for (let off = 0; off < padded.length; off += 64) {
    const words = [];
    for (let i = 0; i < 16; i++) words.push(readBE(padded, off + 4 * i, 4));
    const working = sha256Rounds(state, expandSchedule(words));
    state = state.map((x, i) => (x + working[i]) & M);
  }
  return state; // 8 個 32 位元字組（大端序輸出）
}

function cs64Digest(data, digestWords) {
  // digest 的前 8 個位元組以小端讀成兩個 32 位元字組
  const be = new Uint8Array(8);
  for (let i = 0; i < 2; i++) for (let j = 0; j < 4; j++) be[4 * i + j] = Number((digestWords[i] >> BigInt(24 - 8 * j)) & 0xffn);
  const keyA = readLE32(be, 0) | 1n;
  const keyB = readLE32(be, 4) | 1n;
  const factors = [(keyA * CS64_FACTOR) & M, (keyB * CS64_FACTOR) & M];
  const terms = CS64_COEFFICIENTS.map(([coef], i) => (coef * factors[i % 2]) & M);
  const offsets = CS64_COEFFICIENTS.map(([, off]) => off);
  const prefixed = new Uint8Array(data.length + 1);
  prefixed.set(data, 1);
  wordsLe4Even(prefixed).forEach((word, i) => {
    let term = word * (i % 2 === 0 ? keyA : keyB);
    let offset = rol16(word) * (i % 2 === 0 ? 0xef0569fbn : 0xc31713dbn);
    if (i === 0) {
      term += CS64_ADJUSTMENT0 * factors[0];
      offset += CS64_ADJUSTMENT1;
    }
    terms.push(term & M);
    offsets.push(offset & M);
  });
  let swapAcc = 0n, swapLast = 0n, state = 0n, acc = 0n;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let t = rol16((offsets[i] + x) & M);
    let q = (t * 0x76f50f34n) & M;
    swapAcc += (rol16(q) * 0xc3efea97n + q) & M;
    t = rol16((offsets[i + 1] + y) & M);
    q = (t * 0x1881ce3cn) & M;
    swapLast = (rol16(q) * 0x35bd1ec9n + q) & M;
    swapAcc = (swapAcc + swapLast) & M;

    state = (state * keyA + x) & M;
    state = (rol16(state) * 0xcf98b111n) & M;
    state = (rol16(state) * 0x87085b9fn) & M;
    state = (rol16(state) * 0x12ceb96dn) & M;
    state = (rol16(state) * 0x257e1d83n) & M;
    acc += state;
    t = (state * keyB + y) & M;
    t = (rol16(t) * 0xa27416f5n) & M;
    t = (rol16(t) * 0xd38396ffn) & M;
    state = (rol16((rol16(t) * 0x7c932b89n) & M) * 0xbfa49f69n) & M;
    acc = (acc + state) & M;
  }
  return [swapLast ^ state, swapAcc ^ acc];
}

const hex8 = (v) => v.toString(16).padStart(8, "0").toUpperCase();
// 32 位元字組以小端序位元組輸出成 hex（對應 struct.pack("<I")）
const hexLE = (v) => hex8(((v & 0xffn) << 24n) | (((v >> 8n) & 0xffn) << 16n) | (((v >> 16n) & 0xffn) << 8n) | (v >> 24n));

/** 依 unix 秒數（預設現在）產生 v2 Sec-MS-GEC，5 分鐘一個窗。 */
export function generateSecMsGecV2(unixSeconds = Date.now() / 1000) {
  let t = Math.floor(unixSeconds) + WIN_EPOCH;
  t -= t % 300;
  const ticks = BigInt(t) * 10000000n; // 100 奈秒
  const data = new TextEncoder().encode(ticks.toString() + TRUSTED_CLIENT_TOKEN);
  const digest = sha256Digest(data);
  const [c0, c1] = cs64Digest(data, digest);
  return `${hexLE(c0)}${hexLE(c1)}-${digest.map(hex8).join("")}`;
}
