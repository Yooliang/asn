// 語音通話標記 migration（20261023110000_voice_flag.sql）的靜態檢查：
// 欄位預設 false、新函式只授權 service_role 且在同一函式內寄出並標記、inbox 兩支只多回 voice（其餘與前一版逐字相同）、不動資料。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const mig = read('20261023110000_voice_flag.sql')
const prev = read('20261023050000_trust_owner_signed_only.sql')

const fn = (src, name) => {
  const m = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$function\\$;`, 'i').exec(src)
  assert.ok(m, `${name} 找不到`)
  return m[0]
}
// 去掉大小寫與新增的 voice，剩下的要和前一版相同
const norm = s => s.replace(/, 'voice', m\.voice/g, '').replace(/\s+/g, ' ').toLowerCase()

test('欄位：boolean not null default false、可重跑；整個檔在一個交易內；不刪不改資料', () => {
  assert.match(mig, /alter table relay\.messages add column if not exists voice boolean not null default false;/)
  assert.match(mig, /^begin;$/m)
  assert.match(mig, /^commit;$/m)
  const code = mig.split(String.fromCharCode(10)).filter(l => !l.startsWith('--')).join(String.fromCharCode(10))
  assert.doesNotMatch(code, /drop (function|table|column)|delete from|truncate|update relay\.messages set (?!voice = true|delivered_at = now\(\))/i)
})

test('asn_relay_send_voice：同一函式內呼叫 asn_relay_send 再標記，只標自己節點寄出的那一封；只授權 service_role', () => {
  const f = fn(mig, 'asn_relay_send_voice')
  assert.match(f, /returns jsonb\s+language plpgsql\s+security definer\s+set search_path to ''/)
  assert.ok(f.indexOf('public.asn_relay_send(') < f.indexOf('set voice = true'), '先寄出再標記')
  assert.match(f, /p_voice is true and v_r \? 'id' and not \(v_r \? 'error'\)/)
  assert.match(f, /where id = \(v_r ->> 'id'\)::uuid and from_node = p_from_node;/)
  assert.match(mig, /revoke all on function public\.asn_relay_send_voice\(text, text, text, text, text, uuid, boolean, uuid, boolean, boolean\) from public, anon, authenticated;/)
  assert.match(mig, /grant execute on function public\.asn_relay_send_voice\(text, text, text, text, text, uuid, boolean, uuid, boolean, boolean\) to service_role;/)
  assert.doesNotMatch(mig, /grant execute[^;]*to (anon|authenticated|public)/)
})

test('inbox 兩支：只多回 voice 欄位，其餘與 20261023050000 的定義逐字相同', () => {
  for (const name of ['asn_relay_inbox', 'asn_relay_inbox_agent']) {
    const now = fn(mig, name), before = fn(prev, name)
    assert.match(now, /'voice', m\.voice/, name)
    assert.equal(norm(now), norm(before), `${name} 除了 voice 之外有別的差異`)
  }
})
