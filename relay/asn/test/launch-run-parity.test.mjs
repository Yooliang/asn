// 開新夥伴「運行」：手機與電腦版（遠端開）名稱、可選與否、預設完全同一份，不在頁面裡另外改名；手機多一行「前台或背景」的說明，只有手機有
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { MODEL_CATALOG, RUN_OPTION_LABEL, customRunOptions, runOptions } from '../ui/lib/model-catalog.mjs'
import { remoteModelRows } from '../ui/lib/partner-launch-ui.mjs'
import { LAUNCH_DISPLAY_NOTE, launchRun, launchVendors, showDisplayNote } from '../ui/lib/mobile-launch.mjs'

const read = f => fs.readFileSync(new URL(`../ui/${f}`, import.meta.url), 'utf8')
const LABELS = Object.values(RUN_OPTION_LABEL)
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '').replace(/<!--[\s\S]*?-->/g, '')

test('四個運行名稱只定義在 model-catalog，兩邊頁面與邏輯檔都沒有自己寫一份', () => {
  assert.equal(LABELS.length, 4)
  for (const f of ['m.html', 'm.js', 'lib/mobile-launch.mjs', 'list.html', 'list.js', 'lib/partner-launch-ui.mjs']) {
    const src = stripComments(read(f))
    for (const l of LABELS) {
      assert.ok(!src.includes(`'${l}'`) && !src.includes(`"${l}"`) && !src.includes(`\`${l}\``), `${f} 不該自己寫「${l}」`)
      if (f.endsWith('.html')) assert.ok(!src.includes(l), `${f} 不該出現「${l}」`)
    }
    assert.ok(!/label\s*[:=]\s*RUN_OPTION_LABEL|RUN_OPTION_LABEL\s*\[[^\]]+\]\s*=/.test(src), `${f} 不該改運行名稱`)
  }
})

test('兩邊都直接顯示 c.label，選項清單都來自 launchRun（再往下是 runOptions／customRunOptions）', () => {
  const m = read('m.html'), l = read('list.html')
  assert.ok(/v-for="c in lchRun\.options"[\s\S]*?<span class="m-opt-t">\{\{ c\.label \}\}<\/span>/.test(m), '手機要顯示 c.label')
  assert.ok(/v-for="c in partnerRun\.options"[\s\S]*?\{\{ c\.label \}\}/.test(l), '電腦版要顯示 c.label')
  assert.match(read('m.js'), /const lchRun = computed\(\(\) => launchRun\(lchRow\.value, lchLauncher\.value\)\)/)
  assert.match(read('list.js'), /const r = launchRun\(row, dlgRemoteLauncher\.value\)/)
  assert.match(read('list.js'), /runOptions\(row, \{ local: partnerDlg\.node === info\.node/)
  assert.match(read('list.js'), /customRunOptions\(row\)/)
  const lib = stripComments(read('lib/mobile-launch.mjs'))
  assert.match(lib, /return customRunOptions\(row\)/); assert.match(lib, /runOptions\(row, \{ local: false/)
  // 預設選取也是同一個欄位（selected），兩邊都用它挑
  assert.match(read('m.js'), /pickedRun\(lchRun\.value, lch\.run\)/)
  assert.match(read('list.js'), /partnerRun\.value\.selected/)
})

// 電腦版對別台的做法（list.js 的 partnerRun）：launchRun 的結果加上 self 旗標；手機直接用 launchRun
const desktopRemote = (row, launcher) => { const r = launchRun(row, launcher); return { selected: r.selected, options: r.options.map(o => ({ ...o, self: o.key === 'self' })) } }
const project = r => ({ selected: r.selected, options: r.options.map(o => ({ key: o.key, label: o.label, ok: o.ok, why: o.why, note: o.note })) })

test('同一列模型、同一台電腦：手機與電腦版的運行名稱、可選與否、預設完全一樣（每個目錄列、有無 pi 各一遍）', () => {
  const launchers = [
    { profiles: MODEL_CATALOG.map(m => ({ id: m.profileId })), cwd_allow: ['D:/work'] },
    { profiles: MODEL_CATALOG.filter(m => m.id !== 'pi').map(m => ({ id: m.profileId })), cwd_allow: ['D:/work'] },
    { profiles: MODEL_CATALOG.map(m => ({ id: m.profileId })), cwd_allow: ['D:/work'], pi_models: [{ provider: 'anthropic', model: 'claude-sonnet' }] },
  ]
  let n = 0
  for (const launcher of launchers) {
    for (const row of launchVendors(launcher)) {
      const phone = launchRun(row, launcher), desk = desktopRemote(row, launcher)
      assert.deepEqual(project(desk), project(phone), `${row.id}`)
      assert.deepEqual(phone.options.map(o => o.label), phone.options.map(o => RUN_OPTION_LABEL[o.key]), `${row.id} 名稱要照目錄`)
      n++
    }
  }
  assert.ok(n >= MODEL_CATALOG.length)
  // 目錄每一列對遠端（local:false）直接算 runOptions：名稱與順序一致，預設一致
  for (const row of MODEL_CATALOG) {
    const launcher = { profiles: [{ id: row.profileId }], cwd_allow: ['D:/work'] }
    const vendor = remoteModelRows(launcher)[0]   // 不經廠牌清單（pi 是通道、不列為廠牌），直接用那台回報的這一列
    const phone = launchRun(vendor, launcher)
    const base = runOptions(vendor, { local: false, piInstalled: row.id === 'pi', piReady: false })
    assert.deepEqual(phone.options.map(o => [o.key, o.label, o.ok]), base.options.map(o => [o.key, o.label, o.ok]), `${row.id} 手機對照目錄`)
    assert.equal(phone.selected, base.selected, `${row.id} 預設`)
  }
  // 自訂設定（目錄上沒有）：兩邊都走 customRunOptions
  for (const mode of ['window', 'background']) {
    const launcher = { profiles: [{ id: 'my-tool', mode }], cwd_allow: ['D:/work'] }
    const row = launchVendors(launcher).find(v => v.id === 'my-tool')
    assert.deepEqual(project(desktopRemote(row, launcher)), project(launchRun(row, launcher)))
    assert.deepEqual(launchRun(row, launcher).options.map(o => o.label), customRunOptions(row).options.map(o => o.label))
  }
})

test('「前台或背景」的說明：給使用者看、不含數字與英文，只有手機頁面有，只在 asn終端兩種運行出現', () => {
  assert.equal(LAUNCH_DISPLAY_NOTE, '會照那台電腦的設定，開在前台或背景')
  assert.doesNotMatch(LAUNCH_DISPLAY_NOTE, /[0-9#A-Za-z]/)
  for (const k of ['term', 'pi']) assert.equal(showDisplayNote(k), true, k)
  for (const k of ['acp', 'self', '', null, undefined]) assert.equal(showDisplayNote(k), false, String(k))
  // 只能開在前台的模型（pi）：選哪一種運行都不顯示
  const pi = MODEL_CATALOG.find(r => r.id === 'pi')
  assert.equal(pi.foregroundOnly, true)
  for (const k of ['term', 'pi']) assert.equal(showDisplayNote(k, pi), false, `pi ${k}`)
  assert.equal(showDisplayNote('term', MODEL_CATALOG.find(r => r.id === 'claude')), true)
  const m = read('m.html')
  assert.ok(m.includes('v-if="showDisplayNote(lchRunKey, lchRow)">{{ LAUNCH_DISPLAY_NOTE }}</p>'))
  assert.ok(!m.includes(LAUNCH_DISPLAY_NOTE), '字串不寫在頁面裡')
  for (const f of ['list.html', 'list.js', 'lib/partner-launch-ui.mjs']) {
    const s = read(f)
    assert.ok(!s.includes(LAUNCH_DISPLAY_NOTE) && !s.includes('LAUNCH_DISPLAY_NOTE') && !s.includes('showDisplayNote'), `${f} 不該有這行說明`)
  }
})
