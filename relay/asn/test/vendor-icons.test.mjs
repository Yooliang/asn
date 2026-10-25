import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { modelVendorKey, vendorIconSvg } from '../ui/lib/vendor-icons.mjs'

const DOC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/ASN-VENDOR-ICONS.md')

test('廠商圖示：gemini 與 grok 不同、皆為 SVG', () => {
  const g = vendorIconSvg('gemini')
  const k = vendorIconSvg('grok')
  assert.notEqual(g, k)
  assert.match(g, /^<svg/)
  assert.match(k, /^<svg/)
})

test('依廠商分頁：ASN 自己那一格用小機器人（logo.svg），不是「其他」的三個點', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../ui/list.html'), 'utf8')
  const asn = html.indexOf(`d.vendorKey === 'asn'" src="img/logo.svg"`)
  const generic = html.indexOf('v-html="vendorIcon(d.vendorKey)"')
  assert.ok(asn > 0, '要有 ASN 專用的機器人分支')
  assert.ok(asn < generic, 'ASN 分支要排在一般廠商圖示之前，否則會先落到三個點')
})

test('授權文件存在且提到 CC0', () => {
  const t = fs.readFileSync(DOC, 'utf8')
  assert.match(t, /CC0/)
  assert.match(t, /vendor-icons/)
})

test('模型對廠商：提供者／模型編號都認得，經轉接（openrouter）看模型名，對不到回 null', () => {
  const cases = {
    'anthropic/claude-sonnet-4': 'claude', 'openai/gpt-5': 'gpt', 'openai-codex/gpt-5-codex': 'gpt', 'google/gemini-2.5-pro': 'gemini',
    'google-vertex/gemini-2.5-flash': 'gemini', 'xai/grok-4': 'grok', 'deepseek/deepseek-chat': 'deepseek', 'minimax/MiniMax-M2': 'minimax',
    'openrouter/deepseek/deepseek-chat': 'deepseek', 'claude-opus-4': 'claude', 'gpt-4.1': 'gpt', 'o3-mini': 'gpt', 'gemini-2.5-pro': 'gemini', 'abab6.5': 'minimax',
  }
  for (const [m, k] of Object.entries(cases)) assert.equal(modelVendorKey(m), k, m)
  for (const m of ['', null, undefined, 'local/llama-3', 'ollama/qwen3', 'someone/other-model', 'o', 'orange']) assert.equal(modelVendorKey(m), null, String(m))
})
