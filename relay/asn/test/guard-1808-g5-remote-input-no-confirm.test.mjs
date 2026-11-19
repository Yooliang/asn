// #1808 第 5 組守門：別台要在這台打字——確認框卡住、規則反覆改（復發單號：#1303 #1305 #1649 #1703 #1704 #1705 #1745 #1747）
//
// 一直被弄壞的那條規則：別台在這台打字，唯一的關卡是設定頁「允許遠端在這台打字」開關（預設開）；
// 打字的路上不能有任何「等人按」的系統確認框——系統訊息框從程式外面關不掉，沒人按的框會佔著位子，
// 之後每次打字請求都被秒拒（#1303／#1703），而且查不到時的退路判斷又各寫一份（#1705）。
// 0.2.33（#1745／#1747）整套拿掉確認框；這支測試鎖住「不准再長回來」。
// 讀的是真的 Rust 與前端原始碼（src-tauri/src、ui），不是另外造的清單。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
const read = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
/** Rust 檔去掉測試區塊（#[cfg(test)] 之後）：只看正式程式 */
const prod = f => read(f).split('#[cfg(test)]')[0]
const rsFiles = walk(path.join(root, 'src-tauri/src')).filter(f => f.endsWith('.rs'))
const rel = f => path.relative(path.join(root, 'src-tauri/src'), f).replace(/\\/g, '/')

test('#1303 #1703 #1745 系統確認框（message dialog）只在兩個地方出現，遠端打字的路徑上一個都沒有', () => {
  const hits = rsFiles.filter(f => /\.dialog\(\)\s*\n?\s*\.message\(/.test(prod(f))).map(rel).sort()
  // input_consent.rs＝勾「允許這支手機替這台登入」前問本人；presence.rs＝沒有 Hello 時確認是本人。兩者都有逾時，不在打字路上
  assert.deepEqual(hits, ['input_consent.rs', 'presence.rs'], '新增了系統確認框：遠端打字的路上不准有等人按的框（#1745）')
  for (const f of ['view_stream.rs', 'view_remote.rs', 'view_handshake.rs']) {
    const src = prod(path.join(root, 'src-tauri/src', f))
    assert.ok(!/\.dialog\(\)|show_with_result|input_consent::ask\(/.test(src), `${f} 不能彈框`)
  }
  const lib = read(path.join(root, 'src-tauri/src/lib.rs'))
  const poller = lib.split('fn start_view_poller(')[1]?.split('\n}\n')[0] ?? ''
  assert.ok(poller.length > 500, '找得到 start_view_poller')
  assert.ok(!/input_consent::ask\(|confirm_input|view_still_pending/.test(poller), '打字的分支不問人、不等人')
})

test('#1305 #1703 唯一還在的確認框：同時只開一個，但位子由 Drop 放開（不靠框被關掉），而且逾時會回 false', () => {
  const src = prod(path.join(root, 'src-tauri/src/input_consent.rs'))
  const fn = src.split('pub async fn ask_login_ok(')[1] ?? ''
  assert.match(fn, /impl Drop for Done \{[\s\S]*ASKING\.store\(false/, '位子在 Drop 時放開：函式一結束（含逾時）就放，框還留在畫面上也不會卡住下一次')
  assert.match(fn, /tokio::time::timeout\(std::time::Duration::from_secs\(ASK_SECS\), rx\)/, '有逾時')
  assert.match(fn, /Ok\(Ok\(true\)\)\)\s*\n\}/, '逾時、關掉、取消都回 false；只有按「允許」才是 true')
  assert.match(src, /pub const ASK_SECS: u64 = 60;/)
})

test('#1649 #1745 開關是唯一關卡：預設開、舊後端沒有欄位也當開著；舊的「不用每次問」設定直接忽略', () => {
  const bridge = read(path.join(root, 'src-tauri/src/bridge/mod.rs'))
  assert.match(bridge, /remote_input: !s\.remote_input_off/, '存的是「關」，沒有檔案或沒有欄位就是開')
  const list = read(path.join(root, 'ui/list.js'))
  assert.match(list, /remoteInput: true/, '畫面預設開')
  assert.match(list, /remoteInput: s\.remote_input !== false/, '後端沒回欄位也當開')
  // 舊資料裡 #1289／#1649 的欄位：讀進來不影響任何事
  const dev = read(path.join(root, 'src-tauri/src/device_id.rs'))
  assert.match(dev, /input_no_ask／input_confirmed／input_always_ask 讀進來直接忽略/)
})

test('#1704 #1745 畫面不再聽確認框的事件、也沒有等確認的提示字（前端 ui 全掃）', () => {
  const stale = ['input-consent-', 'input_consent_', '要打字權限', '可能要按允許', '那邊的人要同意', '先設免問']
  const hits = []
  for (const f of walk(path.join(root, 'ui'))) {
    if (!/\.(m?js|html)$/.test(f) || f.includes('vendor')) continue
    const t = read(f)
    for (const w of stale) if (t.includes(w)) hits.push(`${rel(f)}：${w}`.replace(/^\.\.\/\.\.\/ui\//, 'ui/'))
  }
  assert.deepEqual(hits, [])
})

test('#1705 打字被拒的結束原因都有白話：input_off、held_prompt 不能掉成「沒成功」', () => {
  const rs = read(path.join(root, 'src-tauri/src/view_remote.rs'))
  const text = key => rs.match(new RegExp(`"${key}" => "([^"]*)"`))?.[1]
  assert.ok(text('input_off')?.includes('允許遠端在這台打字'), 'input_off 要告訴對方去哪裡打開')
  assert.ok(text('held_prompt')?.startsWith('對方畫面出現需要本人確認的框'), 'held_prompt（#1705 的退路）有說明')
})
