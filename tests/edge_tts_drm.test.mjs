// cloudflare/edge-tts/drm.js 的守門測試（node --test tests/edge_tts_drm.test.mjs）。
// 標準答案 tests/vectors/edge_tts_sec_ms_gec_v2.json 由 Python edge-tts 7.3.1 的 generate_sec_ms_gec_v2 產生；
// JS 移植版在同一個時間戳必須輸出一字不差的 token，否則微軟會回 403、ASN 後台的念出訊息就會失敗。
// 升級 edge-tts 時：用新版套件重產向量，這支測試紅了就照 drm.py 改 drm.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateSecMsGecV2 } from '../cloudflare/edge-tts/drm.js';

const vec = JSON.parse(readFileSync(new URL('./vectors/edge_tts_sec_ms_gec_v2.json', import.meta.url), 'utf8'));

test('v2 token：每個時間戳都跟 Python edge-tts 7.3.1 一字不差', () => {
  const cases = Object.entries(vec.cases);
  assert.ok(cases.length >= 5);
  for (const [ts, want] of cases) assert.equal(generateSecMsGecV2(Number(ts)), want, `ts=${ts}`);
});

test('v2 token：格式是 16 hex - 64 hex（大寫）', () => {
  assert.match(generateSecMsGecV2(), /^[0-9A-F]{16}-[0-9A-F]{64}$/);
});

test('v2 token：同一個 5 分鐘窗內不變，跨窗就變', () => {
  const base = 1800000000 - ((1800000000 + 11644473600) % 300);
  assert.equal(generateSecMsGecV2(base), generateSecMsGecV2(base + 299.9));
  assert.notEqual(generateSecMsGecV2(base), generateSecMsGecV2(base + 300));
});
