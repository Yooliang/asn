// Play versionCode 規則：版號×10＋尾數（正式 1、測試 0、重出 2～9），而且要比 Play 上的最大值大。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { baseCode, checkAboveMax, playVersionCode, suffixFromArgs, PLAY_SUFFIX } from '../scripts/play-version.mjs'

test('版號換算：沿用 Tauri 預設的基底再乘 10 加尾數', () => {
  assert.equal(baseCode('0.2.6'), 2006)
  assert.equal(playVersionCode('0.2.6'), 20061, '正式版尾數 1')
  assert.equal(playVersionCode('0.2.6', PLAY_SUFFIX.test), 20060, '測試版尾數 0')
  assert.equal(playVersionCode('0.2.7', PLAY_SUFFIX.test), 20070)
  assert.equal(playVersionCode('1.0.0'), 10000001)
  for (const bad of ['', '0.2', 'v0.2.6', '0.2.6-rc1', '0.1000.0', null]) assert.throws(() => playVersionCode(bad), /版號格式不對/, String(bad))
  assert.throws(() => playVersionCode('0.2.6', 10), /尾數不對/)
})

test('測試版和正式版永遠不撞號，版號往上一定變大，也一定比舊規則用過的 2006 大', () => {
  const seen = new Set()
  let prev = 2006
  for (const v of ['0.2.6', '0.2.7', '0.2.8', '0.3.0', '1.0.0']) {
    const t = playVersionCode(v, 0), r = playVersionCode(v, 1)
    assert.ok(t > prev && r > t, v)
    for (const c of [t, r]) { assert.ok(!seen.has(c), `${v} 撞號`); seen.add(c) }
    prev = playVersionCode(v, 9)
  }
})

test('命令列：預設正式、--test 測試、--reissue=2～9 重出；不合法就丟錯', () => {
  assert.equal(suffixFromArgs([]), 1)
  assert.equal(suffixFromArgs(['--upload']), 1)
  assert.equal(suffixFromArgs(['--test', '--upload']), 0)
  assert.equal(suffixFromArgs(['--reissue=2']), 2)
  assert.equal(suffixFromArgs(['--reissue=9']), 9)
  for (const bad of [['--reissue=1'], ['--reissue=10'], ['--reissue=x'], ['--test', '--reissue=3']]) assert.throws(() => suffixFromArgs(bad), undefined, bad.join(' '))
})

test('比 Play 上最大值大才可以；Play 上沒有任何版本也可以', () => {
  assert.equal(checkAboveMax(20061, 2006), null)
  assert.equal(checkAboveMax(20061, null), null)
  assert.match(checkAboveMax(20061, 20061), /沒有比 Play 上最大的 20061 大/)
  assert.match(checkAboveMax(20060, 20061), /--reissue/)
})

test('守門：release-play 用 --config 帶 versionCode、不改 tauri.conf.json；要上傳時建置前先查、上傳時帶預期值', () => {
  const src = fs.readFileSync(new URL('../scripts/release-play.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.match(src, /playVersionCode\(version, suffixFromArgs\(/)
  assert.match(src, /'--config', codeConf\]/)
  assert.doesNotMatch(src, /writeFileSync\([^)]*tauri\.conf\.json/, '不能改寫 tauri.conf.json')
  const check = src.indexOf("'--check-only'"), build = src.indexOf("'android', 'build'")
  assert.ok(check > 0 && check < build, '建置前先查 Play 最大值')
  assert.match(src, /`--expect-code=\$\{versionCode\}`\]\)\n\} else/, '上傳時帶預期的 versionCode')
})
