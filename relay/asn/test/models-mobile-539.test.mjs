// #539 之四：模型清單共用（switchModelsFor）、開新夥伴選型號；手機對話頁不放按鈕列，管理項目都在「⋯」
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CLAUDE_ALIAS_MODELS, launchModelChoices, switchModelsFor } from '../ui/lib/model-catalog.mjs'
import { CLAUDE_ALIAS_LABEL } from '../ui/lib/remote-models.mjs'
import { createModelSwitcher } from '../ui/lib/model-switch.mjs'
import { acpSwitchChoices, opDialogText } from '../ui/lib/partner-ops-ui.mjs'
import * as mobileOps from '../ui/lib/mobile-ops.mjs'
import { ACP_ONLY_OPS, PHONE_LEAD_OPS, phoneModels, phoneOpApplies, phoneOpsRows } from '../ui/lib/mobile-ops.mjs'
import { manageItems } from '../ui/lib/archive.mjs'
import { headerPsm } from '../ui/lib/tasks.mjs'
import { MODEL_RE } from '../ui/lib/partner-ops.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

test('switchModelsFor：Claude 只有別名（fable、opus、sonnet）、Gemini 不再寫死（向本機讀）、pi 原樣回傳查到的、其他回空（手動輸入）', () => {
  assert.equal(switchModelsFor('claude'), CLAUDE_ALIAS_MODELS)
  assert.equal(switchModelsFor('Claude'), CLAUDE_ALIAS_MODELS, '大小寫不拘')
  assert.deepEqual(CLAUDE_ALIAS_MODELS.map(m => m.id), ['fable', 'opus', 'sonnet'])
  for (const m of CLAUDE_ALIAS_MODELS) { assert.match(m.id, MODEL_RE); assert.ok(m.label) }
  assert.deepEqual(switchModelsFor('gemini'), [], '清單改向本機讀，不寫死')
  const pi = [{ provider: 'xai', model: 'grok-4.7' }]
  assert.equal(switchModelsFor('pi', { piModels: pi }), pi)
  assert.deepEqual(switchModelsFor('pi'), [])
  for (const e of ['grok', 'codex', 'acp', '', undefined]) assert.deepEqual(switchModelsFor(e), [], String(e))
})

test('切換模型與手機都讀 switchModelsFor：Claude 選單、手機清單同一份', () => {
  assert.deepEqual(createModelSwitcher({ transport: {} }).models, switchModelsFor('claude'))
  assert.deepEqual(phoneModels().map(m => m.id), switchModelsFor('claude').map(m => m.id))
  assert.deepEqual(phoneModels('gemini'), [], '手機的 Gemini 清單等 #2355 P4 接上，目前退回輸入框')
})

test('內建通道切換模型：Gemini 有清單（預設目前的，不在清單就第一個）；Grok 沒清單＝手動輸入', () => {
  const gem = { node: 'H', agent: '小格', engine: 'gemini', model: 'gemini-3.8-flash-low' }
  const list = [{ id: 'gemini-a', label: 'A' }, { id: 'gemini-3.8-flash-low', label: 'F' }]
  assert.deepEqual(acpSwitchChoices(gem, { list }), { models: list, selected: 'gemini-3.8-flash-low' })
  assert.equal(acpSwitchChoices({ ...gem, model: '' }, { list }).selected, 'gemini-a')
  assert.deepEqual(acpSwitchChoices(gem), { models: [], selected: '' }, '沒讀到清單（手機、別台、讀不到）＝輸入框')
  assert.deepEqual(acpSwitchChoices({ ...gem, engine: 'grok' }).models, [])
  assert.deepEqual(acpSwitchChoices({ node: 'H', agent: 'c' }).models, [], 'Claude 不走這條')
  assert.deepEqual(acpSwitchChoices(null).models, [])
  assert.doesNotMatch(opDialogText('model', '小格', '', 'acp', { hasList: true }).lead, /請輸入/, '有清單就不叫人輸入代號')
  assert.match(opDialogText('model', '小格', '', 'acp').lead, /請輸入模型代號/)
})

test('開新夥伴選型號：Claude 開成視窗放別名、Gemini 內建通道向本機讀；其他不出現', () => {
  const c = launchModelChoices('claude', 'term', { engine: 'claude' })
  assert.equal(c.show, true); assert.equal(c.kind, 'aliases')
  assert.deepEqual(c.models.map(m => m.id), ['fable', 'opus', 'sonnet'])
  for (const m of c.models) assert.ok(m.label.endsWith(CLAUDE_ALIAS_LABEL), `別名要標「${CLAUDE_ALIAS_LABEL}」：${m.label}`)
  assert.deepEqual(launchModelChoices('gemini', 'acp', { engine: 'acp' }), { show: true, kind: 'list', vendor: 'gemini', models: [], note: '' })
  for (const [v, r] of [['claude', 'pi'], ['gemini', 'term'], ['grok', 'acp'], ['codex', 'term'], ['pi', 'pi'], ['', '']]) {
    const x = launchModelChoices(v, r, { engine: 'claude' })
    assert.equal(x.show, false, `${v}/${r}`); assert.deepEqual(x.models, [])
  }
})

test('開新夥伴接線：第 2 頁有型號下拉（預設不指定），本機開時帶 model', () => {
  const html = read('ui/list.html'), js = read('ui/list.js')
  assert.match(html, /<label class="partner-model-pick" v-else-if="launchModel\.show">型號[\s\S]*?<option value="">不指定（照預設）<\/option>[\s\S]*?v-for="m in launchModel\.models"/)
  assert.match(js, /launchModelChoices\(dlgRow\.value\?\.id, dlgAuto\.value\.run, \{ engine: localProfileEngine\(partnerDlg\.profile, remoteLaunchers\.value\[info\.node\]\) \}\)/)
  assert.match(js, /if \(!launchModelOnThisPc\.value\) return \{ \.\.\.c, show: false/, '別台電腦照舊不出（P4 才做）')
  assert.match(js, /localLaunchRequest\(dlgAuto\.value, \{[^}]*model: launchModelPick\.value,/, '選了型號就帶進送出內容')
  assert.match(read('ui/lib/auto-run.mjs'), /\.\.\.\(model \? \{ model \} : \{\}\)/, '有選才帶 model')
  assert.match(read('ui/lib/partner-ops-ui.mjs'), /<label class="op-field" v-if="op === 'model' && acpView\.models\.length">模型/)
  assert.match(read('src-tauri/src/launch/mod.rs'), /pub model: String,/)
})

const F = (over = {}) => ({ id: 'H/小文', node: 'H', agent: '小文', nick: '小文', status: 'idle', ...over })
const OPS = { machines: { H: { online: true, launcher: {} } }, loaded: true, signedIn: true }

test('手機「⋯」選單：喚醒、切換模型排最前面，其餘照原順序；不列前台／後台', () => {
  assert.deepEqual(PHONE_LEAD_OPS, ['resume', 'model'])
  const items = [{ key: 'console' }, { key: 'info' }, { key: 'rename' }, { key: 'model' }, { key: 'close' }, { key: 'handover' }, { key: 'resume' }, { key: 'archive' }]
  assert.deepEqual(phoneOpsRows(items).map(i => i.key), ['resume', 'model', 'info', 'rename', 'close', 'handover', 'archive'])
  assert.deepEqual(phoneOpsRows([{ key: 'info' }, { key: 'close' }]).map(i => i.key), ['info', 'close'], '沒有喚醒／切換模型就照原樣')
  assert.deepEqual(phoneOpsRows(null), [])
  assert.deepEqual(phoneOpsRows([null, { key: 'info' }]).map(i => i.key), ['info'])
  const orig = items.map(i => i.key)
  phoneOpsRows(items)
  assert.deepEqual(items.map(i => i.key), orig, '不改動傳進來的陣列')
})

const keys = rows => rows.map(i => i.key)
test('手機「⋯」實際項目：永遠用不到的不列，暫時不能用的反灰寫原因', () => {
  // 在線 Claude：沒有喚醒、重開、移除；前兩項是切換模型、詳情
  const on = phoneOpsRows(manageItems(F(), OPS), F())
  assert.deepEqual(keys(on), ['model', 'info', 'rename', 'close', 'handover', 'archive'])
  assert.deepEqual(on.slice(0, 2).map(i => [i.label, i.ok]), [['切換模型', true], ['詳情', true]])
  // 離線 Claude：喚醒（可按）、切換模型（反灰寫原因）排最前；改名等暫時不能用也反灰
  const offF = F({ status: 'offline' })
  const off = phoneOpsRows(manageItems(offF, OPS), offF)
  assert.deepEqual(off.slice(0, 2).map(i => [i.key, i.label, i.ok]), [['resume', '喚醒', true], ['model', '切換模型', false]])
  assert.match(off[1].reason, /離線/)
  assert.equal(off.some(i => ACP_ONLY_OPS.includes(i.key)), false)
  assert.ok(off.filter(i => i.key !== 'resume' && i.key !== 'archive' && i.key !== 'info').every(i => !i.ok && i.reason))
  // 內建通道（ACP）：有重開、移除，沒有喚醒（在線、離線都一樣）
  const acp = F({ engine: 'gemini' }), acpOff = F({ engine: 'gemini', status: 'offline' })
  assert.deepEqual(keys(phoneOpsRows(manageItems(acp, OPS), acp)), ['model', 'info', 'rename', 'close', 'handover', 'restart', 'remove', 'archive'])
  assert.equal(phoneOpsRows(manageItems(acpOff, OPS), acpOff).some(i => i.key === 'resume'), false)
  // pi：離線才有喚醒；沒有重開、移除；還沒開放的（詳情、換班接手）照舊反灰
  const pi = F({ engine: 'pi' }), piOff = F({ engine: 'pi', status: 'offline' })
  const piRows = phoneOpsRows(manageItems(pi, OPS), pi)
  assert.deepEqual(keys(piRows), ['model', 'info', 'rename', 'close', 'handover', 'archive'])
  assert.equal(piRows.find(i => i.key === 'info').ok, false)
  assert.equal(keys(phoneOpsRows(manageItems(piOff, OPS), piOff))[0], 'resume')
  // 雲端代理：沒有視窗可管理，只剩封存
  const cloud = F({ engine: 'grok-cloud', kind: 'grok' })
  assert.deepEqual(keys(phoneOpsRows(manageItems(cloud, OPS), cloud)), ['archive'])
  // 沒給 friend：只排序、只拿掉前台／後台
  assert.equal(phoneOpApplies('restart', null), true); assert.equal(phoneOpApplies('console', null), false)
})

test('大按鈕列的手機版已拿掉：mobile-ops 不再匯出格子／圖示，mobile-bar.mjs 刪除', () => {
  for (const k of ['phoneBarSlots', 'BAR_ICON', 'slotTip', 'GROUP_SLOT_LABEL', 'PHONE_MOVED_OPS', 'BAR_LABEL']) assert.equal(k in mobileOps, false, k)
  assert.equal(fs.existsSync(new URL('../ui/lib/mobile-bar.mjs', import.meta.url)), false)
  assert.doesNotMatch(read('ui/mobile.css'), /\.m-abar|\.m-abtn/)
})

test('手機接線：對話頁不放任何按鈕列（手機版、電腦版都沒有）；⋯ 在；ACP 有型號下拉；群組／邀請排在管理項目之後', () => {
  const mhtml = read('ui/m.html'), mjs = read('ui/m.js'), pane = read('ui/lib/chatpane.mjs')
  assert.match(mhtml, /<chat-pane [^>]*:no-bar="true"/, '手機對話頁關掉上方功能列')
  assert.doesNotMatch(mhtml, /phone-bar|barView|onBar/)
  assert.doesNotMatch(mjs, /barView|onBar|phoneBarSlots/)
  assert.doesNotMatch(pane, /mobile-bar|MobileBar|phoneBar/)
  assert.match(pane, /noBar: \{ type: Boolean, default: false \}/, '電腦版預設照舊有功能列')
  assert.match(pane, /<action-bar [^>]*v-if="!noBar && !isNotice && \(!isRoom/, 'noBar 時電腦版的功能列也不出現')
  assert.match(mhtml, /aria-label="更多操作" v-if="opsItems\.length \|\| groupItems\.length" @click="openOps"/)
  assert.match(mhtml, /v-else-if="opsAcp\.models\.length" v-model="ops\.model"/)
  assert.ok(mhtml.indexOf('v-for="i in opsView.rows"') < mhtml.indexOf('v-for="g in groupItems"'), '喚醒、切換模型在選單最前面，邀請排後面')
  assert.match(pane, /class="tool icon call" type="button" v-if="showCallBtn && !displayOnly"/, '通話鈕照舊在輸入列')
})

test('個人訊息的「背景工作 N 件」：手機（noBar）保留，電腦版照舊拿掉', () => {
  const pane = read('ui/lib/chatpane.mjs')
  assert.match(pane, /const toPsm = computed\(\(\) => \(props\.friend\?\.room === true \|\| props\.noBar \? props\.friend\?\.psm \?\? '' : headerPsm\(props\.friend\?\.psm\)\)\)/)
  assert.equal(headerPsm('demo・背景工作 3 件'), 'demo', '電腦版照舊剝')
  assert.equal(headerPsm('demo・背景工作 1 件・閒置 2 件'), 'demo', '電腦版連閒置那段一起剝（#1368）')
  assert.match(read('ui/m.html'), /<template v-if="chatFriend\.psm"> · <span v-html="emo\(chatFriend\.psm\)"><\/span><\/template>/, '手機標頭直接顯示個人訊息（含件數）')
})
