import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_ANON, anonRef, pickAnon, projectRef } from '../anon.mjs'

const NEW = 'https://etccgmkrosbzpltudlgt.supabase.co/functions/v1/relay'
const jwt = ref => `x.${Buffer.from(JSON.stringify({ ref, role: 'anon' })).toString('base64url')}.y`

test('內建 anon：ref 與新後台一致', () => {
  assert.equal(projectRef(NEW), 'etccgmkrosbzpltudlgt')
  assert.equal(anonRef(BUILTIN_ANON.etccgmkrosbzpltudlgt), 'etccgmkrosbzpltudlgt')
})

test('沒有任何候選＝用內建；殘留的舊專案 anon.key 會被跳過', () => {
  assert.equal(pickAnon(NEW, ['', '']), BUILTIN_ANON.etccgmkrosbzpltudlgt)
  assert.equal(pickAnon(NEW, ['', jwt('hwtahctsgjcemtwzlvnq')]), BUILTIN_ANON.etccgmkrosbzpltudlgt)
})

test('候選的 ref 對得上就用候選；認不出專案（本機假後端、非 JWT）照用候選', () => {
  const mine = jwt('etccgmkrosbzpltudlgt')
  assert.equal(pickAnon(NEW, [mine, '']), mine)
  assert.equal(pickAnon('http://127.0.0.1:5555/relay', ['fake-anon']), 'fake-anon')
  assert.equal(pickAnon('http://127.0.0.1:5555/relay', ['']), '')
  assert.equal(pickAnon(NEW, ['sb_publishable_abc']), 'sb_publishable_abc')
})
