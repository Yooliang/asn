// 「把這台電腦上開著的終端納入管理」（#753、#757）：#1557 起從夥伴選單拿掉，改放在「設定 → 設備 → 這台電腦 → 工作管理員」。
// 功能本身和它的安全檢查照舊（同一個接手清單：候選窗格、接手、預設只能看、代答／代送要逐窗格允許），只換入口。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { managePanelItems, moreMenuItems, partnerMenuItems } from '../ui/lib/actionbar.mjs'
import { TEXT, canAdopt, viewRow } from '../ui/lib/task-manager.mjs'

const read = p => readFileSync(new URL(`../ui/${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('夥伴選單三個電腦版入口都沒有納入管理（它跟點到的那位夥伴無關）', () => {
  const ctx = { signedIn: true, loaded: true, machines: { H: { online: true, launcher: {} } } }
  for (const f of [{ node: 'H', agent: 'g', status: 'idle' }, { node: 'W', agent: 'g', status: 'offline' }, { node: 'H', agent: 'g', entryKind: 'term', status: 'idle' }]) {
    assert.ok(!partnerMenuItems(f, ctx).some(i => i.key === 'p:adopt'))
    assert.ok(!managePanelItems(f, ctx, []).some(i => i.key === 'p:adopt'))
    assert.ok(!moreMenuItems(f, { ops: ctx, selfNode: 'H', slots: {} }).some(i => i.key === 'p:adopt'))
  }
  const bar = read('lib/actionbar.mjs'), js = read('list.js')
  assert.doesNotMatch(bar, /adoptItem|withAdoptItem|op === 'adopt'/, 'actionbar 不再組這一項，也不再轉送')
  assert.doesNotMatch(js, /what === 'adopt'|it\.key === 'adopt'/, '名單視窗不再從選單打開接手清單')
})

test('工作管理員：自己開的、還沒交給 ASN 的那一列才有「納入管理」', () => {
  const now = 1_763_000_000_000
  const rows = {
    self_claude: { kind: 'claude', name: 'c', by_asn: false, pid: 11 },
    self_pi: { kind: 'pi', name: 'p', by_asn: false, pid: 12 },
    process: { kind: 'process', name: 'grok #3（前景）', pid: 13 },
    asn_claude: { kind: 'claude', name: 'a', by_asn: true, pid: 14 },
    adopted_term: { kind: 'terminal', engine: 'claude', by_asn: false, pid: 15, term_id: 't1' },
    asn_term: { kind: 'terminal', engine: 'claude', by_asn: true, pid: 16, term_id: 't2' },
    acp: { kind: 'acp', name: 'g', by_asn: true, pid: 0 },
    mux: { kind: 'mux', name: 'mux', pid: 17 },
    asn: { kind: 'asn', name: 'ASN', pid: 18 },
  }
  const want = { self_claude: true, self_pi: true, process: true, asn_claude: false, adopted_term: false, asn_term: false, acp: false, mux: false, asn: false }
  for (const [k, r] of Object.entries(rows)) {
    assert.equal(canAdopt(r), want[k], k)
    assert.equal(viewRow(r, now, {}).canAdopt, want[k], `${k}：畫面列帶同一個判斷`)
  }
  assert.equal(TEXT.adopt, '納入管理')
  assert.ok(TEXT.adoptTip.includes('預設只能看'))
})

test('接線：工作管理員那一列的按鈕送 tm-adopt，名單視窗打開同一個接手清單；「＋」選單不再有接手', () => {
  const panel = read('lib/settings-panel.mjs'), js = read('list.js'), html = read('list.html')
  assert.match(panel, /<button class="aero-btn tm-adopt" type="button" v-if="r\.canAdopt"[^>]*@click="act\('tm-adopt', r\.key\)">\{\{ TM\.adopt \}\}<\/button>/)
  assert.ok(panel.includes("'tm-adopt'"), '在設定面板允許的事件清單裡')
  assert.match(js, /case 'tm-adopt': void adoptLoad\(\); break/)
  const menu = html.slice(html.indexOf('class="av-menu launch-picker"'), html.indexOf('</ul>', html.indexOf('class="av-menu launch-picker"')))
  assert.ok(!menu.includes('adoptLoad'))
})
