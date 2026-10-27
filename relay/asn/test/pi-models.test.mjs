// #351 開新夥伴「經 pi」：廠牌→提供者、能不能經 pi、模型清單、開 pi 參數。資料形狀照 asn西川 #748 的 pi 1.4.0 實測。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VENDOR_PI_PROVIDER, PI_ONLY_VENDORS, cleanPiModels, piChoiceFor, piOnlyVendorRows, piLaunchArgs } from '../ui/lib/pi-models.mjs'

const MODELS = [
  { provider: 'anthropic', model: 'claude-x', thinking: 'yes', images: 'yes' },
  { provider: 'xai', model: 'grok-4.7', thinking: 'yes', images: 'no' },
  { provider: 'deepseek', model: 'deepseek-v4-pro' },
  { provider: 'minimax', model: 'MiniMax-M3' },
  { provider: 'openai-codex', model: 'gpt-x' },
]
const READY = { anthropic: 'ready', xai: 'ready', deepseek: 'ready', minimax: 'ready', 'openai-codex': 'ready', google: 'not_ready', qwen: 'provider_not_found' }

test('廠牌對應 pi 提供者；只能經 pi 的是 DeepSeek、MiniMax（Qwen 這版 pi 沒有）', () => {
  assert.equal(VENDOR_PI_PROVIDER.claude, 'anthropic')
  assert.equal(VENDOR_PI_PROVIDER.grok, 'xai')
  assert.equal(VENDOR_PI_PROVIDER.codex, 'openai-codex')
  assert.deepEqual(PI_ONLY_VENDORS.map(v => v.id), ['deepseek', 'minimax'])
  assert.ok(!Object.hasOwn(VENDOR_PI_PROVIDER, 'qwen') && !Object.hasOwn(VENDOR_PI_PROVIDER, 'gemini'))
})

test('清單整理：去掉壞資料、重複、怪字元；thinking／images 認 yes 或 true', () => {
  const c = cleanPiModels([...MODELS, MODELS[0], { provider: 'x;rm -rf', model: 'a' }, { provider: 'xai', model: '' }, null, { provider: 'xai', model: 'a b' }])
  assert.equal(c.length, MODELS.length)
  assert.deepEqual(c[0], { provider: 'anthropic', model: 'claude-x', thinking: true, images: true })
  assert.deepEqual(cleanPiModels('oops'), [])
})

test('能經 pi：提供者 ready 且有模型；預設選第一個模型', () => {
  const g = piChoiceFor('grok', MODELS, READY)
  assert.deepEqual([g.ok, g.provider, g.defaultModel, g.models.length], [true, 'xai', 'grok-4.7', 1])
})

test('不能經 pi 時寫原因：沒登入、這版 pi 沒有、沒列出模型、Gemini 不建議、不認得的廠牌', () => {
  assert.match(piChoiceFor('claude', [], { anthropic: 'not_ready' }).why, /還沒登入 anthropic.*\/login/)
  assert.match(piChoiceFor('deepseek', MODELS, { deepseek: 'provider_not_found' }).why, /這版 pi 沒有/)
  assert.match(piChoiceFor('minimax', [], { minimax: 'ready' }).why, /沒有列出/)
  assert.match(piChoiceFor('claude', [], {}).why, /還沒登入/, '沒查到狀態又沒模型：當作沒登入')
  assert.match(piChoiceFor('gemini', MODELS, READY).why, /不建議/)
  assert.equal(piChoiceFor('qwen', MODELS, READY).ok, false)
})

test('只能經 pi 的廠牌：pi 列得到模型才出現', () => {
  assert.deepEqual(piOnlyVendorRows(MODELS, READY).map(v => v.id), ['deepseek', 'minimax'])
  assert.deepEqual(piOnlyVendorRows(MODELS.filter(m => m.provider !== 'minimax'), READY).map(v => v.id), ['deepseek'])
  assert.ok(piOnlyVendorRows(MODELS, READY).every(v => v.viaPiOnly))
})

test('開 pi 參數：模型一定要在這次查到的清單裡，否則不送', () => {
  assert.deepEqual(piLaunchArgs('grok', 'grok-4.7', MODELS, READY), { provider: 'xai', model: 'grok-4.7' })
  assert.equal(piLaunchArgs('grok', 'grok-9', MODELS, READY), null, '清單外的模型')
  assert.equal(piLaunchArgs('grok', 'claude-x', MODELS, READY), null, '別家的模型')
  assert.equal(piLaunchArgs('gemini', 'x', MODELS, READY), null)
})

test('後端 pi_providers 格式轉換（#363）：missing＝這版 pi 沒有；unknown 與壞資料不放', async () => {
  const { providerStates } = await import('../ui/lib/pi-models.mjs')
  const m = providerStates([{ provider: 'anthropic', state: 'ready' }, { provider: 'google', state: 'not_ready' }, { provider: 'qwen', state: 'missing' }, { provider: 'xai', state: 'unknown' }, { provider: 'x;y', state: 'ready' }, null])
  assert.deepEqual(m, { anthropic: 'ready', google: 'not_ready', qwen: 'provider_not_found' })
  assert.deepEqual(providerStates('oops'), {})
  assert.equal(cleanPiModels([{ provider: 'anthropic', model: 'opus[1m]' }]).length, 1, '模型名可以有方括號（跟後端 safe_name 一致）')
})

test('接線（#351）：經 pi 開新夥伴一律用 pi 的啟動設定，帶 piLaunchArgs 驗過的提供者與模型；清單外不送；打開對話框才查、60 秒內不重查', async () => {
  const fs = await import('node:fs')
  const js = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  const html = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  const submit = js.slice(js.indexOf('async function submitPartnerDlg'), js.indexOf('async function submitTermViaDialog'))
  assert.ok(submit.includes("partnerRunChoice.value === 'pi' ? piLaunchArgs("), '送出前先過 piLaunchArgs')
  assert.ok(submit.includes("profile: 'pi'") && submit.includes('pi_provider: viaPi.provider') && submit.includes('pi_model: viaPi.model'), '帶 pi_provider／pi_model')
  assert.ok(submit.includes("throw new Error('pi 的模型清單裡沒有這個模型"), '清單外不送')
  assert.ok(js.includes('if (Date.now() - piInfo.at < 60_000) return'), '60 秒內不重查')
  assert.ok(js.includes('piReady: PI_VIA_READY && piChoice.value.ok'), 'runOptions 的 piReady 看 pi 自己回答的狀態')
  assert.ok(html.includes('v-model="partnerDlg.piModel"') && html.includes('v-for="m in piChoice.models"'), '第 2 頁列 pi 的模型')
})

test('接線（#351）：DeepSeek、MiniMax 以「只能經 pi」列進開新夥伴廠牌；選廠牌照 vendor 找，不會跟 pi 搞混', async () => {
  const fs = await import('node:fs')
  const js = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  const html = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  assert.ok(js.includes('piOnlyVendorRows(piInfo.models, piInfo.providers)'), '只列 pi 列得到的')
  assert.ok(js.includes("const dlgVendors = computed(() => (PI_VIA_READY ? [...vendorRows(dlgModels.value), ...piOnlyRows.value] : dlgModels.value))"))
  assert.ok(js.includes('partnerDlg.vendor && dlgVendors.value.find(m => m.id === partnerDlg.vendor)'), 'profile 都是 pi，靠 vendor 分辨')
  assert.ok(js.includes("partnerDlg.node === info.node"), '只在選這台時加')
  assert.ok(html.includes('on: partnerDlg.vendor ? partnerDlg.vendor === m.id : partnerDlg.profile === m.profileId'))
})
