// ai_cli_detect 回傳的欄位形狀（#394 追查）：Rust ToolDetectRow 的欄位是 binary_found，前端讀 .installed 永遠是 false，
// 本機「經 pi」從 0.1.91 起一直反灰。測試一律用後端真的欄位形狀，不要自己捏 installed。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { MODEL_CATALOG, cliInstalled, modelUiRow, toolFound } from '../ui/lib/partner.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

// 從 Rust 結構定義讀出欄位名（serde 沒改名＝JSON 就是這個名字），測試資料照它組
const rust = read('src-tauri/src/agent_tools/types.rs')
const row = /pub struct ToolDetectRow \{([^}]*)\}/.exec(rust)[1]
const fields = [...row.matchAll(/pub (\w+):/g)].map(m => m[1])
const detect = (id, found) => Object.fromEntries(fields.map(f => [f, f === 'id' ? id : f === 'binary_found' ? found : typeof f === 'string' && f.endsWith('_available') ? false : '']))

test('後端偵測列的欄位是 binary_found、沒有 installed，也沒有用 serde 改名', () => {
  assert.ok(fields.includes('binary_found'), fields.join(','))
  assert.ok(!fields.includes('installed'))
  assert.doesNotMatch(row + rust.slice(0, rust.indexOf('pub struct ToolDetectRow')), /serde\(rename/)
})

test('cliInstalled／modelUiRow 讀得到真的偵測結果（pi 有裝＝true、沒裝＝false、沒這筆＝false）', () => {
  const tools = { pi: detect('pi', true), claude: detect('claude', false) }
  assert.equal(cliInstalled(tools, 'pi'), true)
  assert.equal(cliInstalled(tools, 'claude'), false)
  assert.equal(cliInstalled(tools, 'grok'), false)
  assert.equal(cliInstalled(null, 'pi'), false)
  assert.equal(toolFound({ cmd: 'C:/x/pi.cmd' }), true, '舊格式 cmd 也算')
  const pi = MODEL_CATALOG.find(m => m.id === 'pi')
  assert.equal(modelUiRow(pi, tools.pi).installed, true)
})

test('守門：list.js 不准再直接讀偵測資料的 .installed（要走 cliInstalled）', () => {
  const js = read('ui/list.js')
  assert.doesNotMatch(js, /cliTools\.value(\.\w+|\[[^\]]+\])\?*\.installed/)
  assert.equal((js.match(/cliInstalled\(cliTools\.value, 'pi'\)/g) ?? []).length, 2, '經 pi 的廠商列與運行選項兩處')
})
