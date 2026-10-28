// #343：引導頁第 3 步「連接你的 AI 工具」（只有電腦版）。按「完成」才依勾選執行；每項各自顯示結果，失敗不擋其他項
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CONNECT_TEXT, PI_DOC_URL, connectDefaults, runConnect } from '../ui/lib/connect-tools.mjs'

function ops({ fail = [] } = {}) {
  const calls = []
  const mk = key => async (...a) => { calls.push([key, ...a]); if (fail.includes(key)) throw new Error(`${key} 壞了`) }
  return { calls, o: { quotaConnect: mk('quota'), piInstall: mk('pi'), modAuto: mk('mod') } }
}

test('預設勾選：額度不勾、pi 偵測到才勾、Claude 外掛勾', () => {
  assert.deepEqual(connectDefaults({ piDetected: true }), { quota: false, pi: true, mod: true })
  assert.deepEqual(connectDefaults({ piDetected: false }), { quota: false, pi: false, mod: true })
})

test('勾選都取消：不安裝、不接任何東西；只把 Claude 外掛的自動安裝開關關掉', async () => {
  const { calls, o } = ops()
  const r = await runConnect({ quota: false, pi: false, mod: false }, o, { piDetected: true })
  assert.deepEqual(calls, [['mod', false]], '沒有接額度、沒有裝 pi 擴充；Claude 外掛只是關掉開關（不裝也不更新）')
  assert.ok(r.every(x => x.ok))
})

test('某一項失敗時其他項照樣執行，失敗照實顯示', async () => {
  const { calls, o } = ops({ fail: ['quota'] })
  const r = await runConnect({ quota: true, pi: true, mod: true }, o, { piDetected: true })
  assert.deepEqual(calls.map(c => c[0]), ['quota', 'pi', 'mod'])
  assert.deepEqual(r.map(x => [x.key, x.ok]), [['quota', false], ['pi', true], ['mod', true]])
  assert.match(r[0].text, /沒有成功：quota 壞了/)
})

test('沒偵測到 pi：就算勾了也不裝，照實說明；登入只是幫使用者開終端機，說明 ASN 看不到登入資料', async () => {
  const { calls, o } = ops()
  const r = await runConnect({ quota: false, pi: true, mod: true }, o, { piDetected: false })
  assert.ok(!calls.some(c => c[0] === 'pi'))
  assert.equal(r.find(x => x.key === 'pi').text, CONNECT_TEXT.piMissing)
  assert.equal(CONNECT_TEXT.piLoginNote, '請在打開的視窗輸入 /login，ASN 不會看到你的登入資料')
  assert.match(PI_DOC_URL, /^https:\/\/github\.com\//)
})

test('接線：只有電腦版的引導頁有這一步（名字填好之後）；手機引導不變；設定頁有 Claude 外掛開關與 pi 登入', () => {
  const html = fs.readFileSync(new URL('../ui/onboard.html', import.meta.url), 'utf8')
  assert.match(html, /<connect-step v-if="connect" :api="connectApi" @done="finish"><\/connect-step>/)
  assert.match(html, /@done="connect = true"/)
  assert.doesNotMatch(fs.readFileSync(new URL('../ui/m.html', import.meta.url), 'utf8'), /connect-step/, '手機版不需要')
  const js = fs.readFileSync(new URL('../ui/onboard.js', import.meta.url), 'utf8')
  assert.match(js, /modAuto: on => invoke\('claude_mod_auto_set', \{ on \}\)/)
  assert.match(js, /piLogin: \(\) => invoke\('ai_cli_login', \{ toolId: 'pi' \}\)/)
  const sp = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
  assert.match(sp, /act\('claude-mod-auto', \$event\.target\.checked\)/)
  assert.match(sp, /關掉後 ASN 不再自動安裝或更新 Claude 外掛；已經裝的會留著/)
  assert.match(sp, /act\('pi-login'\)/)
})
