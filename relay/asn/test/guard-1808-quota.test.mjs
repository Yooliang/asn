// #1808 守門（第 6 組：額度讀數不對）。測試名稱帶原 issue 號；刪掉原修正這些測試必須變紅。
// 歸屬判斷（#1184/#1340/#1694，換帳號後舊視窗的讀數記到哪個帳號）與送出前拿掉過期窗（#1212/#1260/#1321 客戶端）在 Rust，
// 這裡守的是畫面端（account-roster.mjs）：不能把舊讀數當現值、沒有 5 小時窗的帳號不能被舊 5 小時拖成「資料較舊」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rosterQuota, FIVE_ONLY_WEEKLY_TEXT } from '../ui/lib/account-roster.mjs'

const NOW = Date.parse('2026-11-18T12:00:00Z')
const MIN = 60_000, H = 60 * MIN
const iso = ms => new Date(ms).toISOString()
const W = 'bbbbbbbb-0000-4000-8000-000000000002', S = 'aaaaaaaa-0000-4000-8000-000000000001'
const nodeLabel = n => ({ [W]: '工作機', [S]: '家用機' })[n] ?? '未命名設備'
const win = (name, left, readAgo, o = {}) => ({ name, left_pct: left, resets_at: null, read_at: iso(NOW - readAgo), read_node: W, ...o })
const entry = (windows, o = {}) => ({ vendor: 'claude', account: 'u@x.test', plan: 'max', windows, seen_at: iso(NOW - H), seen_node: W, nodes: [{ node: W, current: true, reported_at: iso(NOW - H) }], ...o })
const q = (windows, o) => rosterQuota(entry(windows, o), { nodeLabel, now: NOW })

test('#1739 守門：Ultra 沒有 5 小時窗時，舊 5 小時不列、不標資料較舊、原位寫只回報每週', () => {
  // 後台還留著改方案前 4 小時前的 5 小時；每週剛更新
  const r = q([win('five_hour', 91, 4 * H, { resets_at: iso(NOW + H) }), win('weekly', 72, 5 * MIN)])
  assert.deepEqual(r.bars.map(b => b.label), ['每週'])
  assert.equal(r.stale, false)
  assert.equal(r.fiveNote, FIVE_ONLY_WEEKLY_TEXT)
  // 方案寫 Ultra 時，連看起來不太舊的 5 小時也不列
  const u = q([win('five_hour', 91, 40 * MIN), win('weekly', 72, 5 * MIN)], { plan: 'claude_ultra' })
  assert.deepEqual(u.bars.map(b => b.label), ['每週'])
  assert.equal(u.stale, false)
})

test('#1736 守門：有兩窗的帳號、不同電腦讀的舊 5 小時、每週也舊，仍照舊標「資料較舊」（不能矯枉過正）', () => {
  assert.equal(q([win('five_hour', 40, 5 * MIN), win('weekly', 72, 5 * MIN)]).stale, false)
  // 只比每週舊 35 分（1 小時內）：照舊標舊
  assert.equal(q([win('five_hour', 40, 40 * MIN), win('weekly', 72, 5 * MIN)]).stale, true)
  // 不同電腦讀的舊 5 小時＝換帳號前的舊視窗（#1688）
  assert.equal(q([win('five_hour', 40, 4 * H, { read_node: S }), win('weekly', 72, 5 * MIN)]).stale, true)
  assert.equal(q([win('weekly', 72, 8 * H)]).stale, true)
  // 其他廠牌不動
  const cx = rosterQuota(entry([win('five_hour', 40, 4 * H), win('weekly', 72, 5 * MIN)], { vendor: 'codex' }), { nodeLabel, now: NOW })
  assert.deepEqual(cx.bars.map(b => b.label), ['5 小時', '每週'])
})

test('#1688 守門：換帳號前開的舊視窗讀數不收，5 小時超過 30 分、每週超過 6 小時就標較舊並提示開新視窗', () => {
  assert.equal(q([win('five_hour', 40, 30 * MIN), win('weekly', 72, 30 * MIN)]).stale, false, '30 分鐘整還算新')
  const a = q([win('five_hour', 40, 31 * MIN), win('weekly', 72, 31 * MIN)])
  assert.equal(a.stale, true)
  assert.equal(a.ageLabel, '31 分鐘前')
  const w = q([win('five_hour', 40, MIN), win('weekly', 72, 6 * H + MIN)])
  assert.equal(w.stale, true)
  assert.equal(w.ageLabel, '6 小時前', '寫舊的那一窗的時間，不被新的蓋掉')
  assert.equal(q([win('five_hour', 40, MIN), win('weekly', 72, 6 * H)]).stale, false)
  const cx = rosterQuota(entry([win('w300', 40, 2 * H)], { vendor: 'codex' }), { nodeLabel, now: NOW })
  assert.equal(cx.ageLabel, '2 小時前')
})

test('#1689 守門：手機與設備卡的口徑——meta 標兩窗最舊的（#2111 不再有舊資料標籤）', () => {
  const r = q([win('five_hour', 40, 40 * MIN), win('weekly', 72, 5 * H)])
  assert.equal(r.meta, '5 小時前・工作機')
  assert.ok(!('oldText' in r))
})

test('#1321 守門：重置時間已過的窗不當現值，寫「已重置，待更新」、不進額度條', () => {
  const r = q([win('five_hour', 12, 20 * MIN, { resets_at: iso(NOW - MIN) }), win('weekly', 72, 5 * MIN, { resets_at: iso(NOW + 72 * H) })])
  assert.ok(r.parts.some(p => p.includes('已重置，待更新')), r.parts.join('|'))
  assert.deepEqual(r.bars.map(b => b.label), ['每週'])
  assert.equal(r.text, '每週剩 72%')
})
