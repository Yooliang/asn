// 設備 ASN 在線狀態：名單的 asn 列整理、版本比較、設備分組標題旁的標記。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { asnByNode, compareVersion, deviceAsn } from '../ui/lib/presence.mjs'
import { groupItems } from '../ui/lib/dims.mjs'
import { AsnCore } from '../ui/lib/core.mjs'

test('asnByNode：只留格式對的列、狀態只認忙碌／暫離（其餘當線上）、沒有 asn 的節點不列', () => {
  const r = asnByNode([
    { id: 'H', asn: [{ window_name: 'H-ASN', version: '0.1.13', status: 'online', psm: '聽歌中' }, { window_name: 'x', version: 'bad', status: 'online' }, { window_name: '', version: '1.0.0' }, null] },
    { id: 'W', asn: [{ window_name: 'W-ASN', version: '0.1.12', status: 'busy' }, { window_name: 'W2', version: '0.1.12', status: 'weird' }] },
    { id: 'A', asn: [] },
    { id: 'B' },
    { asn: [{ window_name: 'n', version: '1.0.0' }] },
  ])
  assert.deepEqual(Object.keys(r).sort(), ['H', 'W'])
  assert.deepEqual(r.H, [{ window_name: 'H-ASN', version: '0.1.13', status: 'online', psm: '聽歌中' }])
  assert.deepEqual(r.W.map(x => x.status), ['busy', 'online'])
  assert.deepEqual(asnByNode(null), {})
})

test('compareVersion：照數字比（0.1.9 < 0.1.13）；格式不對不亂提示', () => {
  assert.equal(compareVersion('0.1.12', '0.1.13'), -1)
  assert.equal(compareVersion('0.1.9', '0.1.13'), -1)
  assert.equal(compareVersion('0.2.0', '0.1.13'), 1)
  assert.equal(compareVersion('1.0.0', '0.9.99'), 1)
  assert.equal(compareVersion('0.1.13', '0.1.13'), 0)
  assert.equal(compareVersion('0.1.13-beta', '0.1.13'), 0)
  assert.equal(compareVersion('abc', '0.1.13'), 0)
  assert.equal(compareVersion('0.1.13', undefined), 0)
})

test('deviceAsn：沒有 ASN＝null；提示文字「ASN 版本 狀態」；比自己舊才標有新版；多視窗取最在線的狀態與最新版', () => {
  assert.equal(deviceAsn(undefined, '0.1.13'), null)
  assert.equal(deviceAsn([], '0.1.13'), null)
  const on = deviceAsn([{ window_name: 'a', version: '0.1.13', status: 'online' }], '0.1.13')
  assert.deepEqual(on, { status: 'online', version: '0.1.13', outdated: false, tip: 'ASN 0.1.13 線上' })
  assert.equal(deviceAsn([{ window_name: 'a', version: '0.1.12', status: 'busy' }], '0.1.13').outdated, true)
  assert.equal(deviceAsn([{ window_name: 'a', version: '0.2.0', status: 'away' }], '0.1.13').outdated, false, '對方比自己新不提示')
  const multi = deviceAsn([{ window_name: 'a', version: '0.1.10', status: 'away' }, { window_name: 'b', version: '0.1.13', status: 'busy' }], '0.1.13')
  assert.equal(multi.status, 'busy')
  assert.equal(multi.version, '0.1.13')
  assert.equal(multi.tip, 'ASN 0.1.13 忙碌')
})

test('設備分組帶著節點代號（標題旁用它查那台的 ASN）', () => {
  const g = groupItems([{ id: 'H/a', node: 'H', device: '家用機', nick: 'a', status: 'online' }, { id: 'W/b', node: 'W', device: '工作機', nick: 'b', status: 'online' }], 'device', { selfNode: 'H' })
  assert.deepEqual(g.map(x => x.node), ['H', 'W'])
})

test('AsnCore：名單的 asn 進快照，換一輪名單就更新', async () => {
  let members = [{ id: 'H', name: '家', agents: [], asn: [{ window_name: 'H-ASN', version: '0.1.13', status: 'online' }] }]
  const core = new AsnCore({ transport: { list: async () => ({ members }), inbox: async () => ({ messages: [] }), ack: async () => ({}) }, store: { load: async () => null, save: async () => {} }, selfNode: 'H', windowName: 'H-ASN' })
  await core.refreshRoster()
  assert.equal(core.snapshot().asn.H[0].version, '0.1.13')
  members = [{ id: 'H', name: '家', agents: [] }]
  await core.refreshRoster()
  assert.deepEqual(core.snapshot().asn, {})
})

test('介面接線：設備分組標題旁有小綠點與有新版小字；狀態下拉與個人訊息交給 set_presence；工具列窄寬度會換行', () => {
  const html = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  const js = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  const css = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8')
  assert.match(html, /g\.kind === 'device' && asnBadge\(g\.node\)/)
  assert.match(html, /asnBadge\(g\.node\)\.tip/)
  assert.match(html, /有新版/)
  assert.match(js, /invoke\('set_presence', \{ status: me\.status, psm: me\.psm/)
  assert.match(css, /\.toolbar\{[^}]*flex-wrap:wrap/)
})
