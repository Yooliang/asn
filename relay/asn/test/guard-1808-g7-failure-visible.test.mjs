// #1808 第 7 組守門：失敗了畫面沒有提示（靜默失敗）（復發單號：#1135 #1253 #1592 #1603 #1611 #1727 #1764）
//
// 一直被弄壞的那條規則：任何讀取或動作失敗，使用者看得到的地方一定要有一句白話——不能整塊消失、不能只寫 log、不能秀出內部代號。
// #1764 的根因：失敗文案 ROOM_LOAD_FAIL_TEXT 早就定義了，但群組區塊的條件是「有資料才畫」，讀取失敗時整塊不渲染、文案沒人用。
// 這裡用真的失敗情境（真的錯誤字串、真的 m.html／list.html 版面、真的 Rust 白話表）鎖住，不是自己造一份剛好會過的資料。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoomHub } from '../ui/lib/room-hub.mjs'
import { ROOM_LOAD_FAIL_TEXT } from '../ui/lib/mobile-rooms.mjs'
import { ROOMS_NEED_LOGIN_TEXT, ROSTER_LOAD_FAIL_TEXT, roomsNoteText } from '../ui/lib/relogin-bar.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))

test('#1764 群組讀不到（後台真的錯誤字串）：中樞標失敗、原位有白話；登入失效是另一句；正常時不多出任何字', async () => {
  const bad = createRoomHub({ invoke: async () => { throw new Error('relay_rooms 連線失敗') }, groupApi: {}, selfNode: 'T', windowName: 'w', onFail: () => {} })
  await bad.refresh()
  assert.equal(bad.st.err, true)
  assert.equal(roomsNoteText(bad.st), ROOM_LOAD_FAIL_TEXT)
  const expired = createRoomHub({ invoke: async () => ({ rooms: [], signed: false, reason: 'login_expired' }), groupApi: {}, selfNode: 'T', windowName: 'w' })
  await expired.refresh()
  assert.equal(roomsNoteText(expired.st), ROOMS_NEED_LOGIN_TEXT)
  const ok = createRoomHub({ invoke: async () => ({ rooms: [], signed: true }), groupApi: {}, selfNode: 'T', windowName: 'w' })
  await ok.refresh()
  assert.equal(roomsNoteText(ok.st), '')
})

/** 找出某一行在 HTML 裡的所有祖先行（依縮排往上找，每個縮排層級取最近一行） */
function ancestors(lines, idx) {
  const out = []
  let indent = lines[idx].search(/\S/)
  for (let i = idx - 1; i >= 0 && indent > 0; i--) {
    const k = lines[i].search(/\S/)
    if (k >= 0 && k < indent && /^\s*<[a-zA-Z]/.test(lines[i]) && !/<\/|\/>\s*$/.test(lines[i].trim().slice(-6))) { out.push(lines[i]); indent = k }
  }
  return out
}

test('#1764 版面：群組讀不到的說明在電腦版與手機版都不在「有資料才畫」的區塊裡面', () => {
  for (const [file, cls] of [['ui/m.html', 'm-rooms-note'], ['ui/list.html', 'gl-empty-hint']]) {
    const lines = read(file).split('\n')
    const i = lines.findIndex(l => l.includes('v-if="roomsNote"'))
    assert.ok(i >= 0, `${file} 有 roomsNote 的位置（#1764 補上的那一行）`)
    assert.ok(lines[i].includes(cls), `${file} 那一行是說明文字`)
    const bad = ancestors(lines, i).filter(l => /v-if=|v-else-if=/.test(l) && /roomRows|rooms\.length|\.length/.test(l))
    assert.deepEqual(bad, [], `${file} 的 roomsNote 被包在「有資料才畫」裡，讀取失敗時整塊不見`)
  }
})

test('#1764 定義了失敗文字就一定有人用：失敗／需要登入這類文字常數，不能只定義、畫面沒接', () => {
  // 掃 ui/lib 裡所有「失敗／需要登入」文字常數，每一個都要在定義檔以外的 ui 檔被引用
  const files = walk(path.join(root, 'ui')).filter(f => /\.(m?js|html)$/.test(f) && !f.includes('vendor'))
  const text = new Map(files.map(f => [f, fs.readFileSync(f, 'utf8')]))
  const names = []
  for (const [f, t] of text) {
    if (!f.includes(`${path.sep}lib${path.sep}`)) continue
    for (const m of t.matchAll(/export const ([A-Z0-9_]*(?:FAIL|FAILED|NEED_LOGIN)[A-Z0-9_]*(?:TEXT|NOTES?|LABEL|ARIA|ERR|ERROR)) =/g)) names.push([m[1], f])
  }
  assert.ok(names.length >= 6, `掃得到足夠的失敗文字常數：${names.map(n => n[0])}`)
  // 真正用到的次數：不算 import 行、不算 export const 定義那一行
  const uses = n => [...text.values()].reduce((c, t) => c + t.split('\n').filter(l => !/^\s*import\s/.test(l) && !new RegExp(`export const ${n}\\b`).test(l) && new RegExp(`\\b${n}\\b`).test(l)).length, 0)
  const unused = names.filter(([n]) => uses(n) < 1)
  assert.deepEqual(unused.map(u => u[0]), [], '這些失敗文字只有定義、沒有任何畫面使用（#1764 的同一種漏）')
})

/** 取 Rust match 裡 `=> "白話"` 的字串 */
const arms = src => [...src.matchAll(/=>\s*"([^"]+)"/g)].map(m => m[1])
// 內部代號：snake_case 識別字、HTTP、純狀態碼、動作名
const INTERNAL = /[a-z]+_[a-z_]+|HTTP|\b[45]\d\d\b|\blaunch\b/

test('#1808 名單讀不到：電腦與手機引用同一個常數，畫面上不再有各寫各的內聯字串', () => {
  const list = read('ui/list.js'), mobile = read('ui/m.js')
  for (const [name, src] of [['list.js', list], ['m.js', mobile]]) {
    assert.match(src, /import \{[^}]*\bROSTER_LOAD_FAIL_TEXT\b[^}]*\} from '\.\/lib\/relogin-bar\.mjs'/, `${name} 要從 relogin-bar.mjs 引用名單讀不到的常數`)
    assert.match(src, /conn\.value === 'off' \? ROSTER_LOAD_FAIL_TEXT/,`${name} 連不上時要顯示這個常數`)
    assert.ok(!src.includes('還沒連上 ASN。') && !/'連不上 ASN，請檢查網路。'/.test(src), `${name} 不能再有內聯的名單讀不到字串`)
  }
  assert.equal(ROSTER_LOAD_FAIL_TEXT, '連不上 ASN，請檢查網路。')
})

test('#1135 #1253 #1611 #1727 後台回的失敗代碼都換成白話：對照表裡每句都有中文、沒有內部代號（真的 Rust 白話表）', () => {
  const remote = read('src-tauri/src/view_remote.rs').split('pub fn end_text(')[1].split('\n}\n')[0]
  const launch = read('src-tauri/src/launch/mod.rs').split('pub fn launch_error_text(')[1].split('\n}\n')[0]
  for (const [name, body] of [['view_remote::end_text', remote], ['launch::launch_error_text', launch]]) {
    const texts = arms(body)
    assert.ok(texts.length >= 8, `${name} 讀得到對照表：${texts.length}`)
    for (const t of texts) {
      assert.match(t, /[一-鿿]/, `${name}：${t} 要是中文白話`)
      assert.doesNotMatch(t, INTERNAL, `${name}：${t} 不能秀內部代號`)
    }
  }
  // 不認得的代碼也要有最後一句，不能是空的或原字串
  assert.match(remote, /_ => "[^"]+"/)
  assert.match(launch, /_ => "[^"]+"/)
})

test('#1603 登入保存失敗：畫面給的是常數白話，錯誤碼只進 log', () => {
  const auth = read('src-tauri/src/auth.rs')
  const text = auth.match(/pub\(crate\) const SAVE_FAIL_TEXT: &str = "([^"]+)";/)?.[1]
  assert.ok(text, '有 SAVE_FAIL_TEXT')
  assert.doesNotMatch(text, /DPAPI|0x/)
  const fn = auth.split('pub(crate) fn dpapi_protect(')[1].split('\n}\n')[0]
  assert.match(fn, /Err\(SAVE_FAIL_TEXT\.into\(\)\)/)
})
