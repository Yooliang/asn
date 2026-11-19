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

test('#1352 守門：開視窗的入口都要先登記、開失敗要解除', () => {
  const local = prod(src('launch/local.rs'))
  assert.equal((local.match(/opening::claim\(/g) || []).length, 2, '本機開窗與接回兩條路都要登記')
  assert.equal((local.match(/opening::release\(/g) || []).length, 2, '兩條路開失敗都要解除')
  const po = prod(src('bridge/partner_ops.rs'))
  assert.match(po, /self\.env\.claim_opening\(sid, name\)/, '遠端喚醒要登記')
  assert.match(po, /self\.env\.release_opening\(sid, name\)/)
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
