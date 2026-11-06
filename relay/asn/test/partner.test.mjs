import assert from 'node:assert/strict'
import test from 'node:test'
import { MODEL_CATALOG as sharedCatalog } from '../../shared/launcher-profiles.mjs'
import { MODEL_CATALOG as uiCatalog, RUN_OPTION_LABEL, customRunOptions } from '../ui/lib/model-catalog.mjs'
import { remoteModelRows } from '../ui/lib/partner-launch-ui.mjs'
import { defaultPartnerName, injectPendingGroups, pendingFriend, resolvePending } from '../ui/lib/partner.mjs'
import { bumpRecentCwd, cwdChoices, normalizeLaunchPrefs } from '../ui/lib/launch-prefs.mjs'

test('WebView 用 model-catalog 與 shared MODEL_CATALOG 一致', () => {
  assert.deepEqual(uiCatalog, sharedCatalog)
})

test('預設夥伴名字會遞增', () => {
  const friends = [{ nick: 'Gemini-1' }, { nick: 'Gemini-3' }]
  assert.equal(defaultPartnerName(friends, 'gemini'), 'Gemini-4')
})

test('啟動中列會插入名單分組', () => {
  const groups = [{ key: 'H', label: '家用', items: [] }]
  const p = pendingFriend({ node: 'H', device: '家用', name: 'Gemini-2', profileId: 'gemini', mode: 'background' })
  const out = injectPendingGroups(groups, [p])
  assert.equal(out[0].items[0].pending, true)
  assert.match(out[0].items[0].psm, /啟動中/)
})

test('上線後清掉啟動中', () => {
  const p = pendingFriend({ node: 'H', device: '家用', name: 'X', profileId: 'claude', mode: 'window' })
  const left = resolvePending([p], [{ id: 'H/X', nick: 'X' }])
  assert.equal(left.length, 0)
})

test('最近用過的工作資料夾', () => {
  const p = normalizeLaunchPrefs({ recentCwd: ['/a'], maxPerHour: 4 })
  const n = bumpRecentCwd(p, '/b')
  assert.deepEqual(n.recentCwd.slice(0, 2), ['/b', '/a'])
  assert.deepEqual(cwdChoices({ allow: ['/x'], recent: n.recentCwd }), ['/b', '/a', '/x'])
})

test('啟動設定記住顯示方式', () => {
  assert.equal(normalizeLaunchPrefs({ launchDisplay: 'background' }).launchDisplay, 'background')
  assert.equal(normalizeLaunchPrefs({ launchDisplay: 'weird' }).launchDisplay, 'foreground')
})

test('自訂設定的運行（#931）：只看那台回報的 mode，背景＝acp通道、其餘＝asn終端（原生 cli）；手機與電腦版同一份', () => {
  const rows = remoteModelRows({ profiles: [{ id: 'mine', label: '自訂視窗', mode: 'window' }, { id: 'bg', label: '自訂背景', mode: 'background' }] })
  const [w, b] = rows.map(customRunOptions)
  assert.equal(w.selected, 'term'); assert.deepEqual(w.options.map(o => [o.key, o.ok]), [['acp', false], ['term', true]]); assert.match(w.options[0].why, /不支援/)
  assert.equal(b.selected, 'acp'); assert.deepEqual(b.options.map(o => [o.key, o.ok]), [['acp', true], ['term', false]]); assert.match(b.options[1].why, /acp通道/)
  assert.deepEqual(w.options.map(o => o.label), [RUN_OPTION_LABEL.acp, RUN_OPTION_LABEL.term], '名稱跟四選一同一份')
  assert.equal(customRunOptions(undefined).selected, 'term')
  assert.equal(customRunOptions(null).options.length, 2)
})

test('三條通道（#351 第 1 步）：每個模型都有 term／acp／pi 的狀態與原因；兩份目錄一致；只是說明不改運行選項', async () => {
  const { channelRows, CHANNEL_STATUS_TEXT } = await import('../ui/lib/model-catalog.mjs')
  for (const m of uiCatalog) {
    const rows = channelRows(m)
    assert.deepEqual(rows.map(r => r.key), ['acp', 'pi', 'term'], `${m.id}：照優先序排（內建通道＞經 pi＞終端機）`)
    assert.ok(rows.filter(r => r.recommended).length <= 1, `${m.id} 最多一個建議`)
    for (const r of rows) { assert.ok(Object.hasOwn(CHANNEL_STATUS_TEXT, r.status), `${m.id}.${r.key} 的狀態 ${r.status}`); assert.ok(r.why, `${m.id}.${r.key} 要寫原因`) }
  }
  const by = id => channelRows(uiCatalog.find(m => m.id === id))
  assert.equal(by('gemini').find(r => r.key === 'acp').status, 'ok')
  assert.equal(by('grok').find(r => r.key === 'term').status, 'noinbox', '終端開得起來但收不到信')
  assert.equal(by('claude').find(r => r.key === 'acp').status, 'no', 'Claude 不支援 acp通道')
  assert.deepEqual(channelRows({ id: 'custom' }), [], '自訂設定沒有 channels')
  assert.equal(by('grok').find(r => r.recommended).key, 'acp', 'Grok 建議內建通道')
  assert.equal(by('pi').find(r => r.recommended).key, 'pi', 'pi 本身建議經 pi')
  assert.equal(by('claude').find(r => r.recommended), undefined, 'Claude 三條都不是「可用」：不標建議（它走自己的視窗加外掛）')
})
