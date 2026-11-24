// #1808 第 15 組守門：夥伴卡在 CLI 某個畫面，ASN 沒認出也沒通知（復發單號：#1254 #1512 #1632 #1637 #1640 #1792 #1799）
//
// 一直被弄壞的那條規則：夥伴停在需要人處理的畫面時，ASN 要「認得出（偵測）→ 分類成固定代號 → 名單與提醒都有一句白話」，
// 而且偵測用的字串要和 Claude Code 真的畫面一致。每遇到一種新畫面，這條鏈要同時補三處（Rust 偵測的種類與代號、名單說明、前端提醒文字），
// 漏一處就是「卡著沒人知道」：#1254 Held message、#1512 額度選單、#1632 首次確認、#1792 登入逾時，都是這樣一個一個補。
//
// 這支測試從真的原始碼讀出「畫面種類」清單，三處必須同步；偵測字串要在 src-tauri/tests/fixtures 的真畫面樣本裡找得到
// （Claude Code 改字，或字串打錯，偵測就靜默失效）。之後新增一種畫面，漏登記任何一處都會在這裡紅。
//
// #1792（登入逾時）已在 #1795 進 main，最後一支測試鎖住它的辨認規則；#1799（提醒框沒有可動手的路）還沒有 PR，進 main 後再補。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { noticeText, viewHint } from '../ui/lib/partner-notice.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))

const screen = read('src-tauri/src/launch/claude_screen.rs')
const prod = screen.split('#[cfg(test)]')[0]
const catalogSrc = read('src-tauri/src/launch/screen_catalog.rs').split('#[cfg(test)]')[0]

/** 畫面種類（Rust enum 的每個變體） */
const kinds = [...prod.split('pub enum ClaudeScreenKind {')[1].split('\n}\n')[0].matchAll(/^\s{4}([A-Z][A-Za-z]+),/gm)].map(m => m[1])
/** 唯一的清單（Rust SCREEN_CATALOG）：種類 → 固定代號 */
const codeOf = Object.fromEntries([...catalogSrc.matchAll(/kind: K::([A-Za-z]+),\s*code: "([a-z_]+)"/g)].map(m => [m[1], m[2]]))

test('#1813 #1254 #1512 #1632 #1792 每一種畫面種類在唯一的清單（screen_catalog.rs）都有一列；提醒文字由它產出的檔案提供', () => {
  assert.ok(kinds.length >= 10, `讀得到畫面種類：${kinds}`)
  const noCode = kinds.filter(k => !codeOf[k])
  assert.deepEqual(noCode, [], 'SCREEN_CATALOG 沒有這一列的種類（代號、名單說明、提醒都從這一列來）')
  assert.deepEqual(Object.keys(codeOf).filter(k => !kinds.includes(k)).sort(), [], '清單有已經不存在的種類')
  // 前端檔案（由 Rust 清單產出）的代號要和清單完全一致；內容一致由 Rust 測試「前端清單檔和_rust_清單一致」守
  const gen = read('ui/lib/stuck-screens.mjs')
  assert.deepEqual([...gen.matchAll(/\{ code: "([a-z_]+)", label:/g)].map(m => m[1]), Object.values(codeOf), 'stuck-screens.mjs 和 Rust 清單的代號不一致')
  // #1799：認不得種類的選單（attention）不跳提醒，只寫 ui.log；其餘種類都要有提醒文字（本人不在電腦前也能知道）
  const noNotice = kinds.filter(k => codeOf[k] !== 'attention' && !noticeText({ code: codeOf[k], name: '甲' }))
  assert.deepEqual(noNotice, [], '沒有提醒文字的種類')
  assert.equal(noticeText({ code: 'attention', name: '甲' }), null)
  for (const k of kinds.filter(k => codeOf[k] !== 'attention')) {
    const n = noticeText({ code: codeOf[k], name: '甲' })
    assert.match(n.title + n.body, /[一-鿿]/)
    assert.ok(n.body.includes('「甲」') && !n.body.includes('{name}'), `${codeOf[k]} 的提醒要換成夥伴名`)
    assert.doesNotMatch(n.title + n.body, /[a-z]+_[a-z_]+|HTTP/, `${codeOf[k]} 的提醒不能秀內部代號`)
  }
})

test('#1813 只有一份來源：status_code、名單 screen_label、前端提醒都不准再寫死畫面代號的清單', () => {
  const codes = Object.values(codeOf)
  // status_code 與 screen_label 只能轉呼叫清單，函式本體不能有任何代號字串
  const statusBody = prod.split('pub fn status_code(')[1].split('\n}\n')[0]
  assert.match(statusBody, /screen_catalog::code_of\(kind\)/)
  const roster = read('src-tauri/src/bridge/roster.rs').split('#[cfg(test)]')[0]
  const labelBody = roster.split('fn screen_label(')[1].split('\n}\n')[0]
  assert.match(labelBody, /screen_catalog::label_of\(code\)/)
  for (const [what, body] of [['status_code', statusBody], ['screen_label', labelBody]]) {
    assert.deepEqual(codes.filter(c => body.includes(`"${c}"`)), [], `${what} 不准寫死代號`)
  }
  // 前端：提醒與終端提示只能讀 stuck-screens.mjs
  const pn = read('ui/lib/partner-notice.mjs')
  assert.match(pn, /from '\.\/stuck-screens\.mjs'/)
  assert.ok(!/NOTICES\s*=\s*\{|VIEW_HINTS\s*=\s*\{/.test(pn), 'partner-notice 不准再自己列提醒或提示的清單')
  // 其他檔案：同一個檔案裡不准出現三個以上的畫面代號當作表格的鍵（Rust 的 `"code" =>`、前端的 `code:`）。
  // 例外：清單本身、產出檔；trust／bypass_warning 兩種在別處各只有一行用途不同的說明（term-entry、stuck_notice），不到三個
  const hits = []
  const scan = (file, text) => {
    const src = text.split('#[cfg(test)]')[0]
    const arms = new Set([...src.matchAll(/"([a-z_]+)"\s*(?:\|\s*"[a-z_]+"\s*)*=>/g)].map(m => m[1]).filter(c => codes.includes(c)))
    const keys = new Set([...src.matchAll(/^\s*([a-z_]+):\s*(?:name\s*=>|'|`)/gm)].map(m => m[1]).filter(c => codes.includes(c)))
    if (arms.size >= 3 || keys.size >= 3) hits.push(`${file}：${[...arms, ...keys]}`)
  }
  for (const f of walk(path.join(root, 'src-tauri/src')).filter(f => f.endsWith('.rs') && !f.endsWith('screen_catalog.rs'))) scan(path.relative(root, f), fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'))
  for (const f of walk(path.join(root, 'ui')).filter(f => /\.(mjs|js)$/.test(f) && !f.endsWith('stuck-screens.mjs'))) scan(path.relative(root, f), fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'))
  assert.deepEqual(hits, [], '這些檔案又自己列了一份畫面代號的清單：改成從 screen_catalog 查')
})

test('#1512 #1254 #1632 偵測用的字串都在真實畫面樣本裡找得到（Claude Code 改字或字串打錯就會紅）', () => {
  const samples = walk(path.join(root, 'src-tauri/tests/fixtures')).filter(f => f.endsWith('.txt')).map(f => fs.readFileSync(f, 'utf8'))
  assert.ok(samples.length >= 20, `樣本數 ${samples.length}`)
  const consts = {}
  for (const m of prod.matchAll(/^(?:pub )?const ([A-Z_]+): &str = "([^"\n]+)";/gm)) consts[m[1]] = m[2]
  // 這幾個是各種畫面的辨認字：種類 ↔ 常數
  const need = { TrustFolder: ['TRUST_YES', 'TRUST_NO'], BypassWarning: ['BYPASS_YES'], Login: ['LOGIN_MENU', 'LOGIN_EXPIRED'], UsageLimit: ['USAGE_LIMIT'], UsageMenu: ['USAGE_MENU_TITLE', 'USAGE_MENU_FOOTER', 'USAGE_STOP', 'USAGE_WAIT'], HeldMessage: ['HELD_TITLE'], Question: ['QUESTION_FOOTER'] }
  const missing = []
  for (const [kind, names] of Object.entries(need)) {
    assert.ok(kinds.includes(kind), `種類 ${kind} 還在`)
    for (const n of names) {
      assert.ok(consts[n], `找得到常數 ${n}`)
      // USAGE_WAIT 在真畫面裡後面還接「at …」，所以用「包含」比對
      if (!samples.some(s => s.includes(consts[n]))) missing.push(`${kind}：${n}＝「${consts[n]}」`)
    }
  }
  assert.deepEqual(missing, [], '這些辨認字沒有任何真實（或依真實截圖轉錄）的樣本支持')
})

test('#1640 #1637 卡在首次確認畫面：終端畫面上的提示（viewHint）與提醒用同一組代號，不能有只在一處出現的', () => {
  // viewHint 是「畫面開著時」的一行提示；它認得的代號必須是 status_code 的子集，且至少涵蓋要人回答的幾種
  for (const code of ['permission', 'trust', 'bypass_warning', 'usage_menu', 'held_message']) {
    assert.ok(viewHint([{ code, name: '甲' }], '甲'), `${code} 在終端畫面上要有提示`)
    assert.ok(Object.values(codeOf).includes(code), `${code} 是 Rust 認得的代號`)
  }
})

// ---- #1792 登入逾時：「Login reached its time limit」只認行首，AI 回覆裡出現同一句話不能誤判 ----
/** 取 Rust 函式本體 */
const fnBody = (src, sig) => src.split(sig)[1].split('\n}\n')[0]
/** 取 Rust 字串陣列常數的所有字串 */
const strArray = (src, name) => [...src.match(new RegExp(`const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\]`))[1].matchAll(/"([^"]*)"/g)].map(m => m[1])
/** 照 Rust 的 is_login_time_limit 移植的 JS 版：只用來拿真畫面句子對辨認字（heads），守不到 Rust 的行為——Rust 本體靠下面的原始碼寫法比對守住，真正的行為測試由 #1820 補 */
const portIsLimit = (line, heads) => {
  const t = line.trimStart()
  if (t.startsWith('●')) return false
  const lower = t.replace(/[A-Z]/g, c => c.toLowerCase())
  const rest = (lower.startsWith('⎿') ? lower.slice(1) : lower).trimStart()
  return heads.some(h => rest.startsWith(h))
}

test('#1792 登入逾時：Rust 原始碼用行首比對、轉小寫、排除 ● 開頭（靜態守門）；JS 移植版拿真畫面句子對辨認字（守不到 Rust 行為）', () => {
  const heads = strArray(prod, 'LOGIN_TIME_LIMIT_HEADS')
  assert.deepEqual(heads, ['login reached its time limit', 'failed to authenticate: this login reached its time limit'])
  // 原始碼本體：行首比對、先排除 ● 開頭的模型回覆，不能出現包含比對
  const body = fnBody(prod, 'fn is_login_time_limit(')
  assert.match(body, /let t = line\.trim_start\(\);/, '先去行首空白')
  assert.match(body, /if t\.starts_with\('●'\) \{\s*return false;\s*\}/, '● 開頭（模型回覆）直接不算')
  assert.match(body, /let lower = t\.to_ascii_lowercase\(\);/, '轉小寫再比：大小寫不敏感（真畫面是「Login reached…」、辨認字是小寫）')
  assert.match(body, /lower\.strip_prefix\('⎿'\)\.unwrap_or\(lower\.as_str\(\)\)\.trim_start\(\)/, '去掉 ⎿ 與其後空白')
  assert.match(body, /strip_prefix\('⎿'\)/)
  assert.match(body, /LOGIN_TIME_LIMIT_HEADS\.iter\(\)\.any\(\|h\| rest\.starts_with\(h\)\)/)
  assert.ok(!/\.contains\(|\.find\(/.test(body), '不能用包含比對：AI 回覆或文件引用這句話就會誤判成要登入')
  // Rust 測試裡那批真實句子（Claude Code 真的會顯示的四種）與誤判案例，直接取來跑，不另外造
  const t = screen.split('fn 登入逾時_認字不認行位置_暫時性的更新失敗不算登入')[1].split('\n    }\n')[0]
  const block = (from, to) => [...t.split(from)[1].split(to)[0].matchAll(/^\s+"((?:[^"\\]|\\.)*)",?$/gm)].map(m => m[1].replace(/\\"/g, '"'))
  const ok = block('for ok in [', '] {')
  const quoted = block('for quoted in [', '] {')
  const echo = block('for echo in [', '] {')
  assert.equal(ok.length, 4)
  assert.ok(quoted.length >= 2 && echo.length >= 2)
  for (const l of ok) assert.ok(portIsLimit(l, heads), `該認：${l}`)
  for (const l of [...quoted, ...echo]) assert.ok(!portIsLimit(l, heads), `不該認：${l}`)
  // AI 回覆（● 開頭）引用同一句，連原樣的錯誤句也不算
  assert.ok(!portIsLimit('● Login reached its time limit · Please run /login', heads))
  assert.ok(!portIsLimit('● 這句是「Failed to authenticate: this login reached its time limit」的意思', heads))
  // 暫時性的更新失敗不是登入逾時
  assert.ok(!portIsLimit('Could not refresh your login because another Claude Code process is refreshing it (or exited mid-refresh) · Try again', heads))
  // 登入逾時歸在既有的 Login 種類（代號 login），名單與提醒文字不用另外登記
  assert.equal(codeOf.Login, 'login')
})
