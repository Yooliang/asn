// #1881／#1882 守門：使用者看得到的「哪台設備」只認後台記的名字；名字空白時用同一套辨認線索，不拿電腦主機名稱、不另外發明名字。
//   1. 登入失效通知（#1881）：Rust 送出去的欄位不帶電腦主機名稱；後台那一半的實跑測試在 login_alert_device_name_1881_sql.test.mjs
//   2. 原生授權框、紅條、勾選登入的確認框（#1882）：名字空白寫「電腦（代號末 4 碼）」／「手機（…）」，不再寫「未命名的電腦」「這支手機」
//   3. 辨認線索的寫法與介面（ui/lib/device-identity.mjs 的 unnamedClue）一致：同一個節點代號，Rust 與介面寫出同一串字
// 拿掉修正（把主機名稱塞回通知、把「未命名的電腦」寫回原生視窗）這裡就會變紅。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rust = f => fs.readFileSync(new URL(`../relay/asn/src-tauri/src/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
// 只看正式程式：把 #[cfg(test)] 之後的測試區切掉，並去掉註解
const prod = src => { const i = src.search(/#\[cfg\(test\)\]\s*mod tests/); return (i >= 0 ? src.slice(0, i) : src).replace(/^\s*\/\/.*$/gm, '') }

test('#1881 登入失效通知不帶電腦主機名稱：Notice／NoticeCtx 沒有 computer 欄位、payload 沒有 computer 鍵', () => {
  const p = prod(rust('login_watch.rs'))
  assert.doesNotMatch(p, /\bcomputer\b/, 'login_watch.rs 正式程式不該再有 computer（主機名稱）')
  assert.doesNotMatch(prod(rust('lib.rs')), /computer:\s*account::computer_name/, '呼叫端不再塞主機名稱給通知')
  assert.match(p, /json!\(\{ "last_at": self\.last_at, "email": self\.email, "timeouts": self\.timeouts \}\)/)
})

test('#1882 原生視窗不再寫「未命名的電腦」「這支手機」，名字空白一律走 unnamed_clue', () => {
  for (const f of ['consent.rs', 'input_consent.rs']) {
    const p = prod(rust(f))
    assert.doesNotMatch(p, /未命名的電腦|這支手機"/, `${f} 正式程式不該有自己發明的空白名字`)
    assert.match(p, /unnamed_clue\(/, `${f} 要用共用的辨認線索`)
  }
})

test('#1882 辨認線索：Rust 的 unnamed_clue 與介面 unnamedClue 寫法一致（末 4 碼、大寫、沒代號只寫種類）', async () => {
  const { unnamedClue } = await import('../relay/asn/ui/lib/device-identity.mjs')
  const src = rust('device_id.rs')
  assert.match(src, /pub fn unnamed_clue\(node: &str, phone: bool\) -> String/)
  // Rust 端 input_consent.rs 測試固定了這幾組的寫法；這裡確認介面端寫出同一串
  assert.equal(unnamedClue({ node: 'xisu7k2m' }), '電腦（7K2M）')
  assert.equal(unnamedClue({ node: 'n-q9z8', phone: true }), '手機（Q9Z8）')
  assert.equal(unnamedClue({ node: 'ab' }), '電腦（AB）')
  assert.equal(unnamedClue({ node: '--' }), '電腦')
  const t = rust('input_consent.rs')
  for (const s of ['"電腦（7K2M）"', '"手機（Q9Z8）"', '"電腦（AB）"', '"電腦"']) assert.ok(t.includes(s), `Rust 測試要固定 ${s}`)
})
