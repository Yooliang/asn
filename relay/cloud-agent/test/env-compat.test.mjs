import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEnvCompat, hasRelayKey, withoutRelayEnv, SCRUB_ENV_PREFIXES } from '../env-compat.mjs'
import { resolveConfig, readKey, readAnonKey, NO_KEY_MSG } from '../config.mjs'
import { BUILTIN_ANON } from '../../machine/anon.mjs'
import { DEFAULT_URL } from '../../machine/register.mjs'
import { childEnv } from './helpers.mjs'

test('applyEnvCompat：只有舊名時複製到新名', () => {
  const { env, legacyNames } = applyEnvCompat({
    IRORI_CLOUD_HOME: '/w',
    IRORI_RELAY_KEY: 'secret-key',
    IRORI_RELAY_ID: 'grok',
  })
  assert.equal(env.ASN_CLOUD_HOME, '/w')
  assert.equal(env.ASN_RELAY_KEY, 'secret-key')
  assert.equal(env.ASN_RELAY_ID, 'grok')
  assert.ok(legacyNames.includes('IRORI_CLOUD_HOME'))
  assert.ok(hasRelayKey(env))
})

test('applyEnvCompat：新名優先於舊名', () => {
  const warns = []
  const { env, conflictNames } = applyEnvCompat({
    ASN_RELAY_URL: 'https://new.example/r',
    IRORI_RELAY_URL: 'https://old.example/r',
  }, { warn: m => warns.push(m) })
  assert.equal(env.ASN_RELAY_URL, 'https://new.example/r')
  assert.ok(conflictNames.includes('ASN_RELAY_URL'))
  assert.ok(warns.some(w => w.includes('ASN_RELAY_URL')))
  assert.ok(!JSON.stringify(warns).includes('old.example'))
})

test('applyEnvCompat：兩邊都沒有金鑰', () => {
  assert.equal(hasRelayKey({}), false)
  const cfg = resolveConfig(childEnv({ ASN_CLOUD_HOME: '/tmp/x' }))
  assert.equal(readKey(cfg, applyEnvCompat({}).env), '')
})

test('resolveConfig：舊 IRORI_* 仍可解析路徑', () => {
  const { env } = applyEnvCompat({ IRORI_CLOUD_HOME: '/tmp/root', IRORI_CLOUD_APP: '/tmp/app' })
  const cfg = resolveConfig(env)
  assert.equal(cfg.root, '/tmp/root')
})

test('withoutRelayEnv：剝離 IRORI_* 與 ASN_*', () => {
  const out = withoutRelayEnv({
    PATH: '/bin',
    ASN_RELAY_KEY: 'k',
    IRORI_RELAY_KEY: 'k2',
    ASN_CLOUD_HOME: '/h',
    OTHER: '1',
  })
  assert.equal(out.PATH, '/bin')
  assert.equal(out.OTHER, '1')
  assert.equal(out.ASN_RELAY_KEY, undefined)
  assert.equal(out.IRORI_RELAY_KEY, undefined)
  assert.ok(SCRUB_ENV_PREFIXES.includes('ASN_'))
})

test('NO_KEY_MSG 使用新名', () => {
  assert.match(NO_KEY_MSG, /ASN_RELAY_KEY/)
})

test('readAnonKey：新名優先、內建 anon、舊名 IRORI_RELAY_ANON_KEY 經 compat', () => {
  const base = DEFAULT_URL.replace(/\/+$/, '')
  const cfg = resolveConfig(childEnv({ ASN_CLOUD_HOME: '/tmp/x', ASN_RELAY_URL: base }))
  assert.equal(readAnonKey(cfg, childEnv({})), BUILTIN_ANON.etccgmkrosbzpltudlgt)
  const mine = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV0Y2NnbWtyb3NienBsdHVkbGd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI0OTk0MDUsImV4cCI6MjEwODA3NTQwNX0.custom'
  assert.equal(readAnonKey(cfg, childEnv({ ASN_RELAY_ANON_KEY: mine })), mine)
  const { env } = applyEnvCompat({ IRORI_RELAY_ANON_KEY: mine })
  assert.equal(readAnonKey(cfg, env), mine)
})
