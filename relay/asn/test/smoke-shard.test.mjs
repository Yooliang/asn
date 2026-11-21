// #1975 冒煙分片與總數守門：切分不漏不重、彙總守門對「少一個／重複一個／少一片／空集合」都要紅
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SCENARIOS, parseShard, parseSmokeArgs, selectScenarios, shardScenarios } from '../scripts/smoke-lib.mjs'
import { checkShards, readManifests } from '../scripts/smoke-shard-gate.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const names = SCENARIOS.map(s => s.name)
const fake = n => Array.from({ length: n }, (_, i) => ({ name: `s${i}` }))
const split = (all, N) => Array.from({ length: N }, (_, i) => shardScenarios(all, { index: i + 1, count: N }).map(s => s.name))
const manifest = (shard, of, total, ns) => ({ shard, of, total, names: ns })
const goodManifests = (all, N) => split(all, N).map((ns, i) => manifest(i + 1, N, all.length, ns))

test('#1975 切分：N=1 就是全部；N=4、不整除（10、7、3、1 個情境）都不漏不重、順序穩定', () => {
  for (const total of [1, 3, 7, 10, 444]) {
    const all = fake(total)
    for (const N of [1, 2, 4, 5]) {
      const parts = split(all, N)
      const flat = parts.flat()
      assert.equal(flat.length, total, `total=${total} N=${N} 加總不對`)
      assert.deepEqual([...flat].sort(), all.map(s => s.name).sort(), `total=${total} N=${N} 有漏或重`)
      assert.equal(new Set(flat).size, total)
      // 片與片的大小最多差 1
      assert.ok(Math.max(...parts.map(p => p.length)) - Math.min(...parts.map(p => p.length)) <= 1)
      // 每片內保持原本的情境順序
      for (const p of parts) assert.deepEqual(p, [...p].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))))
    }
  }
  assert.deepEqual(shardScenarios(fake(5), null).map(s => s.name), fake(5).map(s => s.name))
  assert.deepEqual(split(fake(10), 4), [['s0', 's4', 's8'], ['s1', 's5', 's9'], ['s2', 's6'], ['s3', 's7']])
})

test('#1975 切分：真的 SCENARIOS 切 4 片，加起來剛好是全部', () => {
  const parts = split(SCENARIOS, 4)
  assert.deepEqual(parts.flat().sort(), [...names].sort())
  assert.ok(parts.every(p => p.length > 0))
})

test('#1975 --shard 參數：i/N 格式、範圍不對一律報錯，不當成不分片', () => {
  assert.deepEqual(parseShard('2/4'), { index: 2, count: 4 })
  assert.deepEqual(parseSmokeArgs(['--shard=3/4']).shard, { index: 3, count: 4 })
  assert.deepEqual(parseSmokeArgs(['--shard', '1/4', '--manifest', 'x.json']).manifest, 'x.json')
  for (const bad of ['0/4', '5/4', '1/0', '4', 'a/b', '1/4/4', '', '-1/4', '1.5/4']) assert.throws(() => parseShard(bad), /--shard 格式不對/, bad)
  assert.throws(() => parseSmokeArgs(['--shard']), /--shard 格式不對/)
  assert.throws(() => parseSmokeArgs(['--shard=9/4']), /--shard 格式不對/)
  assert.throws(() => parseSmokeArgs(['--manifest']), /--manifest/)
})

test('#1975 --only 與 --shard 可以併用：先挑再切', () => {
  const picked = selectScenarios(names.slice(0, 6))
  assert.deepEqual(split(picked, 4).flat().sort(), names.slice(0, 6).sort())
})

test('#1975 守門：四片完整相符才通過', () => {
  assert.deepEqual(checkShards(goodManifests(SCENARIOS, 4), { shards: 4, expectedNames: names }), [])
})

test('#1975 守門：某一片少跑一個情境 → 紅，並指出漏的是哪個', () => {
  const ms = goodManifests(SCENARIOS, 4)
  const dropped = ms[2].names.pop()
  const p = checkShards(ms, { shards: 4, expectedNames: names })
  assert.ok(p.some(x => x.includes(`漏跑 1 個情境：${dropped}`)), p.join('\n'))
})

test('#1975 守門：某個情境被兩片重複跑 → 紅', () => {
  const ms = goodManifests(SCENARIOS, 4)
  ms[1].names.push(ms[0].names[0])
  const p = checkShards(ms, { shards: 4, expectedNames: names })
  assert.ok(p.some(x => /重複跑了（第 1、2 片）/.test(x)), p.join('\n'))
})

test('#1975 守門：少一片（整片沒回報）→ 紅', () => {
  const ms = goodManifests(SCENARIOS, 4).slice(0, 3)
  const p = checkShards(ms, { shards: 4, expectedNames: names })
  assert.ok(p.some(x => /第 4 片沒有回報/.test(x)), p.join('\n'))
  assert.ok(p.some(x => /漏跑/.test(x)))
})

test('#1975 守門：空集合不算通過（沒有任何清單、清單全空、清單壞掉）', () => {
  assert.ok(checkShards([], { shards: 4, expectedNames: names }).length > 0)
  assert.ok(checkShards(undefined, { shards: 4, expectedNames: names }).length > 0)
  const empty = [1, 2, 3, 4].map(i => manifest(i, 4, names.length, []))
  assert.ok(checkShards(empty, { shards: 4, expectedNames: names }).some(x => /空集合/.test(x)))
  assert.ok(checkShards([null, null, null, null], { shards: 4, expectedNames: names }).length > 0)
  assert.ok(checkShards(goodManifests(SCENARIOS, 4), { shards: 4, expectedNames: [] }).length > 0, '程式裡沒有情境也不能當通過')
  assert.ok(checkShards(goodManifests(SCENARIOS, 4), { shards: 0, expectedNames: names }).length > 0)
})

test('#1975 守門：片數、總數、片號、不認得的情境不一致都要紅', () => {
  const ok = () => goodManifests(SCENARIOS, 4)
  let ms = ok(); ms[0].of = 3
  assert.ok(checkShards(ms, { shards: 4, expectedNames: names }).some(x => /與預期的 4 片不同/.test(x)))
  ms = ok(); ms[0].total = names.length - 1
  assert.ok(checkShards(ms, { shards: 4, expectedNames: names }).some(x => /全部有/.test(x)))
  ms = ok(); ms.push({ ...ms[0] })
  assert.ok(checkShards(ms, { shards: 4, expectedNames: names }).some(x => /清單出現 2 份/.test(x)))
  ms = ok(); ms[3].names[0] = '不存在的情境'
  const p = checkShards(ms, { shards: 4, expectedNames: names })
  assert.ok(p.some(x => /不認得的情境/.test(x)) && p.some(x => /漏跑/.test(x)))
  ms = ok(); ms[0].shard = 7
  assert.ok(checkShards(ms, { shards: 4, expectedNames: names }).length > 0)
})

test('#1975 守門 CLI：從資料夾（含子資料夾）讀各片清單，相符結束碼 0、少一個結束碼 1，資料夾不存在也是 1', () => {
  const run = dir => spawnSync(process.execPath, [path.join(root, 'scripts', 'smoke-shard-gate.mjs'), dir, '--shards', '4'], { encoding: 'utf8' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-shard-gate-'))
  try {
    const ms = goodManifests(SCENARIOS, 4)
    ms.forEach((m, i) => { fs.mkdirSync(path.join(dir, `smoke-manifest-${i + 1}`)); fs.writeFileSync(path.join(dir, `smoke-manifest-${i + 1}`, 'smoke-manifest.json'), JSON.stringify(m)) })
    assert.equal(readManifests(dir).length, 4)
    const ok = run(dir)
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(ok.stdout, /通過（4 片加總 \d+ 個情境/)
    ms[1].names.pop()
    fs.writeFileSync(path.join(dir, 'smoke-manifest-2', 'smoke-manifest.json'), JSON.stringify(ms[1]))
    const bad = run(dir)
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /漏跑 1 個情境/)
    assert.equal(run(path.join(dir, 'nope')).status, 1, '資料夾不存在＝沒有任何清單，要紅')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
