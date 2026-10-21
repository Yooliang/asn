// 遠端更新（名單上對自己帳號下別台設備按「更新」）：介面邏輯與接線、Rust 端命令與回報迴圈的守門。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mineFromStatus, remoteUpdateView } from '../ui/lib/remote-update.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('mineFromStatus：有出現的節點＝本人帳號下；請求狀態只認 pending／taken／failed；格式不對丟掉', () => {
  const m = mineFromStatus({ nodes: [
    { id: 'H', update: null },
    { id: 'W', update: { state: 'pending', detail: null, at: 'x' } },
    { id: 'A', update: { state: 'failed', detail: '下載失敗' } },
    { id: 'B', update: { state: 'weird' } },
    { id: '', update: null }, null, { update: null },
  ] })
  assert.deepEqual(Object.keys(m).sort(), ['A', 'B', 'H', 'W'])
  assert.equal(m.H, null)
  assert.deepEqual(m.W, { state: 'pending', detail: '' })
  assert.deepEqual(m.A, { state: 'failed', detail: '下載失敗' })
  assert.equal(m.B, null)
  assert.deepEqual(mineFromStatus(null), {})
  assert.deepEqual(mineFromStatus({ nodes: 'x' }), {})
})

test('remoteUpdateView：要「有新版」且在本人帳號下才有鈕；別人帳號的設備、沒登入都沒有', () => {
  const mine = { W: null }
  assert.equal(remoteUpdateView(mine, 'W', true).label, '更新')
  assert.equal(remoteUpdateView(mine, 'W', false), null, '沒有新版不顯示')
  assert.equal(remoteUpdateView(mine, 'X', true), null, '不在本人帳號下（別人的設備）不顯示')
  assert.equal(remoteUpdateView({}, 'W', true), null, '沒登入（清單空）不顯示')
  assert.equal(remoteUpdateView(null, 'W', true), null)
  assert.equal(remoteUpdateView(Object.create({ W: null }), 'W', true), null, '原型上的鍵不算')
})

test('remoteUpdateView：進度文字（已送出→更新中→失敗可重試），忙碌中不可再按', () => {
  const v = u => remoteUpdateView({ W: u }, 'W', true)
  assert.deepEqual([v({ state: 'pending' }).label, v({ state: 'pending' }).busy], ['已送出更新要求', true])
  assert.deepEqual([v({ state: 'taken' }).label, v({ state: 'taken' }).busy], ['更新中…', true])
  const f = v({ state: 'failed', detail: '下載或驗簽失敗' })
  assert.deepEqual([f.label, f.busy, f.title], ['更新失敗，重試', false, '下載或驗簽失敗'])
  assert.equal(remoteUpdateView({ W: null }, 'W', true, '那台電腦的 ASN 目前沒有開著').title, '那台電腦的 ASN 目前沒有開著')
  for (const s of ['更新', '已送出更新要求', '更新中…', '更新失敗，重試']) assert.doesNotMatch(s, /[A-Za-z]/, '介面文字純中文')
})

test('接線：「更新」鈕在「有新版」旁、點擊不展開分組、只呼叫 Rust 命令（不碰金鑰與憑證）', () => {
  const html = read('ui/list.html')
  const i = html.indexOf('class="asn-new"')
  assert.ok(i > 0 && html.indexOf('asn-upd', i) > i)
  assert.match(html, /class="asn-upd"[^>]*v-if="remoteBtn\(g\.node\)"[^>]*@click\.stop="requestRemoteUpdate\(g\.node\)"/)
  const js = read('ui/list.js')
  assert.match(js, /invoke\('update_remote_request', \{ node \}\)/)
  assert.match(js, /invoke\('update_remote_status'\)/)
  assert.match(js, /if \(!info\.shot\) \{\s*void refreshRemoteUpd\(\)/, '--shot 模式不輪詢')
  assert.doesNotMatch(js + html, /access_token|Bearer|x-relay-key/i)
})

test('Rust 端：命令登錄、回報迴圈取走旗標後走內建更新器、結果回報；不經 AI', () => {
  const lib = read('src-tauri/src/lib.rs')
  assert.match(lib, /account::update_remote_request, account::update_remote_status/)
  assert.match(lib, /r4\.take_update_request\(\)/)
  assert.match(lib, /updater::run_remote\(&h\)/)
  assert.match(lib, /report_update_result\(true, "已是最新版"\)/)
  const up = read('src-tauri/src/updater.rs')
  const fn = up.slice(up.indexOf('pub async fn run_remote'), up.indexOf('async fn run_install'))
  assert.match(fn, /busy\.load/, '正在更新中不重複啟動')
  assert.match(fn, /update_check\(/)
  assert.match(fn, /update_install\(/, '同一條路：檢查→下載→驗簽→安裝（update_install 內含）')
  const acct = read('src-tauri/src/account.rs')
  assert.match(acct, /"node_update_request", None, json!\(\{ "node": node \}\)/, '只帶節點，身分由登入憑證決定')
})

test('後台 migration：沒被套用也要能讀出規則（擁有者限定、30 分鐘過期、只授權 service_role）', () => {
  const sql = read('../../supabase/migrations/20261021070000_asn_remote_update.sql')
  assert.match(sql, /owner_user = p_user/)
  assert.match(sql, /interval '30 minutes'/)
  assert.doesNotMatch(sql, /grant execute[^;]*to (anon|authenticated|public)/)
})
