// 開新夥伴（#2354）：手機與電腦版（遠端開）只選廠牌，開法由同一個 autoRunFor 自動決定；畫面上沒有「運行」。
// 原本（#931）是兩邊運行名稱、可選與否、預設逐字一樣；現在改成：兩邊同一份廠牌卡、同一份自動開法，而且畫面上一個運行名稱都不該出現
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { MODEL_CATALOG, RUN_OPTION_LABEL } from '../ui/lib/model-catalog.mjs'
import { autoRunFor } from '../ui/lib/auto-run.mjs'
import * as mobileLaunch from '../ui/lib/mobile-launch.mjs'
import { launchPiChoice, launchVendorCards, launchVendors, remotePi } from '../ui/lib/mobile-launch.mjs'

const read = f => fs.readFileSync(new URL(`../ui/${f}`, import.meta.url), 'utf8')
const LABELS = Object.values(RUN_OPTION_LABEL)
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '').replace(/<!--[\s\S]*?-->/g, '')

test('四個運行名稱只留在 model-catalog 內部：兩邊的頁面與邏輯檔都不寫、也不顯示（反向：原本這裡斷言「兩邊直接顯示 c.label」）', () => {
  assert.equal(LABELS.length, 4)
  for (const f of ['m.html', 'm.js', 'lib/mobile-launch.mjs', 'list.html', 'list.js', 'lib/partner-launch-ui.mjs', 'lib/auto-run.mjs']) {
    const src = stripComments(read(f))
    for (const l of LABELS) {
      assert.ok(!src.includes(`'${l}'`) && !src.includes(`"${l}"`) && !src.includes(`\`${l}\``), `${f} 不該自己寫「${l}」`)
      if (f.endsWith('.html')) assert.ok(!src.includes(l), `${f} 不該出現「${l}」`)
    }
    assert.ok(!/RUN_OPTION_LABEL/.test(src), `${f} 不該碰運行名稱`)
  }
  assert.ok(!/partnerRun|lchRun|runOptions|launchRun|pickedRun/.test(stripComments(read('m.html')) + stripComments(read('list.html'))), '頁面不再列運行選項')
})

test('兩邊都用同一個 autoRunFor 決定開法，不再有 launchRun／pickedRun／partnerRun／lch.run', () => {
  const m = read('m.js'), l = read('list.js')
  assert.match(m, /const lchAuto = computed\(\(\) => autoRunFor\(lchRow\.value, \{ local: false, /)
  assert.match(l, /const dlgAuto = computed\(\(\) => autoRunFor\(dlgRow\.value, \{/)
  assert.match(m, /buildLaunchRequest\(lch, \{ run: lchAuto\.value\.run,/)
  assert.match(l, /remoteLaunchRequest\([\s\S]*?\{ run: dlgAuto\.value\.run, row: dlgRow\.value,/)
  for (const [f, src] of [['m.js', m], ['list.js', l]]) {
    assert.ok(!/launchRun|pickedRun|partnerRun\b|partnerRunChoice|lchRunKey|lch\.run|partnerDlg\.run|runOptions\(|customRunOptions/.test(src), `${f} 不該再有運行選項的狀態`)
  }
  assert.equal(mobileLaunch.launchRun, undefined)
  assert.equal(mobileLaunch.pickedRun, undefined)
})

test('別台電腦的廠牌卡：手機與電腦版都用 launchVendorCards，同一份標示與可選與否', () => {
  assert.match(read('m.js'), /launchVendorCards\(lchData\.machines\[node\]\?\.launcher, \{ loggedOut:/)
  assert.match(read('list.js'), /if \(dlgRemote\.value\) return launchVendorCards\(dlgRemoteLauncher\.value, \{ loggedOut: dlgLoginOut\.value \}\)/)
})

test('「前台或背景」的說明整段拿掉：常數、判斷函式、畫面元素都不在（手機原本才有；電腦版有自己的「顯示方式」）', () => {
  assert.equal(mobileLaunch.LAUNCH_DISPLAY_NOTE, undefined)
  assert.equal(mobileLaunch.showDisplayNote, undefined)
  for (const f of ['m.html', 'm.js', 'list.html', 'list.js', 'lib/mobile-launch.mjs']) {
    const s = read(f)
    assert.ok(!s.includes('LAUNCH_DISPLAY_NOTE') && !s.includes('showDisplayNote') && !s.includes('m-lch-display') && !s.includes('會照那台電腦的設定'), `${f} 不該有這行說明`)
  }
  assert.ok(!read('mobile.css').includes('m-lch-display'))
})

// #931 PR-2：別台摘要裡的 asn終端（gemini-term／grok-term，mode: term）不另外列成模型
const TERM = [{ id: 'gemini-term', label: 'Gemini（asn終端）', engine: 'agy', mode: 'term' }, { id: 'grok-term', label: 'Grok（asn終端）', engine: 'grok', mode: 'term' }]
const WITH_TERM = { profiles: [...MODEL_CATALOG.map(m => ({ id: m.profileId })), ...TERM], cwd_allow: ['D:/work'] }
const NO_TERM = { profiles: MODEL_CATALOG.map(m => ({ id: m.profileId })), cwd_allow: ['D:/work'] }
const autoOf = (row, launcher) => autoRunFor(row, { local: false, piInstalled: remotePi(launcher).installed, piReady: launchPiChoice(row, launcher).ok })

test('asn終端的虛擬項目不列成模型：模型只有 Gemini、Grok，不會多出「Gemini（asn終端）」「Grok（asn終端）」', () => {
  const cards = launchVendorCards(WITH_TERM)
  assert.deepEqual(cards.map(v => v.id), launchVendorCards(NO_TERM).map(v => v.id), '有沒有 asn終端，廠牌卡都一樣')
  assert.ok(!cards.some(v => /asn終端|term/.test(v.label) || /term/.test(v.id)))
  assert.deepEqual(launchVendors(WITH_TERM).map(v => v.id), launchVendors(NO_TERM).map(v => v.id))
})

test('Gemini、Grok 一律自動用背景通道，就算那台摘要有 <id>-term 也不送 -term（收不到信的終端不再當開法）；Claude 照舊送 claude', () => {
  const f = { node: 'n1', name: 't1', cwd: 'D:/work', first: '', profile: '' }
  for (const id of ['gemini', 'grok']) {
    for (const launcher of [WITH_TERM, NO_TERM]) {
      const row = launchVendors(launcher).find(v => v.id === id)
      const auto = autoOf(row, launcher)
      assert.deepEqual([auto.run, auto.ok], ['acp', true], `${id} 自動開法`)
      assert.equal(mobileLaunch.buildLaunchRequest({ ...f, profile: row.profileId }, { run: auto.run, row, launcher }).profile, row.profileId, `${id} 送原本的 profile，不送 -term`)
    }
  }
  const c = launchVendors(WITH_TERM).find(v => v.id === 'claude')
  const auto = autoOf(c, WITH_TERM)
  assert.equal(auto.run, 'term')
  assert.equal(mobileLaunch.buildLaunchRequest({ ...f, profile: 'claude' }, { run: auto.run, row: c, launcher: WITH_TERM }).profile, 'claude')
})
