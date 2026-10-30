// #374 冒煙情境：兩條各自的重置時間、已過寫「可能已恢復」、手機「設備與帳號」三行卡片（含截圖）；
// 順手修：大按鈕探測式裡的 \s 寫在模板字串變成字母 s（smoke-lib 的 barProbeSource）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { BAR_PROBES, QUOTA_PROBES, SCENARIOS, barProbeSource, mcardsProbeSource, probeKind, probeSource, resetRoster, shotPath, tableFor } from '../scripts/smoke-lib.mjs'
import { resetWhen } from '../ui/lib/account-quota.mjs'

test('大按鈕探測式：去掉「▾」的正規式保留 \s（不會變成字母 s）', () => {
  const src = barProbeSource(BAR_PROBES.claude)
  assert.ok(src.includes(String.raw`.replace(/\s*▾\s*$/, '')`), '產生的程式碼要保留反斜線')
  assert.doesNotThrow(() => new vm.Script(src))
})

test('情境：電腦「我的帳號」兩條各自重置時間；已過的寫可能已恢復、不寫舊百分比', () => {
  const ok = SCENARIOS.find(s => s.name === 'list-roster-resets'), past = SCENARIOS.find(s => s.name === 'list-roster-reset-passed')
  assert.ok(ok && past)
  const now = Date.now()
  const r = resetRoster(now)
  const c = r.accounts.find(a => a.vendor === 'claude')
  assert.equal(resetWhen(c.windows[0].resets_at, now), '約 3 小時後重置')
  assert.match(resetWhen(c.windows[1].resets_at, now), /^週[日一二三四五六] \d\d:\d\d 重置$/)
  assert.deepEqual(ok.probe.want.claude.slice(0, 4), ['Claude', '5 小時', '剩 40%', '約 3 小時後重置'])
  assert.equal(ok.probe.want.claude[6], resetWhen(c.windows[1].resets_at, now))
  assert.deepEqual(past.probe.want.claude, ['Claude', '5 小時', '可能已恢復', '每週', '剩 72%'])
  assert.deepEqual(past.probe.absent.claude, ['剩 40%'])
  for (const s of [ok, past]) {
    assert.equal(probeKind(s.probe), '額度畫面檢查')
    assert.doesNotThrow(() => new vm.Script(probeSource(s.probe)))
    assert.ok(tableFor(s).acct_roster.accounts.length >= 1)
  }
})

test('情境：手機「設備與帳號」三行卡片、Max 方案、資料較舊、只有一個返回、說明在最下面，並存截圖', () => {
  const sc = SCENARIOS.find(s => s.name === 'm-acct-cards')
  assert.ok(sc)
  assert.equal(sc.page, 'm.html')
  assert.equal(probeKind(sc.probe), '手機帳號卡檢查')
  assert.doesNotThrow(() => new vm.Script(mcardsProbeSource(sc.probe)))
  assert.equal(sc.shot, 'm-acct-cards.png')
  assert.match(shotPath(sc.shot, { ASN_SMOKE_SHOTS: 'X:/shots' }), /^X:[\\/]shots[\\/]m-acct-cards\.png$/)
  assert.ok(!shotPath(sc.shot, {}).includes('asn-wt'), '預設存到暫存資料夾，不在 repo 裡')
  const t = tableFor(sc).android_acct_roster
  assert.equal(t.accounts.find(a => a.vendor === 'claude').plan, 'claude_max')
  assert.ok(t.accounts.some(a => a.windows.some(w => Date.parse(w.read_at) < Date.now() - 6 * 3600_000)), '有一張舊資料卡')
})
