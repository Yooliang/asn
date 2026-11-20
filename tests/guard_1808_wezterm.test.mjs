// #1808 第 16 組守門：終端服務（WezTerm mux）崩潰（#897、#1257、#1253）。
// 崩潰本身（堆疊溢位）無法在單元測試重現；這裡守的是「防線還在」：
//   #1257 Windows 安裝檔只附 ASN 自建、驗過來源證明的 WezTerm，不退回上游官方版；
//   #897  捲動紀錄上限寫明、啟動時不重複讀剛認領的窗格；
//   #1253 服務停了或監看看不到它時一定有訊號（紀錄＋通知）。
// 只讀原始碼文字，不編 Rust。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const PINS = JSON.parse(rd('relay/asn/scripts/wezterm-pins.json'))
const FETCH = rd('relay/asn/scripts/fetch-wezterm.mjs')
const BUILD_WF = rd('.github/workflows/wezterm-build.yml')
const MUX = rd('relay/asn/src-tauri/src/launch/mux.rs')
const TERM = rd('relay/asn/src-tauri/src/launch/term.rs')
const WATCH = rd('relay/asn/src-tauri/src/launch/mux_watch.rs')

test('#1257 Windows 附的 WezTerm 釘在本 repo 自建的 release（asn 後綴、雜湊與大小、簽署 workflow）', () => {
  const b = PINS.windows_bundle
  assert.ok(b, 'wezterm-pins.json 要有 windows_bundle')
  assert.equal(b.repo, 'Yooliang/asn')
  assert.match(b.tag, new RegExp(`^wezterm-${PINS.version}-asn\\.\\d+$`))
  assert.match(b.zip, /-asn\.\d+\.zip$/)
  assert.match(b.sha256, /^[0-9a-f]{64}$/)
  assert.ok(Number.isInteger(b.size) && b.size > 0)
  assert.equal(b.signer_workflow, 'Yooliang/asn/.github/workflows/wezterm-build.yml')
  // 上游官方壓縮檔的雜湊不能被當成 Windows 附檔的雜湊
  assert.notEqual(b.sha256, PINS.windows_zip_sha256)
  // workflow 換新後綴要先進 main 才能發佈，pins 等新 release 發出後才跟上：允許 pins 落後剛好一號（細節與反例在 relay/asn/test/wezterm-bundle.test.mjs）
  const rel = /^\s*RELEASE_TAG: 'wezterm-(.+)-asn\.(\d+)'/m.exec(BUILD_WF)
  const pin = /^wezterm-(.+)-asn\.(\d+)$/.exec(b.tag)
  assert.ok(rel && pin && rel[1] === pin[1], '自建 workflow 的 release tag 要和釘的是同一個上游版本')
  assert.ok([0, 1].includes(Number(rel[2]) - Number(pin[2])), `釘的 ${b.tag} 要等於 workflow 的 RELEASE_TAG，或剛好落後一號`)
})

test('#1257 取檔腳本先驗來源證明、再驗雜湊與大小，且不出現上游官方網址、不能略過證明', () => {
  assert.ok(!FETCH.includes('github.com/wezterm/wezterm'), '不退回上游官方下載')
  assert.ok(!/ASN_SKIP_ATTEST|skipAttest/i.test(FETCH), '沒有略過來源證明的開關')
  assert.match(FETCH, /'attestation', 'verify'/)
  assert.match(FETCH, /--signer-workflow/)
  assert.match(FETCH, /refs\/heads\/main/)
  assert.ok(FETCH.indexOf('    verifyAttestation(zipPath)') > 0 && FETCH.indexOf('    verifyAttestation(zipPath)') < FETCH.indexOf('    checkBytes(fs.readFileSync(zipPath)'), '來源證明要先於雜湊核對')
})

test('#1257 自建的 WezTerm release 一律預發行、不搶 latest', () => {
  const lines = BUILD_WF.replace(/\\\n/g, ' ').split('\n').filter(l => /gh\s+release\s+create\b/.test(l) && !/^\s*#/.test(l))
  assert.ok(lines.length >= 1)
  for (const l of lines) assert.ok(/--latest=false\b/.test(l) && /--prerelease\b/.test(l), l.trim().slice(0, 80))
})

test('#897 mux 設定明寫捲動紀錄上限，上限寫進產生的設定檔', () => {
  assert.match(MUX, /pub const SCROLLBACK_LINES: u32 = \d+;/)
  assert.match(MUX, /scrollback_lines = \{SCROLLBACK_LINES\}/, 'config_text 要把上限寫進 mux.lua')
})

test('#897 監看在 RECENT_PROBE 內不重讀剛認領的窗格，過期記錄會丟掉', () => {
  assert.match(TERM, /pub\(crate\) const RECENT_PROBE: Duration = Duration::from_secs\(\d+\);/)
  assert.match(TERM, /probed:/)
  assert.match(TERM, /g\.probed\.retain\(\|_, at\| at\.elapsed\(\) < RECENT_PROBE\)/)
})

test('#1253 服務停了：沒有夥伴也要記一次事故；監看連續看不到服務要寫紀錄並發通知', () => {
  assert.match(WATCH, /pub const BLIND_ROUNDS: u32 = \d+;/)
  assert.match(WATCH, /pub enum BlindEvent/)
  assert.match(WATCH, /fn empty_normal_exit/, '正常結束（碼 0）才略過')
  // mux 活著就記，不再要求裡面有夥伴
  assert.doesNotMatch(WATCH, /\.filter\(\|_\| !o\.partners\.is_empty\(\)\)/, '沒有夥伴就不記＝崩潰沒有任何訊號（11-10 事故）')
  assert.match(WATCH, /BlindEvent::Became[\s\S]{0,400}queue_blind\(/, '看不到要排通知')
  assert.match(WATCH, /ui_log::append/, '要寫進使用者看得到的紀錄')
})

test('#1253 通知種類 mux_down／mux_blind 在介面通知中心與後台 relay 都有接', () => {
  const notice = rd('relay/asn/ui/lib/notice.mjs')
  assert.match(notice, /mux_down: 'stuck'/)
  assert.match(notice, /mux_blind: 'stuck'/)
  const relay = rd('supabase/functions/relay/index.ts')
  assert.match(relay, /action === "mux_down_notice"/)
  // 不寫死 migration 檔名：只要任何一支 migration 定義了「看不到服務」的通知函式就算（檔名會因整理而改）
  const dir = new URL('../supabase/migrations/', import.meta.url)
  const defs = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).filter(f => /create\s+(or\s+replace\s+)?function\s+public\.asn_relay_mux_blind_notice\s*\(/i.test(fs.readFileSync(new URL(f, dir), 'utf8')))
  assert.ok(defs.length >= 1, '後台要有 asn_relay_mux_blind_notice 函式（任一支 migration 定義即可）')
  assert.match(relay, /asn_relay_mux_blind_notice/, 'relay 要呼叫它')
})
