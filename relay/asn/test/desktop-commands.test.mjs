// 電腦版的指令清單守門：介面呼叫的指令沒註冊在電腦版清單，呼叫會直接失敗（#462 的「版本紀錄」就漏過：只註冊了手機版，電腦版設定顯示「暫時讀不到版本紀錄」）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const lib = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'src', 'lib.rs'), 'utf8')
// 兩個 invoke_handler：第一個是電腦版（#[cfg(desktop)]），第二個是手機版（#[cfg(not(desktop))]）
const at = [...lib.matchAll(/\.invoke_handler\(/g)].map(m => m.index)
assert.equal(at.length, 2, '預期有電腦版與手機版兩個指令清單')
const desktop = lib.slice(at[0], at[1])
const mobile = lib.slice(at[1], lib.indexOf('.setup(', at[1]))

test('電腦版與手機版共用的指令：兩邊的清單都要註冊（版本紀錄 site_releases）', () => {
  assert.ok(desktop.includes('generate_handler!'), '找不到電腦版的指令清單')
  assert.ok(desktop.includes('site_releases::site_releases'), 'site_releases 沒註冊在電腦版的指令清單')
  assert.ok(mobile.includes('site_releases::site_releases'), 'site_releases 沒註冊在手機版的指令清單')
})
