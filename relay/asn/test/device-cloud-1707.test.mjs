// #1707 設定頁的雲端節點：名字是節點自己的名字（例如「牧陽 Aegis」），詳情不寫「還沒連線過，連上時會記住指紋」，也不寫「帳號回報讀取失敗」。
// 用雲端節點的真實形狀：沒有設備公鑰（認得的電腦裡沒有它）、夥伴沒帶 device 欄、夥伴狀態 idle、帳號回報讀取失敗；本機記得它上次被判成雲端。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'
import { acctDeviceTree, acctHeadView } from '../ui/lib/mobile-acct.mjs'

const CLOUD = 'cloud-node-aegis-7Q2M'
const friends = [{ id: `${CLOUD}/麗麗`, node: CLOUD, agent: '麗麗', nick: '麗麗', status: 'idle', engine: 'aegis', kind: 'claude' }]   // 存檔還原的夥伴列：沒有 device
const tree = () => buildDeviceTree({ friends, nodeNames: { [CLOUD]: '牧陽 Aegis' }, nodeOrder: [CLOUD], selfNode: 'SELF', cloudNodes: [CLOUD], reports: { [CLOUD]: { error: 'read failed', asnOnline: false, reportedAt: '', accounts: [] } } })
const render = async props => {
  globalThis.Vue = Vue
  const st = { version: '0.2.35', devices: tree(), accounts: { list: [], current: null, msg: '', autoNote: '', busy: false, confirmDel: '' }, known: { ownFp: '', qr: null, busy: false, peers: [], error: '', renameError: '' } }
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, meAv: '', catKey: 'devices', ...props }) }))
}

test('#1707 雲端節點的名字取自節點自己的名字，列表和詳情都不寫「未命名設備」', async () => {
  const row = tree().find(d => d.key === CLOUD)
  assert.equal(row.cloud, true)
  assert.equal(row.label, '牧陽 Aegis')
  assert.equal(row.identity.title, '牧陽 Aegis')
  const detail = await render({ dev: CLOUD, devView: 'info' })
  assert.match(detail, /<h3 class="dv-name">牧陽 Aegis<\/h3>/)
  assert.ok(!detail.includes('未命名設備'))
})

test('#1707 雲端節點的詳情不寫「還沒連線過」與「帳號回報讀取失敗」', async () => {
  const detail = (await render({ dev: CLOUD, devView: 'info' })).replace(/<!--.*?-->/g, '')
  assert.ok(!detail.includes('還沒連線過') && !detail.includes('連上時會記住指紋'))
  assert.ok(!detail.includes('帳號回報讀取失敗') && !detail.includes('讀取失敗'))
  assert.ok(!detail.includes('帳號最後回報'), '雲端沒有帳號回報，整列不放')
  assert.ok(!detail.includes('<dt>指紋</dt>'), '沒有設備公鑰就不放指紋那一列')
})

test('#1707 同一份資料，手機和電腦的種類標籤都是「雲端」（同一個判斷函式，手機詳情頁頭也讀它）', async () => {
  const args = { friends, nodeNames: { [CLOUD]: '牧陽 Aegis' }, nodeOrder: [CLOUD], selfNode: 'SELF', cloudNodes: [CLOUD], reports: { [CLOUD]: { error: 'read failed', asnOnline: false, reportedAt: '', accounts: [] } } }
  const desk = buildDeviceTree(args).find(d => d.key === CLOUD)
  const phone = acctDeviceTree({ ...args, reports: {} }).find(d => d.key === CLOUD)
  assert.equal(desk.kindLabel, '雲端')
  assert.equal(phone.kindLabel, '雲端')
  // 電腦版詳情頁頭寫「雲端」；手機詳情頁頭綁的是同一個 kindLabel，不是只有「電腦／手機」的 kind
  assert.match(await render({ dev: CLOUD, devView: 'info' }), /<span class="dv-tag kind">雲端<\/span>/)
  // #1864 起手機詳情的種類標籤搬到標題列（acctHeadView），讀的仍是 kindLabel
  assert.deepEqual(acctHeadView('devices', phone).tags.find(t => t.cls === 'kind'), { text: '雲端', cls: 'kind' })
  const m = fs.readFileSync(new URL('../ui/m.html', import.meta.url), 'utf8')
  assert.match(m, /v-for="t in acctHead\.tags"/, '手機標題列畫的是 acctHeadView 的標籤')
  assert.doesNotMatch(m, /\{\{ acctCur\.kind \}\}/)
})
