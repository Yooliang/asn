// 遠端打字因為對方還有沒處理的確認框而被拒時的結束原因 busy（20261118200000_term_view_busy.sql，#1303）。
// 靜態：只多收 busy，其餘逐字同上一版（held_prompt 那支）；回復檔逐字換回。實跑（pglite，沒裝就略過）。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = s => s.replace(/\r+\n/g, '\n')
const DIR = new URL('../supabase/migrations/', import.meta.url)
const mig = rd(fs.readFileSync(new URL('20261118200000_term_view_busy.sql', DIR), 'utf8'))
const prev = rd(fs.readFileSync(new URL('20261112300000_term_view_held_prompt.sql', DIR), 'utf8'))
const down = rd(fs.readFileSync(new URL('../supabase/sql/rollback/20261118200000_term_view_busy_down.sql', import.meta.url), 'utf8'))
const fn = s => {
  const i = s.indexOf('create or replace function public.asn_relay_term_view_stop(')
  return s.slice(i, s.indexOf('$function$;', s.indexOf('as $function$', i)) + '$function$;'.length)
}

test('靜態：只多收 busy；security definer、search_path 空、只授權 service_role；回復檔逐字換回', () => {
  assert.equal(fn(mig), fn(prev).replace("'mobile_off', 'held_prompt')", "'mobile_off', 'held_prompt', 'busy')"))
  assert.match(fn(mig), /security definer set search_path to ''/)
  assert.match(mig, /grant execute on function public\.asn_relay_term_view_stop\(text, uuid, text\) to service_role;/)
  assert.doesNotMatch(mig.replace(/^--.*$/gm, ''), /grant execute[^;]*to (anon|authenticated|public)/)
  assert.match(mig, /'mobile_off','held_prompt','busy'\]/)
  assert.equal(fn(down), fn(prev))
  assert.ok(down.indexOf("update relay.term_views set end_reason = 'rejected' where end_reason = 'busy';") < down.indexOf('add constraint term_views_reason_check'), '先改標籤再換回檢查式')
  assert.match(down, /'mobile_off','held_prompt'\]/)
  const ts = rd(fs.readFileSync(new URL('../supabase/functions/_shared/term_view_ctl.ts', import.meta.url), 'utf8'))
  assert.match(ts, /const STOP_REASONS = \[[^\]]*"busy"[^\]]*\]/, 'Edge 也要收')
})

let PGlite = null
PGlite = await fastPGlite() // 沒裝回 null（略過實跑）；其他錯誤照丟，整支失敗、不會無聲略過
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const ID = '11111111-2222-3333-4444-555555555555'

async function boot() {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.term_views(id uuid primary key, to_node text, status text, end_reason text, ended_at timestamptz,
      topic text, d_eph_pub text, d_sig text, t_eph_pub text, t_sig text);
    insert into relay.term_views(id, to_node, status, topic) values ('${ID}', 'T', 'live', 'ti_x');`)
  const q = async (t, a) => (await db.query(t, a)).rows
  const stop = async reason => (await q('select public.asn_relay_term_view_stop($1, $2, $3) r', ['T', ID, reason]))[0].r
  return { db, q, stop }
}

test('實跑：busy 結束得了、別的亂寫照舊擋；回復檔把標籤改回 rejected', { skip }, async () => {
  const { db, q, stop } = await boot()
  await db.exec(prev)
  await db.exec(mig)
  assert.equal((await stop('nope')).error, 'bad_request')
  assert.deepEqual(await stop('busy'), { ok: true })
  assert.deepEqual(await q('select status, end_reason, topic from relay.term_views'), [{ status: 'ended', end_reason: 'busy', topic: null }])
  await db.exec(down)
  assert.equal((await q('select end_reason from relay.term_views'))[0].end_reason, 'rejected')
  await db.exec(`update relay.term_views set status = 'live'`)
  assert.equal((await stop('busy')).error, 'bad_request', '回復後又不收 busy')
  assert.deepEqual(await stop('held_prompt'), { ok: true }, '回復後 held_prompt 仍可用')
})

// 全部測試都登記完才掛收尾（檔案前面若有 top-level await，太早掛會在測試開跑前就執行）
closeAtEnd()
