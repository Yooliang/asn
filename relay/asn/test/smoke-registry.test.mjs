// 冒煙探測登記表（#1540）：每個探測一個檔、自動收集；新增探測只加檔，不改 smoke-lib 的分派與 smoke-ui.test 的遮罩條件
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PROBE_DIR, findProbe, loadProbes, probeFiles, probeHas, validateProbe, withProbeScenarios, withProbeTables } from '../scripts/smoke-registry.mjs'
import { PROBES, SCENARIOS, probeEntry, probeKind, probeSource, maskProbeSource, tableFor } from '../scripts/smoke-lib.mjs'

test('smoke-probes 底下每個檔都登記成一個探測，key 不重複、跟檔名一致', () => {
  const files = probeFiles()
  assert.ok(files.length >= 50, `至少 50 個探測檔，現在 ${files.length}`)
  assert.equal(PROBES.length, files.length)
  assert.deepEqual(PROBES.map(e => e.key + '.mjs'), files)
  assert.equal(new Set(PROBES.map(e => e.key)).size, PROBES.length)
})

test('探測檔不 import smoke-lib（smoke-lib 載入時會等登記表，互相等會卡住）', () => {
  for (const f of probeFiles()) {
    const src = fs.readFileSync(path.join(PROBE_DIR, f), 'utf8')
    assert.doesNotMatch(src, /from ['"][^'"]*smoke-lib\.mjs['"]/, f)
    assert.doesNotMatch(src, /import\(['"][^'"]*smoke-lib\.mjs['"]\)/, f)
  }
})

test('每個情境最多對到一個探測：檔名順序不影響結果', () => {
  for (const s of SCENARIOS) {
    if (!s.probe) continue
    const hits = PROBES.filter(e => probeHas(e, s.probe)).map(e => e.key)
    assert.ok(hits.length <= 1, `${s.name} 同時對到 ${hits.join('、')}`)
  }
})

test('分派照登記表：有登記的用該探測，沒登記的是遮罩檢查', () => {
  const s = SCENARIOS.find(x => x.probe?.devSel)
  assert.equal(probeEntry(s.probe).key, 'devSel')
  assert.equal(probeKind(s.probe), '手機設備列點選才展開檢查')
  const mask = SCENARIOS.find(x => x.name === 'list-dialog-mask')
  assert.equal(probeEntry(mask.probe), undefined)
  assert.equal(probeKind(mask.probe), '遮罩檢查')
  assert.equal(probeSource(mask.probe), maskProbeSource(mask.probe))
  // updDl: 0 是「下載 0%」，不是沒設：要對到下載中的探測
  assert.equal(probeEntry({ updDl: 0 }).key, 'updDl')
  // kind 可以依 probe 變：手機看終端的三種
  assert.equal(probeKind({ mtermview: true }), '手機看終端檢查')
  assert.equal(probeKind({ mtermview: true, statusLine: true }), '手機看終端狀態列檢查')
  assert.equal(probeKind({ mtermview: true, swipe: true }), '手機看終端左右滑檢查')
})

test('每個登記的探測都有情境在用（拆檔沒有掉情境）', () => {
  const used = new Set(SCENARIOS.filter(s => s.probe).map(s => probeEntry(s.probe)?.key).filter(Boolean))
  assert.deepEqual(PROBES.map(e => e.key).filter(k => !used.has(k)), [])
})

test('探測檔格式不對就在載入時講清楚是哪個檔', () => {
  assert.throws(() => validateProbe(null, 'a.mjs'), /a\.mjs.*export default/)
  assert.throws(() => validateProbe({ kind: 'x', source: () => '' }, 'b.mjs'), /b\.mjs.*缺 key/)
  assert.throws(() => validateProbe({ key: 'k', kind: 1, source: () => '' }, 'c.mjs'), /kind/)
  assert.throws(() => validateProbe({ key: 'k', kind: 'x', source: 'no' }, 'd.mjs'), /source/)
  assert.throws(() => validateProbe({ key: 'k', kind: 'x', source: () => '', scenarios: {} }, 'e.mjs'), /scenarios/)
  assert.throws(() => validateProbe({ key: 'k', kind: 'x', source: () => '', table: {} }, 'f.mjs'), /table/)
})

test('新增探測只要加一個檔：自動收集、帶自己的情境與假後台欄位；key 重複會擋下', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-probes-'))
  try {
    fs.writeFileSync(path.join(dir, 'zNew.mjs'), [
      "export default {",
      "  key: 'zNew', kind: '新探測檢查', source: probe => `(() => ({ ok: ${probe.zNew === 2}, why: '' }))()`,",
      "  scenarios: [{ name: 'list-znew', page: 'list.html', state: { signedIn: true, zNew: true }, ready: '#app', probe: { zNew: 2 }, shot: 'list-znew.png' }],",
      "  table: (scenario, t) => (scenario.state.zNew ? { relay_send: { seq: 9 }, seen_before: 'relay_list' in t } : undefined),",
      "}",
    ].join('\n'))
    const entries = await loadProbes(dir)
    assert.deepEqual(entries.map(e => e.key), ['zNew'])
    const base = [{ name: 'old', probe: null, state: {} }]
    const all = withProbeScenarios(base, entries)
    assert.deepEqual(all.map(s => s.name), ['old', 'list-znew'])
    assert.equal(findProbe(entries, all[1].probe).kind, '新探測檢查')
    assert.match(findProbe(entries, all[1].probe).source(all[1].probe), /ok: true/)
    const t0 = { relay_list: { members: [] } }
    const t1 = withProbeTables(t0, all[1], entries)
    assert.deepEqual(t1, { relay_list: { members: [] }, relay_send: { seq: 9 }, seen_before: true })
    assert.deepEqual(t0, { relay_list: { members: [] } }, '不改傳進來的表')
    assert.equal(withProbeTables(t0, all[0], entries), t0, '別的情境不受影響')
    fs.writeFileSync(path.join(dir, 'zNew2.mjs'), "export default { key: 'zNew', kind: 'x', source: () => '' }\n")
    await assert.rejects(loadProbes(dir), /key 重複：zNew/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('拆檔時搬家的探測都沒有自帶情境或假後台欄位；之後新加的才用新格式（#1512 A 的 usageMenu、B 的 termKeys、C 的 relogin、C2 的 usableAt、#1530 的 msgRef、#1557 的 tmAdopt）', () => {
  assert.deepEqual(PROBES.filter(e => e.table || e.scenarios).map(e => e.key), ['msgRef', 'relogin', 'termKeys', 'tmAdopt', 'usableAt', 'usageMenu'])
  assert.equal(typeof tableFor(SCENARIOS[0]), 'object')
})
