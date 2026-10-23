import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { parseArgs, resolvePaths, buildArgs, verifyElf, sha256, DEFAULT_TARGET } from '../scripts/build-linux-bridge.mjs'

test('參數預設與覆寫', () => {
  assert.deepEqual(parseArgs([]), { target: DEFAULT_TARGET, skipBuild: false, targetDir: null })
  const o = parseArgs(['--skip-build', '--target', 'x86_64-unknown-linux-gnu.2.17', '--target-dir', 'X'])
  assert.equal(o.skipBuild, true)
  assert.equal(o.target, 'x86_64-unknown-linux-gnu.2.17')
  assert.equal(o.targetDir, 'X')
  assert.throws(() => parseArgs(['--nope']))
  assert.throws(() => parseArgs(['--target']))
})

test('路徑組法：環境變數與預設', () => {
  const root = path.resolve('/r')
  const d = resolvePaths({ env: {}, root })
  assert.equal(d.out, path.join(root, 'src-tauri', 'target', 'linux', 'asn-bridge'))
  assert.equal(d.built, path.join(root, 'src-tauri', 'target', DEFAULT_TARGET, 'release', 'asn-bridge'))
  const e = resolvePaths({ env: { CARGO_TARGET_DIR: '/t' }, root })
  assert.equal(e.built, path.join(path.resolve('/t'), DEFAULT_TARGET, 'release', 'asn-bridge'))
  assert.equal(e.out, d.out)
})

test('建置參數含無視窗旗標與目標', () => {
  const a = buildArgs({ manifest: 'm', target: 't' })
  assert.deepEqual(a.slice(0, 1), ['zigbuild'])
  assert.ok(a.includes('--no-default-features'))
  assert.equal(a[a.indexOf('--target') + 1], 't')
  assert.equal(a[a.indexOf('--bin') + 1], 'asn-bridge')
})

function fakeElf({ machine = 62, types = [1, 1], extra = '' } = {}) {
  const phoff = 64, ent = 56
  const b = Buffer.alloc(phoff + ent * types.length + 64)
  b.writeUInt32BE(0x7f454c46, 0); b[4] = 2; b[5] = 1
  b.writeUInt16LE(machine, 18)
  b.writeBigUInt64LE(BigInt(phoff), 32)
  b.writeUInt16LE(ent, 54); b.writeUInt16LE(types.length, 56)
  types.forEach((t, i) => b.writeUInt32LE(t, phoff + i * ent))
  return Buffer.concat([b, Buffer.from(extra)])
}

test('ELF 驗證', () => {
  assert.equal(verifyElf(fakeElf()).ok, true)
  assert.equal(verifyElf(Buffer.from('MZ')).ok, false)
  assert.equal(verifyElf(fakeElf({ machine: 183 })).ok, false)
  assert.equal(verifyElf(fakeElf({ types: [1, 3] })).info.hasInterp, true)
  assert.equal(verifyElf(fakeElf({ types: [1, 2] })).ok, false)
  assert.equal(verifyElf(fakeElf({ extra: 'libwebkit2gtk' })).ok, false)
})

test('sha256', () => {
  assert.equal(sha256(Buffer.from('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})
