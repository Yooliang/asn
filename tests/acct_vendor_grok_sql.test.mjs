// Grok 帳號回報與遠端切換的 migration（20261026200000）：只放寬廠商清單，其餘保持線上現行的行為。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const mig = fs.readFileSync(new URL('../supabase/migrations/20261026200000_acct_vendor_grok.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('回報：廠商清單多 grok，額度欄位的合併（只 claude）原樣保留，沒有放寬到任意廠商', () => {
  assert.match(mig, /not in \('claude', 'codex', 'grok'\)/)
  assert.ok(mig.includes("case when v_row->>'vendor' = 'claude' then public.asn_relay_acct_quota(v_row)"), '不能丟掉額度欄位（20261024200000）')
  assert.ok(mig.includes('jsonb_array_length(p_accounts) > 20'), '仍最多 20 筆')
  assert.ok(!/not in \([^)]*'gemini'/.test(mig))
})

test('切換：廠商只認 claude 與 grok，「email 在對方回報的清單裡」改比對同一個廠商；簽章欄位與其他檢查原樣', () => {
  assert.ok(mig.includes("p_vendor is null or p_vendor not in ('claude', 'grok')"))
  assert.ok(mig.includes("e->>'vendor' = p_vendor and e->>'email' = p_email"), '不能拿別家的帳號當目標')
  assert.ok(mig.includes('v_signed boolean := public.asn_user_owns_node(p_signed_user, p_actor)'))
  assert.ok(mig.includes("(role = 'owner' or v_signed)"))
  assert.ok(mig.includes("insert into relay.account_switches (tenant_id, requested_by, node, vendor, email, signed)"))
  assert.ok(mig.includes("'rate_limited'") && mig.includes("'busy'") && mig.includes("'asn_offline'") && mig.includes("'unknown_account'"))
})

test('權限：兩支函式都只給 service_role', () => {
  for (const f of ['asn_relay_acct_report(text, jsonb)', 'asn_relay_acct_switch(text, text, text, text, uuid)']) {
    assert.ok(mig.includes(`revoke all on function public.${f} from public, anon, authenticated;`), f)
    assert.ok(mig.includes(`grant execute on function public.${f} to service_role;`), f)
  }
})
