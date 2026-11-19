import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// #1808 第 11 組守門：同一個夥伴開出兩個視窗／同名（#1352／#1614／#1636／#1674）。
// 靜態守門：讀 Rust 原始碼，確認「共用正在開登記」與「等確認的夥伴也占名字」兩條修法還在。
// #1614 另有 dup-session-guard.test.mjs；#1446（pi 夥伴喚醒沒接上登記）尚未修，這裡不守。
const src = rel => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri/src', rel), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10))
const prod = s => s.split('#[cfg(test)]')[0]

test('#1352 守門：共用「正在開」登記——對話編號與名字任一相同就擋，且有時限與解除', () => {
  const o = prod(src('launch/opening.rs'))
  assert.match(o, /HOLD_MS: u64 = 120_000/)
  assert.match(o, /format!\("s:\{session\}"\)/)
  assert.match(o, /format!\("n:\{name\}"\)/)
  assert.match(o, /ks\.iter\(\)\.any\(\|k\| self\.held\.contains_key\(k\)\)/, '任一鍵已登記就擋')
  assert.match(o, /fn release\(/)
  assert.match(o, /BUSY: &str = "這位夥伴的視窗正在開啟中"/)
})

// 取出某個函式的本體：從簽名那一行到同縮排的收尾大括號（不靠出現次數，靠「是哪個函式」）
function fnBody(text, sig) {
  const i = text.indexOf(sig)
  assert.ok(i >= 0, `找不到函式：${sig}`)
  const lineStart = text.lastIndexOf('\n', i) + 1
  const indent = text.slice(lineStart).match(/^ */)[0]
  const end = text.indexOf('\n' + indent + '}\n', i)
  assert.ok(end > i, `找不到函式結尾：${sig}`)
  return text.slice(i, end)
}

// 每個開窗入口：{ 檔, 函式簽名, 登記, 解除, 開窗 }——登記要在開窗之前，開窗失敗的路徑要解除
const OPEN_ENTRIES = [
  { file: 'launch/local.rs', sig: 'pub fn partner_launch_local(', claim: 'opening::claim(', release: 'opening::release(', open: 'start_window_noted(' },
  { file: 'launch/local.rs', sig: 'pub fn start_resumed_window(', claim: 'opening::claim(', release: 'opening::release(', open: 'start_window(' },
  { file: 'bridge/partner_ops.rs', sig: 'fn resume(&self, op: &Op)', claim: 'self.env.claim_opening(sid, name)', release: 'self.env.release_opening(sid, name)', open: 'self.env.launch(&plan)' },
]

test('#1352 守門：每個開視窗的入口（本機開新夥伴、開機接回、遠端喚醒）都先登記、開失敗就解除', () => {
  for (const e of OPEN_ENTRIES) {
    const body = fnBody(prod(src(e.file)), e.sig)
    const claim = body.indexOf(e.claim), open = body.indexOf(e.open), release = body.indexOf(e.release)
    assert.ok(claim >= 0, `${e.sig} 要先向「正在開」登記`)
    assert.ok(open > claim, `${e.sig} 的登記要排在真的開窗之前`)
    assert.ok(release > open, `${e.sig} 開窗失敗時要解除登記`)
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
