// 版本更新記錄：CHANGELOG 解析、設定畫面條目、release.mjs 的更新說明來源、打包成離線 json、設定表單顯示。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { addChangelogSection, buildLogView, notesToLines, parseChangelog } from '../ui/lib/changelog.mjs'
import { changelogFirstSection, resolveNotes } from '../scripts/release-lib.mjs'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { updateStatus } from '../ui/lib/update.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const realLog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')

test('解析：新到舊、版本與日期、條列去掉符號、CRLF 也行、標題前的說明不算', () => {
  const log = '# 標題\r\n說明文字\r\n\r\n## 0.1.3（2026-10-22）\r\n- 甲\r\n- 乙\r\n\r\n## 0.1.2（2026-10-21）\r\n- 丙\r\n'
  assert.deepEqual(parseChangelog(log), [
    { version: '0.1.3', date: '2026-10-22', lines: ['甲', '乙'] },
    { version: '0.1.2', date: '2026-10-21', lines: ['丙'] },
  ])
  assert.deepEqual(parseChangelog(''), [])
  assert.deepEqual(parseChangelog('## 0.2.0\n- 沒日期'), [{ version: '0.2.0', date: '', lines: ['沒日期'] }])
})

test('真實的 CHANGELOG：0.1.2 到 0.1.13 都有、由新到舊、每版至少一條、純中文沒有英文夾雜的版本說明外殼', () => {
  const es = parseChangelog(realLog)
  // 不寫死最新版號（每次發版都會多一段）：最新一段＝package.json 版本，往下逐版遞減到 0.1.2
  const cur = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const last = Number(cur.split('.')[2])
  const want = Array.from({ length: last - 1 }, (_, i) => `0.1.${last - i}`)
  assert.deepEqual(es.map(e => e.version), want)
  for (const e of es) { assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/, e.version); assert.ok(e.lines.length >= 1, e.version) }
  assert.equal(changelogFirstSection(realLog).split('\n')[0].startsWith('- '), true, '最新一段可直接當 latest.json 的 notes')
})

test('目前版本：CHANGELOG 最新一段不得低於 package.json 版本', () => {
  const v = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  assert.ok(parseChangelog(realLog).some(e => e.version === v), `CHANGELOG 沒有 ${v}`)
})

test('設定畫面條目：目前版本標「目前版本」、較新未發的不顯示；有新版時放最上面標可更新並用新版說明', () => {
  const entries = parseChangelog('## 0.1.3（2026-10-23）\n- 未發\n## 0.1.2（2026-10-22）\n- 現在\n## 0.1.1（2026-10-21）\n- 舊')
  let v = buildLogView({ entries, current: '0.1.2' })
  assert.deepEqual(v.map(x => [x.version, x.tag]), [['0.1.2', 'current'], ['0.1.1', '']])
  v = buildLogView({ entries, current: '0.1.2', available: { version: '0.1.3', notes: '- 新功能\n- 修正' } })
  assert.deepEqual(v.map(x => [x.version, x.tag]), [['0.1.3', 'update'], ['0.1.2', 'current'], ['0.1.1', '']])
  assert.deepEqual(v[0].lines, ['新功能', '修正'])
  assert.equal(v[0].date, '2026-10-23')
  v = buildLogView({ entries, current: '0.1.2', available: { version: '0.1.4', notes: '' } })
  assert.deepEqual([v[0].version, v[0].lines], ['0.1.4', []])
  v = buildLogView({ entries, current: '0.1.2', available: { version: '0.1.2', notes: 'x' } })
  assert.equal(v.filter(x => x.tag === 'update').length, 0, '已是最新不標可更新')
  assert.deepEqual(buildLogView({}), [])
  assert.deepEqual(notesToLines('- 甲\n\n  乙 \n'), ['甲', '乙'])
})

test('寫進 CHANGELOG：加在最上面、同版本替換、空檔也行、多行說明變條列', () => {
  const base = '# 標題\n\n## 0.1.2（2026-10-21）\n- 舊\n'
  const a = addChangelogSection(base, { version: '0.1.3', date: '2026-10-22', notes: '甲\n乙' })
  assert.deepEqual(parseChangelog(a).map(e => [e.version, e.lines]), [['0.1.3', ['甲', '乙']], ['0.1.2', ['舊']]])
  const b = addChangelogSection(a, { version: '0.1.3', date: '2026-10-22', notes: '丙' })
  assert.deepEqual(parseChangelog(b).map(e => [e.version, e.lines]), [['0.1.3', ['丙']], ['0.1.2', ['舊']]])
  assert.deepEqual(parseChangelog(addChangelogSection('', { version: '0.1.3', date: 'd', notes: '甲' })).map(e => e.version), ['0.1.3'])
})

test('發版說明來源：沒給 --notes 用 CHANGELOG 最新一段（不改檔）；給了就寫成新段落並成為 notes', () => {
  // 不寫死版號：以 CHANGELOG 目前最新一段為準，模擬下一版
  const top = parseChangelog(realLog)[0].version
  const next = top.replace(/\d+$/, n => String(Number(n) + 1))
  const none = resolveNotes({ arg: '', changelog: realLog, version: top, date: '2026-10-21' })
  assert.equal(none.newChangelog, null)
  assert.equal(none.notes, changelogFirstSection(realLog))
  assert.ok(none.notes.startsWith('- '))
  const given = resolveNotes({ arg: '這版新增 X', changelog: realLog, version: next, date: '2026-10-22' })
  assert.equal(given.notes, '這版新增 X')
  const es = parseChangelog(given.newChangelog)
  assert.deepEqual([es[0].version, es[0].date, es[0].lines], [next, '2026-10-22', ['這版新增 X']])
  assert.equal(es[1].version, top)
  assert.equal(changelogFirstSection(given.newChangelog), '- 這版新增 X')
})

test('release.mjs --dry-run --print-notes：沒給 --notes 印 CHANGELOG 最新一段；給了印給的內容；兩者都不改 CHANGELOG', () => {
  const before = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
  const run = extra => spawnSync(process.execPath, ['scripts/release.mjs', '--dry-run', '--print-notes', ...extra], { cwd: root, encoding: 'utf8', env: { ...process.env, ASN_UPDATER_KEY_DIR: path.join(os.tmpdir(), 'asn-no-such-key-dir') } })
  const a = run([])
  assert.equal(a.status, 0, a.stderr)
  assert.equal(a.stdout.trim(), changelogFirstSection(realLog))
  const b = run(['--notes', '手動說明'])
  assert.equal(b.status, 0, b.stderr)
  assert.equal(b.stdout.trim(), '手動說明')
  assert.equal(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), before)
})

test('打包：prep.mjs 把 CHANGELOG 轉成 ui/vendor/changelog.json（跟 vendor 一樣不進 git），畫面從 vendor/ 讀', async () => {
  const p = spawnSync(process.execPath, ['scripts/prep.mjs'], { cwd: root, encoding: 'utf8' })
  assert.equal(p.status, 0, p.stderr)
  const json = JSON.parse(fs.readFileSync(path.join(root, 'ui', 'vendor', 'changelog.json'), 'utf8'))
  assert.deepEqual(json, parseChangelog(realLog))
  assert.deepEqual((await import(pathToFileURL(path.join(root, 'ui', 'vendor', 'changelog.mjs')).href)).default, json, '.mjs 版同內容')
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /ui\/vendor\//)
  const list = fs.readFileSync(path.join(root, 'ui', 'list.js'), 'utf8')
  assert.ok(list.includes("import('./vendor/changelog.mjs')") && list.includes('buildLogView('))
})

test('設定「更新」表單：開關與立即檢查照舊，下面是版本更新記錄（標籤、日期、多行）', async () => {
  globalThis.Vue = Vue
  const st = {
    autoCheck: true, upd: { checking: false, installing: false, manual: '', status: updateStatus({}) },
    log: buildLogView({
      entries: parseChangelog('## 0.1.3（2026-10-23）\n- 新甲\n## 0.1.2（2026-10-22）\n- 甲\n- 乙'),
      current: '0.1.2', available: { version: '0.1.3', notes: '- 新甲\n- 新乙' },
    }),
  }
  const html = await renderToString(Vue.createSSRApp(SettingsPanel, { st: { ...st, accounts: { savedSeq: 0 } }, catKey: 'update' }))
  assert.ok(html.includes('自動檢查更新') && html.includes('立即檢查'))
  assert.ok(html.includes('版本更新記錄'))
  assert.ok(html.indexOf('立即檢查') < html.indexOf('版本更新記錄'), '記錄在按鈕下面')
  assert.ok(html.indexOf('0.1.3') < html.indexOf('0.1.2'), '新到舊')
  for (const t of ['可更新', '目前版本', '2026-10-22', '新乙', '乙']) assert.ok(html.includes(t), t)
  const empty = await renderToString(Vue.createSSRApp(SettingsPanel, { st: { autoCheck: true, upd: { manual: '', status: updateStatus({}) }, accounts: { savedSeq: 0 } }, catKey: 'update' }))
  assert.ok(empty.includes('沒有可顯示的更新記錄'))
})
