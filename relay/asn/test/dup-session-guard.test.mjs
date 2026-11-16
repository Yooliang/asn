import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// 同一段對話已有活視窗（手開、被改過名字也算）時，喚醒／換班接手／自動接回／開同名夥伴都不能再開第二個（#1614）。
// 靜態守門：判斷要走共用的 live_process::session_holders，不能退回舊的「startedAt 60 秒規則」或「靜默改開新對話」
const src = rel => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri/src', rel), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10))

test('共用判斷：live_process 不用 same_process 的 60 秒規則判活', () => {
  const lp = src('launch/live_process.rs')
  assert.match(lp, /pub\(crate\) fn session_holders\(/)
  assert.doesNotMatch(lp.split('#[cfg(test)]')[0], /same_process/)
})

test('開同名夥伴：對話編號衝突回錯誤，不再悄悄改開新對話', () => {
  const r = src('launch/resume.rs').split('#[cfg(test)]')[0]
  assert.match(r, /-> Result<Option<String>, String>/)
  assert.doesNotMatch(r.split('fn live_conflict')[1].split('\n}\n')[0], /sessionId/)
  assert.match(r, /Err\(sid_conflict_error\(/)
  const local = src('launch/local.rs')
  assert.equal((local.match(/apply_resume_real\([^\n]*\)\?/g) || []).length, 2, '兩條開視窗路徑都要把錯誤往上回')
})

test('喚醒與換班接手走共用判斷', () => {
  const po = src('bridge/partner_ops.rs')
  assert.match(po, /live_process::file_holders\(/)
  assert.match(po, /live_process::session_holders\(/)
  assert.doesNotMatch(po, /self\.session_live\(s\) && \(s\.get\("name"\)[^\n]*sessionId/)
  assert.match(po, /這段對話還有另一個視窗/)
})

test('開機自動接回：判活走共用判斷，不再用心跳規則比對 sessionId', () => {
  const ar = src('launch/auto_resume.rs')
  assert.match(ar, /already_live\(/)
  assert.doesNotMatch(ar, /w\.session_id\.as_deref\(\) == session/)
})
