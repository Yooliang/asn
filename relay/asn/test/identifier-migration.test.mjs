// 守門：電腦版程式識別改名（#14 R3，tw.irori.asn → tw.yooliang.asn）不能讓更新後出現第二份安裝。
// Tauri 2 的 NSIS 安裝程式把「廠商名」（bundle.publisher，沒設就取識別第二段）放進登錄機碼
// Software\<廠商>\<產品名>（記安裝資料夾），升級時新安裝程式用它找舊安裝、叫舊解除安裝程式 `_?=<資料夾>`。
// 識別第二段從 irori 變 yooliang 會讓機碼對不上（資料夾變空字串）。所以廠商名必須釘死成 irori。
// 每一條都做過「拿掉被守的東西確認會紅」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n')
const conf = () => JSON.parse(read('src-tauri', 'tauri.conf.json'))

// 照 Tauri 2.12 的 NSIS 範本推出「安裝位置與更新判斷」用到的鍵（installer.nsi 與 nsis/mod.rs）
export function nsisKeys(c) {
  const manufacturer = c.bundle.publisher ?? c.identifier.split('.')[1] ?? c.identifier
  const product = c.productName
  return {
    uninstall: `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${product}`, // 有沒有舊安裝、解除安裝字串
    installDir: `Software\\${manufacturer}\\${product}`, // 舊安裝資料夾（升級時傳給舊解除安裝程式）
    autostartValue: product, // HKCU\...\Run 的值名（更新模式保留）
    defaultDir: `%LOCALAPPDATA%\\${product}`, // currentUser 模式的預設安裝資料夾
    exe: `${c.mainBinaryName}.exe`,
  }
}

// 出貨中的 0.1.43 設定（識別 tw.irori.asn、沒設 publisher）
const SHIPPED = { identifier: 'tw.irori.asn', productName: 'ASN', mainBinaryName: 'asn', bundle: {} }

test('安裝位置判斷：現在的設定與出貨中的舊版對得上（更新後只剩一份、開機自啟與外掛路徑不變）', () => {
  assert.deepEqual(nsisKeys(conf()), nsisKeys(SHIPPED))
})

test('安裝位置判斷自我檢查：只改識別、不釘廠商名，機碼就會對不上', () => {
  const naive = { ...SHIPPED, identifier: 'tw.yooliang.asn' }
  assert.notEqual(nsisKeys(naive).installDir, nsisKeys(SHIPPED).installDir)
  assert.equal(nsisKeys(naive).uninstall, nsisKeys(SHIPPED).uninstall, '解除安裝機碼只看產品名')
})

test('設定：識別改新名；廠商名、產品名、主程式名、安裝模式不能動', () => {
  const c = conf()
  assert.equal(c.identifier, 'tw.yooliang.asn')
  assert.equal(c.bundle.publisher, 'irori', '廠商名釘在 irori：否則登錄機碼 Software\\<廠商>\\ASN 換名，升級時找不到舊安裝')
  assert.equal(c.productName, 'ASN')
  assert.equal(c.mainBinaryName, 'asn')
  assert.equal(c.bundle.windows.nsis.installMode, 'currentUser')
  assert.equal(c.plugins.updater.endpoints.length, 1, '更新來源不變（舊版收得到新版）')
})

test('套件名：npm 與 Cargo 都是 asn', () => {
  assert.equal(JSON.parse(read('package.json')).name, 'asn')
  assert.equal(JSON.parse(read('package-lock.json')).name, 'asn')
  assert.match(read('src-tauri', 'Cargo.toml'), /^name = "asn"$/m)
})

test('安裝程式掛勾不綁識別名（登錄機碼、資料夾都不寫死）', () => {
  const h = read('src-tauri', 'installer-hooks.nsh')
  assert.doesNotMatch(h, /tw\.(irori|yooliang)|BUNDLEID|CurrentVersion\\Run|Software\\irori/)
})

test('原始碼：舊識別只准出現在 datadir.rs（遷移用），其他地方一律不寫死', () => {
  const dir = path.join(root, 'src-tauri', 'src')
  const bad = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.rs') && e.name !== 'datadir.rs' && /tw\.irori\.asn/.test(fs.readFileSync(p, 'utf8'))) bad.push(path.relative(dir, p))
    }
  }
  walk(dir)
  assert.deepEqual(bad, [])
})

test('啟動：資料夾經 datadir::startup 決定，且在「同一個視窗名只留一個」檢查之前；截圖模式不遷移', () => {
  const lib = read('src-tauri', 'src', 'lib.rs')
  assert.match(lib, /datadir::startup\(&work_dir, shot\.is_some\(\)\)/)
  assert.ok(lib.includes('mod datadir;'))
  assert.ok(lib.indexOf('datadir::startup') < lib.indexOf('heartbeat::other_instance('), '先決定資料夾（內含舊版仍在跑的判斷），再做視窗名單一執行個體檢查')
  const d = read('src-tauri', 'src', 'datadir.rs')
  assert.match(d, /if no_migrate \{\s*return new;/)
  assert.match(d, /pub const OLD_ID: &str = "tw\.irori\.asn";/)
  assert.match(d, /pub const NEW_ID: &str = "tw\.yooliang\.asn";/)
})

test('遷移是複製不是搬：datadir.rs 沒有刪除或改名舊資料夾的呼叫', () => {
  const d = read('src-tauri', 'src', 'datadir.rs').split('#[cfg(test)]')[0]
  const calls = [...d.matchAll(/fs::(remove_dir_all|remove_file|remove_dir|rename)\(([^)]*)\)/g)].map((m) => `${m[1]}(${m[2]})`)
  // 只准動自己的暫存資料夾：remove_dir_all(&staging)、rename(&staging, new)
  for (const c of calls) assert.match(c, /staging/, `只能動暫存資料夾：${c}`)
  assert.ok(calls.length >= 2)
})
