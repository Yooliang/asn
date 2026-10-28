// #443／#444：pi「切換模型」改用這台 pi 列得出來的模型給下拉選單；可以跨廠商；拿不到清單（別台、手機）退回輸入框
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { PI_MODEL_REMOTE_NOTE, piModelChoices, piModelWire } from '../ui/lib/partner-ops.mjs'

const MODELS = [
  { provider: 'minimax', model: 'MiniMax-M2.7' }, { provider: 'minimax', model: 'MiniMax-M3.1-Flash' },
  { provider: 'openai-codex', model: 'gpt-6' }, { provider: 'anthropic', model: 'claude-sonnet-5' },
  { provider: 'weird', model: 'a:b@c' },   // 後台的模型欄位收不下（: @）：不列
]

test('列出所有已登入的提供者（可以跨廠商），依提供者分組；送不出去的不列', () => {
  const c = piModelChoices(MODELS, 'minimax/MiniMax-M3.1-Flash')
  assert.deepEqual(c.groups.map(g => g.provider), ['minimax', 'openai-codex', 'anthropic'])
  assert.deepEqual(c.groups[0].options, [{ value: 'minimax/MiniMax-M2.7', label: 'MiniMax-M2.7' }, { value: 'minimax/MiniMax-M3.1-Flash', label: 'MiniMax-M3.1-Flash' }])
  for (const o of c.groups.flatMap(g => g.options)) assert.ok(piModelWire(o.value), o.value)
  assert.equal(c.selected, 'minimax/MiniMax-M3.1-Flash', '預選它現在的模型')
  assert.equal(piModelChoices(MODELS, 'deepseek/x').selected, 'minimax/MiniMax-M2.7', '現在的不在清單：預選第一個')
  assert.deepEqual(piModelChoices([], '').groups, [])
})

test('接線：電腦版只有本機的 pi 視窗才查清單；選單外的不送；查不到退回輸入框並說明；手機照舊輸入框加說明', () => {
  const ui = fs.readFileSync(new URL('../ui/lib/partner-ops-ui.mjs', import.meta.url), 'utf8')
  assert.match(ui, /piModels: \{ type: Function, default: null \}/)
  assert.match(ui, /<optgroup v-for="g in pi\.groups"/)
  assert.match(ui, /PI_MODEL_PICK_ERR/)
  assert.match(ui, /v-else-if="op === 'model'">模型/, '查不到清單：輸入框')
  assert.match(fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8'), /:pi-models="opDlg\.friend\.node === selfNode \? transport\.piModels : null"/)
  assert.match(fs.readFileSync(new URL('../ui/m.html', import.meta.url), 'utf8'), /<p class="m-note" v-if="opsPiNote">\{\{ opsPiNote \}\}<\/p>/)
  assert.equal(PI_MODEL_REMOTE_NOTE, '這台的模型清單只能在那台電腦上看到，請照 pi 裡的名稱輸入')
})
