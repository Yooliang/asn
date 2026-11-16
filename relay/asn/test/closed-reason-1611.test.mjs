// 「沒開放遠端管理」要說清楚是哪個原因、去哪裡改（#1611）：電腦端把原因句放在名單回報的 launch_closed_reason，前端照原因句或短句顯示。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLOSED_REASONS, REASON, closedWhy, menuItems } from '../ui/lib/partner-ops.mjs'
import { WHY_MAX, briefWhy } from '../ui/lib/partner-menu.mjs'
import { machinesByNode } from '../ui/lib/mobile-launch.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const asnRoot = path.join(here, '..')
const read = rel => fs.readFileSync(path.join(asnRoot, rel), 'utf8')

const friend = { id: 'P/claude', node: 'P', agent: 'claude', nick: 'claude', status: 'idle', engine: 'claude', kind: 'claude' }
const ctxOf = extra => ({ machines: machinesByNode({ machines: [{ node: 'P', online: true, launcher: null, ...extra }] }), loaded: true, signedIn: true })
const renameOf = ctx => menuItems(friend, ctx).find(i => i.key === 'rename')

test('三種原因：反灰原因就是那台回報的原因句', () => {
  for (const r of Object.values(CLOSED_REASONS)) {
    assert.equal(closedWhy({ launch_closed_reason: r }), r)
    const it = renameOf(ctxOf({ launch_closed_reason: r }))
    assert.equal(it.ok, false)
    assert.equal(it.reason, r)
  }
})

test('舊電腦（沒帶原因）、空字串、只有空白：維持泛用說法', () => {
  for (const extra of [{}, { launch_closed_reason: null }, { launch_closed_reason: '' }, { launch_closed_reason: '   ' }]) {
    assert.equal(closedWhy(extra), REASON.closed)
    assert.equal(renameOf(ctxOf(extra)).reason, REASON.closed)
  }
  assert.equal(closedWhy(undefined), REASON.closed)
})

test('不認得的原因文字：加上「這台設備不開放開新夥伴：」照它寫的顯示', () => {
  const r = '自己寫的原因'
  assert.equal(closedWhy({ launch_closed_reason: r }), `這台設備不開放開新夥伴：${r}`)
  assert.equal(renameOf(ctxOf({ launch_closed_reason: r })).reason, `這台設備不開放開新夥伴：${r}`)
})

test('開放中（有 launcher）不受影響，就算殘留舊原因也照開放處理', () => {
  const it = renameOf(ctxOf({ launcher: { profiles: [] }, launch_closed_reason: CLOSED_REASONS.noCwd }))
  assert.equal(it.ok, true)
})

test('長句講去哪裡改；短句 20 字內', () => {
  assert.match(CLOSED_REASONS.noConsent, /設定 → 視窗與系統匣，勾「允許我的其他設備替這台開新視窗」/)
  assert.match(CLOSED_REASONS.noProfile, /找不到 Claude/)
  assert.match(CLOSED_REASONS.noCwd, /設定 → 啟動設定，在「工作資料夾白名單」加上資料夾/)
  const want = { noConsent: '那台沒勾開新視窗的允許', noProfile: '那台還找不到 Claude', noCwd: '那台白名單是空的' }
  for (const [k, short] of Object.entries(want)) {
    assert.equal(briefWhy(CLOSED_REASONS[k]), short)
    assert.ok([...short].length <= WHY_MAX)
  }
  assert.equal(briefWhy(REASON.closed), '這台電腦沒開放遠端管理', '泛用說法的短句照舊')
})

test('跨語言一致：launcher.rs 的原因句常數與前端常數表逐字相同', () => {
  const rs = read('src-tauri/src/bridge/launcher.rs')
  const grab = name => {
    const m = rs.match(new RegExp(`pub const ${name}: &str = "([^"]*)";`))
    assert.ok(m, `launcher.rs 找不到 ${name}`)
    return m[1]
  }
  assert.equal(grab('CLOSED_NO_CONSENT'), CLOSED_REASONS.noConsent)
  assert.equal(grab('CLOSED_NO_PROFILE'), CLOSED_REASONS.noProfile)
  assert.equal(grab('CLOSED_NO_CWD'), CLOSED_REASONS.noCwd)
  // 電腦端三種失敗要真的對到這三句（分類函式沒被改壞）
  assert.match(rs, /Some\(NO_CONFIG\) => Some\(CLOSED_NO_CONSENT\)/)
  assert.match(rs, /Some\(NO_REMOTE_PROFILE\) \| Some\(crate::launch::config::ERR_NO_SETUP\) => Some\(CLOSED_NO_PROFILE\)/)
  assert.match(rs, /Some\(NO_CWD\) \| Some\(crate::launch::config::ERR_CWD_ALLOW_EMPTY\) => Some\(CLOSED_NO_CWD\)/)
  // 兩句 loader 的錯誤字要是 config.rs 的常數，且 loader 真的用它們出錯（不是各寫各的字）
  const cfg = read('src-tauri/src/launch/config.rs')
  assert.match(cfg, /Err\(ERR_CWD_ALLOW_EMPTY\.into\(\)\)/)
  assert.match(cfg, /unwrap_or_else\(\|\| ERR_NO_SETUP\.into\(\)\)/)
})

test('roster 上報：平台與原因兩鍵一起送；launcher 欄仍是摘要或 null（原因不放進去）', () => {
  const core = read('src-tauri/src/bridge/core.rs')
  assert.match(core, /body\["platform"\] = json!\(crate::relay::platform_name\(\)\)/)
  assert.match(core, /body\["launch_closed_reason"\] = json!\(closed_reason\)/)
})

test('「允許」的字樣統一：舊的「允許遠端開視窗與管理視窗」不再出現在程式與機器橋', () => {
  const OLD = '允許遠端開視窗與管理視窗'
  const roots = [path.join(asnRoot, 'src-tauri', 'src'), path.join(asnRoot, 'ui'), path.join(asnRoot, '..', 'machine')]
  const hits = []
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'target' || e.name === '.git') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(rs|mjs|js|html|css|md|json)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes(OLD)) hits.push(path.relative(asnRoot, p))
    }
  }
  roots.forEach(walk)
  assert.deepEqual(hits, [])
})
