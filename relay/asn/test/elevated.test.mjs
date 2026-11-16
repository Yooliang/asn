// 系統管理員身分開的視窗（收發室轉不進去）：名單上顯示「收不到信」與說明；沒有這個欄位就不顯示。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ELEVATED_BADGE, ELEVATED_TIP, elevatedBadge } from '../ui/lib/elevated.mjs'
import { overlayLocal } from '../ui/lib/local-status.mjs'
import { buildFriends } from '../ui/lib/roster.mjs'

const fr = (id, node, status, extra = {}) => [id, { id, node, agent: id.split('/')[1], nick: id.split('/')[1], status, psm: 'asn', contextPct: null, ...extra }]

test('elevatedBadge：只有帶 elevated 的在線視窗才有標記，文字白話', () => {
  assert.deepEqual(elevatedBadge({ elevated: true, status: 'online' }), { text: ELEVATED_BADGE, tip: ELEVATED_TIP })
  assert.equal(elevatedBadge({ status: 'online' }), null, '沒有欄位不顯示')
  assert.equal(elevatedBadge({ elevated: false, status: 'online' }), null)
  assert.equal(elevatedBadge({ elevated: true, status: 'offline' }), null, '離線不顯示')
  assert.equal(elevatedBadge(null), null)
  assert.equal(ELEVATED_BADGE, '收不到信')
  assert.match(ELEVATED_TIP, /系統管理員身分開的/)
  assert.match(ELEVATED_TIP, /重開/)
})

test('overlayLocal：本機讀到 elevated 就標上，沒帶就不標；標記有變就回新的 Map', () => {
  const m = new Map([fr('T/甲', 'T', 'online'), fr('T/乙', 'T', 'online')])
  const a = overlayLocal(m, 'T', [{ name: '甲', status: 'idle', elevated: true }, { name: '乙', status: 'idle' }])
  assert.equal(a.get('T/甲').elevated, true)
  assert.notEqual(a.get('T/乙').elevated, true)
  assert.equal(elevatedBadge(a.get('T/甲'))?.text, '收不到信')
  assert.equal(elevatedBadge(a.get('T/乙')), null)
  assert.equal(overlayLocal(a, 'T', [{ name: '甲', status: 'idle', elevated: true }, { name: '乙', status: 'idle' }]), null, '沒變不重畫')
  const b = overlayLocal(a, 'T', [{ name: '甲', status: 'idle' }, { name: '乙', status: 'idle' }])
  assert.equal(b.get('T/甲').elevated, false, '改用一般方式重開後標記消失')
})

test('buildFriends：後台名單帶 elevated:true 才算（手機等後台支援後自動顯示），舊後台沒有欄位＝false', () => {
  const members = [{ id: 'T', name: '電腦', agents: [{ name: '甲', status: 'idle', engine: 'claude', elevated: true }, { name: '乙', status: 'idle', engine: 'claude' }] }]
  const f = buildFriends(members, { selfNode: 'X', selfName: 'x' })
  assert.equal(f.find(x => x.agent === '甲').elevated, true)
  assert.equal(f.find(x => x.agent === '乙').elevated, false)
})

test('接線：電腦版與手機的名單列都有標記，且畫面元件有匯出函式', () => {
  for (const [html, js] of [['ui/list.html', 'ui/list.js'], ['ui/m.html', 'ui/m.js']]) {
    assert.match(fs.readFileSync(html, 'utf8'), /elevatedBadge\(c\)/, html)
    const code = fs.readFileSync(js, 'utf8')
    assert.match(code, /import \{ elevatedBadge \} from '\.\/lib\/elevated\.mjs'/, js)
    assert.match(code, /[ ,]elevatedBadge,/, js)
  }
})
