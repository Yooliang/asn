import assert from 'node:assert/strict'
import test from 'node:test'

// #1808 第 11 組守門：同一個夥伴開出兩個視窗／同名（#1352／#1614／#1636／#1674）。
// 靜態守門：讀 Rust 原始碼，確認「共用正在開登記」與「等確認的夥伴也占名字」兩條修法還在。
// #1614 另有 dup-session-guard.test.mjs；#1446（pi 夥伴喚醒沒接上登記）尚未修，這裡不守。
import { blockAfter, fnCode, prod, src } from './helpers/rust-guard.mjs'

test('#1352 守門：共用「正在開」登記——對話編號與名字任一相同就擋，且有時限與解除', () => {
  const o = prod(src('launch/opening.rs'))
  assert.match(o, /HOLD_MS: u64 = 120_000/)
  assert.match(o, /format!\("s:\{session\}"\)/)
  assert.match(o, /format!\("n:\{name\}"\)/)
  assert.match(o, /ks\.iter\(\)\.any\(\|k\| self\.held\.contains_key\(k\)\)/, '任一鍵已登記就擋')
  assert.match(o, /fn release\(/)
  assert.match(o, /BUSY: &str = "這位夥伴的視窗正在開啟中"/)
})

// 每個開窗入口：登記要排在開窗之前、登記失敗要馬上 return、開窗失敗的分支裡要解除。
// 先去掉 Rust 註解再找（註解裡寫的不算數），失敗分支用大括號配對取出（不靠縮排或長度）。
// fail＝開窗失敗那個分支的開頭；afterOpen＝該分支寫在開窗呼叫之後（遠端喚醒是把開窗呼叫寫在 if let Err 條件裡，所以不是）
const OPEN_ENTRIES = [
  { file: 'launch/local.rs', sig: 'pub fn partner_launch_local(', claim: 'opening::claim(', release: 'opening::release(', open: 'start_window_noted(', fail: /Err\(e\) => \{/, afterOpen: true },
  { file: 'launch/local.rs', sig: 'pub fn start_resumed_window(', claim: 'opening::claim(', release: 'opening::release(', open: 'start_window(', fail: /if opened\.is_err\(\) \{/, afterOpen: true },
  { file: 'bridge/partner_ops.rs', sig: 'fn resume(&self, op: &Op)', claim: 'self.env.claim_opening(sid, name)', release: 'self.env.release_opening(sid, name)', open: 'self.env.launch(&plan)', fail: /if let Err\(e\) = self\.env\.launch\(&plan\) \{/, afterOpen: false },
]
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('#1352 守門：每個開視窗的入口（本機開新夥伴、開機接回、遠端喚醒）都先登記、開失敗就解除', () => {
  for (const e of OPEN_ENTRIES) {
    const body = fnCode(prod(src(e.file)), e.sig)
    const claim = body.indexOf(e.claim), open = body.indexOf(e.open)
    assert.ok(claim >= 0, `${e.sig} 要先向「正在開」登記（註解不算）`)
    assert.ok(open > claim, `${e.sig} 的登記要排在真的開窗之前`)
    assert.match(body, new RegExp(`if ![\\w:]*${esc(e.claim)}[^{]*\\{\\s*return `), `${e.sig} 登記不到就要馬上 return，不能照開`)
    const fail = blockAfter(body, e.fail, claim)
    assert.ok(fail.at > (e.afterOpen ? open : claim - 1), `${e.sig} 的失敗分支位置不對`)
    assert.ok(fail.text.includes(e.release), `${e.sig} 開窗失敗的分支裡要解除登記`)
  }
  const ar = prod(src('launch/auto_resume.rs'))
  assert.match(ar, /why == super::opening::BUSY/, '開機接回遇到別條路在開，要當成已在開、不算失敗')
  assert.match(src('bridge/core/archive_sync.rs'), /opening::release\(/, '本人關視窗要解除登記')
})

test('#1636 守門：還沒進到對話（等本人按確認）的夥伴也占名字——開新夥伴、改名、遠端開窗三處撞名都看得到', () => {
  assert.match(prod(src('launch/local.rs')), /live\.is_none\(\) && super::awaiting::real_holds_name\(&req\.name, false\)/)
  assert.match(prod(src('bridge/partner_ops.rs')), /awaiting::real_holds_name\(name, true\)/)
  const lau = prod(src('bridge/launcher.rs'))
  const verify = lau.split('fn verify(&self')[1].split('fn remote_pi_args')[0]
  assert.match(verify, /awaiting::real_holds_name\(name, true\)/)
})

test('#1674 守門：等確認的名字只進 verify 撞名檢查，不混進「開好了沒」的名單；撞名檢查不看 30 秒門檻', () => {
  const bridge = src('bridge/mod.rs')
  const closure = bridge.split('let names: Arc<dyn Fn() -> Option<Vec<String>> + Send + Sync> = Arc::new(move || {')[1].split('});')[0]
  assert.doesNotMatch(closure, /awaiting/, 'names 閉包不能帶等確認的名字')
  const a = prod(src('launch/awaiting.rs'))
  assert.match(a, /pub\(crate\) fn identify_starting\(/, '不看開了多久的清單')
  assert.match(a, /pub\(crate\) fn real_holds_name\(/)
  assert.match(a, /pub\(crate\) fn real_names\(\)[^{]*\{\s*fresh_starting\(\)/, '撞名用不經快取、含剛開的清單')
  const h = a.split('pub(crate) fn holds_name')[1].split('\n}\n')[0]
  assert.match(h, /eq_ignore_ascii_case/, '不分大小寫比對')
})
