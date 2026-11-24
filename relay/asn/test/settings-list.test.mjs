// #1853 設定值清單（docs/設定值清單.md）的守門測試。
// 清單要列出「電腦設定頁會送出的每個指令」「手機偏好的每個鍵」「設定頁的每個分類」；
// 這裡的標準答案一律從程式來源直接取得（import），不在測試裡手抄一份鍵名：
// 新增設定沒登記就變紅；清單裡寫了程式已經沒有的也變紅；預設值欄跟程式裡的標籤對不上也變紅。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SETTING_OPS } from '../ui/lib/settings-panel.mjs'
import { SETTING_CATS } from '../ui/lib/settings-cats.mjs'
import { MOBILE_SETTING_KEYS } from '../ui/lib/mobile-settings.mjs'
import { DEFAULT_PREFS, normalizePrefs } from '../ui/lib/mobile.mjs'
import { AGENT_INSTALL_UI } from '../ui/lib/device-state.mjs'
import { DEFAULT_DIMS, DIMS } from '../ui/lib/dims.mjs'
import { DEFAULT_SKIN, SKIN_LABEL } from '../ui/lib/skin.mjs'
import { FRAME_LABEL, CLOSE_LABEL, NOTIFY_ITEMS, normalizeFrame, normalizeClose, notifyFromSaved } from '../ui/lib/prefs.mjs'
import { MODE_LABEL, DP_LABEL, BUBBLE_LABEL, TOOLBAR_LABEL, DEFAULT_LOOK, normalizeMode } from '../ui/lib/merge.mjs'
import { DEFAULT_CFG, STT_LANG_LABEL, STT_MODEL_LABEL } from '../ui/lib/voice-prefs.mjs'
import { normalizeLaunchPrefs } from '../ui/lib/launch-prefs.mjs'
import { autoCheckFromSaved } from '../ui/lib/update.mjs'

const ROOT = new URL('../', import.meta.url)
const DOC = new URL('../../../docs/設定值清單.md', import.meta.url)

// 清單的標準解析：每個以 | 開頭的連續區塊是一張表；只認表頭有「指令／鍵」的表，標記只從那一欄取
export function parseList(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const rows = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('|') || !lines[i].includes('指令／鍵')) continue
    const cut = l => l.split(/(?<!\\)\|/).slice(1, -1).map(c => c.trim())
    const head = cut(lines[i])
    for (let j = i + 2; j < lines.length && lines[j].startsWith('|'); j++) {
      const cells = cut(lines[j])
      rows.push({ head, cells, line: j + 1, tokens: [...cells[0].matchAll(/`([^`]+)`/g)].map(m => m[1]) })
    }
  }
  return rows
}

const doc = fs.readFileSync(DOC, 'utf8')
const rows = parseList(doc)
const allTokens = rows.flatMap(r => r.tokens)
const rowOf = tok => rows.find(r => r.tokens.includes(tok))
const col = (r, name) => r.cells[r.head.indexOf(name)]

test('#1853 清單表格：每列欄數與表頭一致、預設值欄不空、標記整份唯一', () => {
  assert.ok(rows.length > 60, `解析到的列數太少（${rows.length}），表頭格式變了？`)
  for (const r of rows) {
    assert.equal(r.cells.length, r.head.length, `第 ${r.line} 列欄數跟表頭不同`)
    assert.ok(r.tokens.length > 0, `第 ${r.line} 列第一欄沒有反引號標記`)
  }
  for (const r of rows.filter(x => x.head.includes('預設值'))) assert.ok(col(r, '預設值'), `第 ${r.line} 列預設值是空的`)
  const dup = allTokens.filter((t, i) => allTokens.indexOf(t) !== i)
  assert.deepEqual([...new Set(dup)], [], '標記重複：同一個設定只能有一列')
})

test('#1853 電腦設定頁的每個指令（SETTING_OPS）都在清單裡；清單裡的指令程式都還有', () => {
  const have = new Set(allTokens)
  for (const op of SETTING_OPS) assert.ok(have.has(op), `設定值清單缺指令 ${op}（新增設定要一起登記）`)
  const ops = new Set(SETTING_OPS)
  const prefixed = /^(prefs|cat|flag|app)\./
  for (const t of allTokens.filter(t => !prefixed.test(t))) assert.ok(ops.has(t), `設定值清單寫了程式已經沒有的指令 ${t}`)
})

test('#1853 手機偏好的每個鍵（DEFAULT_PREFS／normalizePrefs）都在清單裡；預設值跟程式一致', () => {
  const keys = new Set([...Object.keys(DEFAULT_PREFS), ...Object.keys(normalizePrefs({}))])
  assert.ok(keys.size >= 6, '手機偏好鍵取得太少')   // 6 個：震動×2、自動檢查、推播、外觀、釘選（#1776 拿掉 ghRefs）
  for (const k of keys) {
    const r = rowOf(`prefs.${k}`)
    assert.ok(r, `設定值清單缺手機偏好 prefs.${k}（新增手機偏好要一起登記）`)
    const dv = normalizePrefs({})[k]
    if (typeof dv === 'boolean') assert.ok(col(r, '預設值').startsWith(dv ? '開' : '關'), `prefs.${k} 預設值應為${dv ? '開' : '關'}`)
    if (k === 'skin') assert.ok(col(r, '預設值').includes(SKIN_LABEL[dv]), 'prefs.skin 預設值')
  }
  for (const t of allTokens.filter(t => t.startsWith('prefs.'))) assert.ok(keys.has(t.slice(6)), `設定值清單寫了程式已經沒有的手機偏好 ${t}`)
})

test('#1853 設定頁的每一類（SETTING_CATS）都在分類總表；手機有沒有跟 MOBILE_SETTING_KEYS 一致', () => {
  for (const c of SETTING_CATS) {
    const r = rowOf(`cat.${c.key}`)
    assert.ok(r, `分類總表缺 ${c.key}（${c.title}）`)
    assert.equal(col(r, '標題'), c.title, `${c.key} 標題`)
    assert.equal(col(r, '電腦'), '有')
    assert.equal(col(r, '手機').startsWith('有'), MOBILE_SETTING_KEYS.includes(c.key), `${c.key} 手機欄跟 MOBILE_SETTING_KEYS 不一致`)
  }
  const keys = new Set(SETTING_CATS.map(c => c.key))
  for (const t of allTokens.filter(t => t.startsWith('cat.'))) assert.ok(keys.has(t.slice(4)), `分類總表寫了不存在的分類 ${t}`)
})

test('#1853 旗標 AGENT_INSTALL_UI 的目前值跟清單一致', () => {
  const r = rowOf('flag.AGENT_INSTALL_UI')
  assert.ok(r, '設定值清單缺旗標 AGENT_INSTALL_UI')
  assert.ok(col(r, '預設值').includes(`目前：${AGENT_INSTALL_UI ? '開' : '關'}`), '旗標目前值跟清單不一致（翻旗標要改清單）')
})

test('#1853 預設值欄跟程式裡的預設與標籤逐字一致', () => {
  const dv = tok => { const r = rowOf(tok); assert.ok(r, `缺 ${tok}`); return col(r, '預設值') }
  const label = k => DIMS.find(d => d.key === k).label
  assert.ok(dv('tabDim').includes(label(DEFAULT_DIMS.tabDim)), 'tabDim')
  assert.ok(dv('groupDim').includes(label(DEFAULT_DIMS.groupDim)), 'groupDim')
  assert.ok(dv('skin').includes(SKIN_LABEL[DEFAULT_SKIN]), 'skin')
  assert.ok(dv('frame').includes(FRAME_LABEL[normalizeFrame(undefined)]), 'frame')
  assert.ok(dv('closeTo').includes(CLOSE_LABEL[normalizeClose(undefined)]), 'closeTo')
  assert.ok(dv('mode').includes(MODE_LABEL[normalizeMode(undefined)]), 'mode')
  assert.ok(dv('dpMode').includes(DP_LABEL[DEFAULT_LOOK.dpMode]), 'dpMode')
  assert.ok(dv('bubble').includes(BUBBLE_LABEL[DEFAULT_LOOK.bubble]), 'bubble')
  assert.ok(dv('toolbar').includes(TOOLBAR_LABEL[DEFAULT_LOOK.toolbar]), 'toolbar')
  const n = notifyFromSaved({})
  assert.ok(NOTIFY_ITEMS.every(i => n[i.key] === true), '通知預設不是全開了，清單要改')
  assert.ok(dv('notify').startsWith('全開'), 'notify')
  assert.ok(dv('voice-save').includes(STT_LANG_LABEL[DEFAULT_CFG.stt_lang]) && dv('voice-save').includes(STT_MODEL_LABEL[DEFAULT_CFG.stt_model]), 'voice-save')
  assert.ok(dv('launch-max').startsWith(String(normalizeLaunchPrefs(null).maxPerHour)), 'launch-max')
  assert.ok(dv('autoCheck').startsWith(autoCheckFromSaved(undefined) ? '開' : '關'), 'autoCheck')
})

test('#1853 「誰會讀它」引用的 檔案:行號，檔案存在、行號沒超出', () => {
  let checked = 0
  for (const r of rows) {
    const cell = r.cells[r.head.indexOf('誰會讀它')] ?? ''
    for (const m of cell.matchAll(/((?:ui|src-tauri)\/[\w./-]+\.(?:mjs|js|rs|html)):(\d+)/g)) {
      const f = new URL(m[1], ROOT)
      assert.ok(fs.existsSync(f), `第 ${r.line} 列引用的檔案不存在：${m[1]}`)
      const n = fs.readFileSync(f, 'utf8').split('\n').length
      assert.ok(Number(m[2]) >= 1 && Number(m[2]) <= n, `第 ${r.line} 列引用的行號超出檔案：${m[1]}:${m[2]}（共 ${n} 行）`)
      checked++
    }
  }
  assert.ok(checked > 50, `檢查到的引用太少（${checked}）`)
})
