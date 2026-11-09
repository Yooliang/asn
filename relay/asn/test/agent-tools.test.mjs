import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { AGENT_TOOLS, LAUNCH_TOOL_IDS, installStateLabel, toolById } from '../../shared/agent-tools.mjs'

test('共用清單與 issue23 偵測順序', () => {
  assert.deepEqual(LAUNCH_TOOL_IDS, ['claude', 'codex', 'agy', 'grok', 'pi'])
  assert.equal(toolById('agy').binary, 'agy')
  assert.ok(!AGENT_TOOLS.some(t => t.id === 'gemini'))
})

test('installStateLabel', () => {
  assert.equal(installStateLabel(false), '未安裝')
  assert.equal(installStateLabel(true), '已安裝')
})

test('Rust 端載入同一份 catalog.json', () => {
  const cat = fs.readFileSync(new URL('../../shared/agent-tools.catalog.json', import.meta.url), 'utf8')
  const rs = fs.readFileSync(new URL('../src-tauri/src/agent_tools/catalog.rs', import.meta.url), 'utf8')
  assert.ok(rs.includes('agent-tools.catalog.json'))
  const ids = JSON.parse(cat).tools.map(t => t.id)
  assert.deepEqual(ids, LAUNCH_TOOL_IDS)
})

test('#933：清單的 install 只剩 kind（verified／manual），沒有安裝腳本網址、沒有 npm 安裝；只有 Claude 是 verified', () => {
  const cat = JSON.parse(fs.readFileSync(new URL('../../shared/agent-tools.catalog.json', import.meta.url), 'utf8'))
  for (const t of cat.tools) {
    assert.deepEqual(Object.keys(t.install), ['kind'], t.id)
    assert.ok(['verified', 'manual'].includes(t.install.kind), t.id)
  }
  assert.deepEqual(cat.tools.filter(t => t.install.kind === 'verified').map(t => t.id), ['claude'])
})

test('#933 守衛：JS（橋、共用、雲端代理、畫面）也不能執行下載來的腳本或 npm 全域安裝', () => {
  const roots = ['../../machine', '../../shared', '../../cloud-agent', '../ui', '../scripts'].map(r => new URL(r + '/', import.meta.url))
  const bad = [/\|\s*iex\b/i, /\birm\s+['"]?https?:/i, /Invoke-Expression/i, /DownloadString/i, /\bcurl\b[^\n]*\|\s*(ba)?sh\b/, /\bwget\b[^\n]*\|\s*(ba)?sh\b/, /npm(\.cmd)?['"]?\s*,\s*\[\s*['"](install|i)['"]\s*,\s*['"]-g['"]/]   // npm 只抓「當成參數交給子程序」的寫法；說明文字裡提到 npm i -g 不算
  const hits = []
  let files = 0
  const walk = dir => {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'vendor') continue
      const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(mjs|js|cjs|html)$/.test(e.name)) continue
      files++
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
        for (const b of bad) if (b.test(line)) hits.push(`${p.pathname}:${i + 1} ${b}`)
      })
    }
  }
  roots.forEach(walk)
  assert.ok(files > 50, `守衛沒讀到程式（${files} 個檔）`)
  assert.deepEqual(hits, [])
})
