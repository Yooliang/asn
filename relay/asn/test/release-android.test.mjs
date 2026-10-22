// 安卓自行安裝版的發版腳本邏輯：android.json 的內容要能被 App 端（android_update.rs 的 parse_manifest）接受。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { androidApkName, androidApkUrl, androidNotes, buildAndroidJson, parseAndroidArgs, versionCodeOf } from '../scripts/release-android-lib.mjs'

const SHA = 'a'.repeat(64)

test('versionCode 算法：與 Tauri 及 App 端一致（0.1.32 → 1032），單調遞增', () => {
  assert.equal(versionCodeOf('0.1.32'), 1032)
  assert.equal(versionCodeOf('1.2.3'), 1_002_003)
  assert.ok(versionCodeOf('0.1.33') > versionCodeOf('0.1.32') && versionCodeOf('0.2.0') > versionCodeOf('0.1.999'))
  for (const bad of ['', '1.2', '1.2.3.4', '1.2.x', '0.1000.0', 'v1.2.3', '1.2.3-b']) assert.throws(() => versionCodeOf(bad), bad)
})

test('android.json：欄位齊全、網址在官網 update/、檔名固定；sha256 與大小不合格就不產出', () => {
  const j = buildAndroidJson({ version: '0.1.33', notes: ' - 第一行\n- 第二行 ', sha256: SHA, bytes: 8_600_000 })
  assert.deepEqual(Object.keys(j), ['version', 'versionCode', 'url', 'sha256', 'notes', 'bytes'])
  assert.equal(j.versionCode, 1033); assert.equal(j.url, 'https://asnmessenger.web.app/update/ASN_0.1.33_android.apk')
  assert.equal(androidApkName('0.1.33'), 'ASN_0.1.33_android.apk'); assert.equal(androidApkUrl('0.1.33'), j.url)
  assert.equal(j.notes, '- 第一行\n- 第二行')
  for (const bad of ['', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) assert.throws(() => buildAndroidJson({ version: '0.1.33', notes: '', sha256: bad, bytes: 1 }), /sha256/)
  for (const bad of [0, -1, 1.5, '12']) assert.throws(() => buildAndroidJson({ version: '0.1.33', notes: '', sha256: SHA, bytes: bad }), /大小/)
  assert.throws(() => buildAndroidJson({ version: '0.1', notes: '', sha256: SHA, bytes: 1 }))
})

test('更新說明與參數', () => {
  assert.equal(androidNotes({ arg: '自訂', changelog: '## 0.1.33\n- 條列', version: '0.1.33' }), '自訂')
  assert.equal(androidNotes({ arg: '', changelog: '# 標題\n\n## 0.1.33（日期）\n- 條列一\n- 條列二\n\n## 0.1.32\n- 舊', version: '0.1.33' }), '- 條列一\n- 條列二')
  assert.equal(androidNotes({ arg: '', changelog: '', version: '0.1.33' }), 'ASN 0.1.33 更新')
  assert.deepEqual(parseAndroidArgs(['--dry-run', '--notes', 'x']), { notes: 'x', dryRun: true })
  assert.throws(() => parseAndroidArgs(['--bogus'])); assert.throws(() => parseAndroidArgs(['--notes']))
})
