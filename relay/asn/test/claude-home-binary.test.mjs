// #1606：用官方安裝程式裝、沒加進 PATH 的 Claude Code（~/.local/bin/claude.exe）也要偵測得到、也要能開視窗。
// Rust 端不能在這台跑 cargo，這裡讀原始碼鎖住幾個關鍵（單元測試在各 .rs 的 tests 裡）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const detect = read('src-tauri/src/agent_tools/detect.rs')
const install = read('src-tauri/src/agent_tools/install.rs')
const profiles = read('src-tauri/src/launch/profiles.rs')
const core = read('src-tauri/src/bridge/core.rs')

const fnBody = (src, sig) => {
  const i = src.indexOf(sig)
  assert.ok(i >= 0, `找不到 ${sig}`)
  const end = src.indexOf('\n}\n', i)
  return src.slice(i, end)
}

test('known_home_binary 認 claude：~/.local/bin 的 claude.exe 與 claude（Windows 的 .exe 排前面）', () => {
  const body = fnBody(detect, 'fn known_home_binary(')
  assert.match(body, /"claude"\s*=>/)
  assert.match(body, /join\("\.local"\)\.join\("bin"\)/)
  assert.match(body, /\["claude\.exe", "claude"\]/)
  assert.match(body, /"grok"\s*=>[^\n]*\.grok[^\n]*\["grok\.exe", "grok"\]/, 'grok 照舊')
})

test('resolve_binary 在 PATH 找不到後看家目錄的固定位置，而且 mock 資料夾模式下不看真實家目錄', () => {
  const resolve = fnBody(detect, 'pub fn resolve_binary(')
  assert.match(resolve, /resolve_on_path\(name\)[\s\S]*known_home_binary_real\(name\)[\s\S]*package_manager_binary/)
  const real = fnBody(detect, 'fn known_home_binary_real(')
  assert.match(real, /ASN_MOCK_BIN_DIR/)
  assert.match(real, /known_home_binary\(&crate::identity::home_dir\(\), name\)/)
})

test('登入終端機用偵測到的完整路徑，不再叫裸名字', () => {
  const body = fnBody(install, 'pub fn open_login_terminal(')
  assert.match(body, /resolve_binary\(&def\.binary\)/)
  assert.doesNotMatch(body, /spawn_interactive_terminal\(def\.binary/)
})

test('開視窗的 claude 設定用 resolve_binary 的完整路徑當指令', () => {
  const body = fnBody(profiles, 'pub fn build_default_profiles(')
  assert.match(body, /resolve_binary\("claude"\)/)
  assert.match(body, /command: c,/)
})

test('收發室的 claude 預設也走 resolve_binary（CLAUDE_BIN 仍優先、找不到才退回裸名字）', () => {
  assert.match(core, /claude_bin: std::env::var\("CLAUDE_BIN"\)[^\n]*resolve_binary\("claude"\)[^\n]*unwrap_or_else\(\|\| "claude"\.into\(\)\)/)
})
