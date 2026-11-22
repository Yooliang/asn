// #343：引導頁第 3 步「連接你的 AI 工具」（只有電腦版）。按「完成」才依勾選執行；每項各自顯示結果，失敗不擋其他項
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CONNECT_TEXT, PI_DOC_URL, connectDefaults, runConnect } from '../ui/lib/connect-tools.mjs'

function ops(opt = {}) {
  const fail = opt.fail ?? []
  const report = 'report' in opt ? opt.report : { state: 'installed', version: '1.2.3' }
  const calls = []
  const mk = key => async (...a) => { calls.push([key, ...a]); if (fail.includes(key)) throw new Error(`${key} 壞了`) }
  return { calls, o: { piInstall: mk('pi'), modInstall: async (...a) => { calls.push(['mod', ...a]); if (fail.includes('mod')) throw new Error('mod 壞了'); return report } } }
}

test('預設勾選：pi 偵測到才勾、Claude 外掛勾；#1883 沒有額度這一項（不再改 Claude Code 的狀態列）', () => {
  assert.deepEqual(connectDefaults({ piDetected: true }), { pi: true, mod: true })
  assert.deepEqual(connectDefaults({ piDetected: false }), { pi: false, mod: true })
})

test('pi 取消：不裝；Claude 外掛是必要元件，照樣打開自動安裝（不能取消）', async () => {
  const { calls, o } = ops()
  const r = await runConnect({ pi: false, mod: false }, o, { piDetected: true })
  assert.deepEqual(calls, [['mod']], '沒有裝 pi 擴充；Claude 外掛一律檢查並安裝，連 choice.mod 傳 false 也一樣')
  assert.ok(r.every(x => x.ok))
})

test('某一項失敗時其他項照樣執行，失敗照實顯示', async () => {
  const { calls, o } = ops({ fail: ['pi'] })
  const r = await runConnect({ pi: true, mod: true }, o, { piDetected: true })
  assert.deepEqual(calls.map(c => c[0]), ['pi', 'mod'])
  assert.deepEqual(r.map(x => [x.key, x.ok]), [['pi', false], ['mod', true]])
  assert.match(r[0].text, /沒有成功：pi 壞了/)
})

test('沒偵測到 pi：就算勾了也不裝，照實說明；登入只是幫使用者開終端機，說明 ASN 看不到登入資料', async () => {
  const { calls, o } = ops()
  const r = await runConnect({ pi: true, mod: true }, o, { piDetected: false })
  assert.ok(!calls.some(c => c[0] === 'pi'))
  assert.equal(r.find(x => x.key === 'pi').text, CONNECT_TEXT.piMissing)
  assert.equal(CONNECT_TEXT.piLoginNote, '請在打開的視窗輸入 /login，ASN 不會看到你的登入資料')
  assert.match(PI_DOC_URL, /^https:\/\/github\.com\//)
})

test('接線：只有電腦版的引導頁有這一步（名字填好之後）；手機引導不變；設定頁的 Claude 外掛只有一行狀態、有 pi 登入', () => {
  const html = fs.readFileSync(new URL('../ui/onboard.html', import.meta.url), 'utf8')
  assert.match(html, /<connect-step v-if="connect" :api="connectApi" @done="finish"><\/connect-step>/)
  assert.match(html, /@done="connect = true"/)
  assert.doesNotMatch(fs.readFileSync(new URL('../ui/m.html', import.meta.url), 'utf8'), /connect-step/, '手機版不需要')
  const js = fs.readFileSync(new URL('../ui/onboard.js', import.meta.url), 'utf8')
  assert.match(js, /modInstall: \(\) => invoke\('claude_mod_check'\)/)
  assert.match(js, /piLogin: \(\) => invoke\('ai_cli_login', \{ toolId: 'pi' \}\)/)
  const sp = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(sp, /act\('claude-mod-auto'/, '設定裡不能再有關掉 Claude 外掛自動安裝的開關')
  assert.doesNotMatch(sp, /aria-label="Claude 外掛"[\s\S]{0,400}type="checkbox"/, 'Claude 外掛不再是打勾框，只是一行狀態')
  assert.match(sp, /act\('pi-login'\)/)
})

test('外掛結果照 Rust 實際回報顯示（和設定頁同一份文字）；查不到結果就不寫成功字樣', async () => {
  const cases = [
    [{ state: 'installed', version: '1.2.3' }, '已安裝 v1.2.3，ASN 更新時會一起更新', true],
    [{ state: 'no_claude' }, '這台電腦沒有 Claude，裝好 Claude 後重新開啟 ASN 會自動安裝', true],
    [{ state: 'failed', reason: 'spawn ENOENT' }, '安裝沒有成功，重新開啟 ASN 會再試一次', false],
  ]
  for (const [report, text, ok] of cases) {
    const { o } = ops({ report })
    const r = (await runConnect({ pi: false }, o, { piDetected: false })).find(x => x.key === 'mod')
    assert.deepEqual([r.text, r.ok], [text, ok], report.state)
  }
  for (const report of [null, undefined, {}, { state: 'weird' }]) {
    const { o } = ops({ report })
    const r = (await runConnect({ pi: false }, o, { piDetected: false })).find(x => x.key === 'mod')
    assert.equal(r.text, '', '沒有結果：不顯示任何文字')
    assert.doesNotMatch(r.text, /已安裝|成功/)
  }
  assert.doesNotMatch(CONNECT_TEXT.modDesc, /自動安裝和更新|自動安裝或更新/)
  const src = fs.readFileSync(new URL('../ui/lib/connect-tools.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /會自動安裝或更新/, '不再寫死成功字串')
})
