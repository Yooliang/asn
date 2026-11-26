// #1853 第 2 張：前端的存檔鍵名常數（ui/lib/storage-keys.mjs）要跟 Rust 設定層（src-tauri/src/settings/docs.rs）逐一對齊。
// 做法：直接解析 Rust 原始碼（rustDocs），不編譯 Rust——這台機器記憶體吃緊，而且 docs.rs 的欄位宣告是單行 `pub 名字: 型別,`，解析穩定。
// 另一條路是寫一支 Rust 測試輸出欄位名單再讓 JS 讀，要多編一次 Rust，沒有選。
// Rust 改名、多一個、少一個欄位，這裡都會紅；同時 settings-list.test.mjs 會拿同一份 Rust 解析結果去對設定值清單。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DOC_FIELDS, LAUNCH_PREFS_FIELDS, ME_FIELDS_PENDING, ONBOARD_FIELDS } from '../ui/lib/storage-keys.mjs'
import { PENDING_KEY, PENDING_BASE_KEY } from '../ui/lib/device-rename.mjs'
import { launchPrefsToSave, normalizeLaunchPrefs } from '../ui/lib/launch-prefs.mjs'
import { DEFAULT_CFG } from '../ui/lib/voice-prefs.mjs'
import { diffKeys, rustDocs } from './settings-list-check.mjs'

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const DOCS_RS = 'src-tauri/src/settings/docs.rs'

// 前端抄的 DOC_FIELDS 跟 Rust 逐檔逐欄比對（含「Rust 有、前端沒抄」與「前端有、Rust 沒有」兩個方向）
const compareDocs = rs => {
  const rust = rustDocs(rs)
  const errs = diffKeys('設定檔清單', Object.keys(rust), Object.keys(DOC_FIELDS))
  for (const name of Object.keys(rust)) if (DOC_FIELDS[name]) errs.push(...diffKeys(`${name}.json 的欄位`, rust[name], DOC_FIELDS[name]))
  return errs
}

test('前端的 DOC_FIELDS 跟 Rust 設定層（docs.rs）的欄位完全一致', () => {
  assert.deepEqual(compareDocs(read(DOCS_RS)), [])
})

test('還原驗證：Rust 改鍵名、多欄位、少欄位、多一個設定檔 → 對齊測試報錯', () => {
  const rs = read(DOCS_RS)
  const rename = rs.replace('pub stt_model: String', 'pub stt_model_id: String')
  assert.notEqual(rename, rs)
  assert.deepEqual(compareDocs(rename).map(e => e.kind).sort(), ['keys-extra', 'keys-missing'])
  assert.deepEqual(compareDocs(rs.replace('pub done: bool,', 'pub done: bool,\n        pub extra_flag: bool,')).map(e => e.kind), ['keys-missing'])
  assert.deepEqual(compareDocs(rs.replace(/\n\s*pub agy: bool,/, '')).map(e => e.kind), ['keys-extra'])
  const more = `${rs}\n    #[derive(Default)] pub struct ZzDoc {\n        pub a: bool,\n    }\n    impl Doc for ZzDoc { const NAME: &'static str = "zz"; }\n`
  assert.ok(compareDocs(more).some(e => e.kind === 'keys-missing' && /zz/.test(e.msg)))
})

test('解析 Rust 的底線：extra 不算欄位、八個設定檔都解析得到', () => {
  const d = rustDocs(read(DOCS_RS))
  assert.equal(Object.keys(d).length, 8)
  for (const f of Object.values(d)) assert.ok(!f.includes('extra'))
  assert.equal(d.bridge.length, 13)
})

test('語音設定檔：前端預設設定的欄位 ＝ Rust VoiceDoc 的欄位', () => {
  assert.deepEqual(diffKeys('voice.json', rustDocs(read(DOCS_RS)).voice, Object.keys(DEFAULT_CFG)), [])
})

// Rust 端不宣告欄位的檔：欄位真相在前端原始碼，這裡對前端
test('launch-prefs.json：存檔欄位 ＝ LAUNCH_PREFS_FIELDS（launchPrefsToSave 的輸出，maxPerHourSet 設過才有）', () => {
  const out = launchPrefsToSave({ ...normalizeLaunchPrefs({ maxPerHourSet: 3 }) })
  assert.deepEqual(Object.keys(out).sort(), [...LAUNCH_PREFS_FIELDS].sort())
  assert.deepEqual(DOC_FIELDS['launch-prefs'], [], 'Rust 端沒宣告欄位，前端另有 LAUNCH_PREFS_FIELDS')
})

test('asn-me.json 待送名字的欄位 ＝ device-rename.mjs 的常數', () => {
  assert.deepEqual([...ME_FIELDS_PENDING], [PENDING_KEY, PENDING_BASE_KEY])
})

test('asn-onboard.json：存檔欄位 ＝ ONBOARD_FIELDS（onboard.mjs 只送 done）', () => {
  const src = read('ui/lib/onboard.mjs')
  const sent = new Set([...src.matchAll(/patchWithFallback\(store, \{ (\w+): /g)].map(m => m[1]))
  assert.deepEqual([...sent], [...ONBOARD_FIELDS])
})
