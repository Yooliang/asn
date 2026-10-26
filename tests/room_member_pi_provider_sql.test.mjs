// 群組成員的 pi 提供者（migration 20261026300000_room_member_pi_provider.sql）：只多一個 provider 欄位，其餘與上一份逐字相同。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n')
const mig = read('20261026300000_room_member_pi_provider.sql')
const prev = read('20261025000000_room_member_presence.sql')
const fnBody = src => { const i = src.indexOf('function relay.room_member_presence'); const a = src.indexOf('$function$', i); return src.slice(a + 10, src.indexOf('$function$', a + 10)).replace(/\s+/g, ' ').trim() }

test('靜態：交易內、只動 room_member_presence、不刪資料、不授權 anon／authenticated', () => {
  assert.match(mig, /^begin;$/m); assert.match(mig, /^commit;$/m)
  const code = mig.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /drop table|drop column|delete from|truncate|drop function/i)
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  assert.match(code, /revoke all on function relay\.room_member_presence/)
  assert.equal((code.match(/create or replace function/g) ?? []).length, 1, '只改一支函式')
})

test('只多 provider：拿掉那一段後，函式本體與上一份完全相同（真人與只有節點的舊成員一律不變）', () => {
  const stripped = fnBody(mig).replace(/,\s*'provider',[\s\S]*?end\)\)/, '))')
  assert.equal(stripped, fnBody(prev))
})

test('provider 條件：只有 pi、model 是「提供者/模型」、提供者只含英數與 . _ -、最多 30 字，轉小寫；不帶完整模型名', () => {
  assert.ok(mig.includes("r.engine = 'pi'"))
  assert.ok(mig.includes("position('/' in coalesce(r.model, '')) > 1"))
  assert.ok(mig.includes("lower(split_part(r.model, '/', 1)) ~ '^[a-z0-9._-]{1,30}$'"))
  assert.ok(!/'model'\s*,/.test(mig.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')), '不能把完整 model 放進輸出')
})
