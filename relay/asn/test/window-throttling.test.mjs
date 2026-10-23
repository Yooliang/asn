import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const conf = () => JSON.parse(read('src-tauri/tauri.conf.json')).app.windows.find(w => w.label === 'list')
const NEEDED = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion']

// 開機自啟縮在系統匣時名單視窗是隱藏的；WebView2 會節流／凍結隱藏頁面，畫面端的收信計時器就不跑（寄給本機 ASN 視窗的信沒人收）
test('名單視窗關掉背景節流：瀏覽器參數帶齊，且保留自動播放參數', () => {
  const args = conf().additionalBrowserArgs.split(/\s+/)
  for (const a of NEEDED) assert.ok(args.includes(a), `名單視窗少了 ${a}`)
  assert.ok(args.includes('--autoplay-policy=no-user-gesture-required'))
  assert.equal(conf().backgroundThrottling, 'disabled')
})

test('所有視窗共用的瀏覽器參數（lib.rs）與名單視窗設定一字不差（不一致第二扇視窗建不起來）', () => {
  const m = /#\[cfg\(windows\)\]\s*pub const BROWSER_ARGS: &str = "([^"]*)";/.exec(read('src-tauri/src/lib.rs'))
  assert.ok(m, '找不到 Windows 的 BROWSER_ARGS')
  assert.equal(m[1], conf().additionalBrowserArgs)
})
