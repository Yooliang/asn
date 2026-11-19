import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// #1808 第 10 組守門：群組點名 Gemini審查 收不到轉交（#1366／#1486／#1602／#1685）。
// 靜態守門（比照 dup-session-guard.test.mjs）：讀 Rust 原始碼，確認「說法要準、看過不回不算失敗、上游 5xx 重試且保留原文」這些修法還在。
// 注意：#1670（#1366 關閉後仍收不到）目前沒有對應修法，這裡不守它。
const src = rel => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri/src', rel), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10))
const prod = s => s.split('#[cfg(test)]')[0]

test('#1366 守門：群組失敗通知帶出固定白話原因，而且不貼原文', () => {
  const f = prod(src('bridge/core/fail_notice.rs'))
  const fn = f.split('fn room_fail_reason')[1].split('\n}\n')[0]
  for (const k of ['需要重新登入', '額度用完了', '處理太久沒有動靜', '它想寫檔或執行指令，被擋下了', '它沒有產出回覆', '它的工作者沒在跑'])
    assert.ok(fn.includes(k), `缺原因分類：${k}`)
  const t = f.split('fn room_notice_text')[1].split('\n}\n')[0]
  assert.match(t, /room_fail_reason\(why\)/, '通知文字要用原因分類')
  assert.match(t, /轉交給 \{name\} 沒有成功：\{r\}/)
  assert.doesNotMatch(t.split('upstream_5xx')[0] + t.split('room_fail_reason')[1], /\{why\}（|：\{why\}。/, '一般通知不能把原文 why 貼進群組')
})

test('#1602 守門：上游 5xx 擋下這一輪，通知寫「那邊暫時出錯」，不寫「沒有轉交」', () => {
  const t = prod(src('bridge/core/fail_notice.rs')).split('fn room_notice_text')[1].split('\n}\n')[0]
  const five = t.split('upstream_5xx(why)')[1]
  assert.ok(five, 'room_notice_text 要判斷 upstream_5xx')
  const branch = five.split('let what')[0]
  assert.match(branch, /那邊暫時出錯（\{code\}）/)
  assert.match(branch, /收到了/)
  assert.doesNotMatch(branch, /沒有轉交給/, '5xx 分支不能說沒有轉交')
  assert.match(t, /!reply_blocked && !timed_out/, '逾時與內容過濾的說法優先於 5xx')
  assert.match(prod(src('bridge/core/fail_notice.rs')), /fn vendor_display/)
})

test('#1486 守門：群組點名給內建通道（ACP）時，沒有回覆文字＝看過不回，不當失敗', () => {
  const w = src('bridge/engines/acp_worker.rs')
  assert.match(w, /pub room: bool/, 'Job 要帶 room 旗標')
  const i = w.indexOf('text.is_empty() && job.room')
  assert.ok(i > 0, '要有「群組訊息且沒文字」的分支')
  const seg = w.slice(i, i + 900)
  assert.match(seg, /看過、不回/)
  assert.match(seg, /EngineEvent::Replied/)
  assert.doesNotMatch(seg.split('} else if')[0], /EngineEvent::Fail/, '看過不回的分支不能回報失敗')
  assert.ok(i < w.indexOf('沒有產出回覆文字'), '群組分支要排在「沒有產出回覆文字」失敗分支之前')
  const acp = src('bridge/engines/acp.rs')
  assert.match(acp, /rooms::is_room_text\(text\)/)
  assert.match(acp, /no_reply, room \}/)
})

test('#1486 守門：給內建通道的群組訊息多一行「不一定要回、不要動手」', () => {
  const r = prod(src('bridge/rooms.rs'))
  assert.match(r, /pub const ACP_ROOM_NOTE: &str = "（這是群組訊息：跟你無關就不用回/)
  assert.match(r, /不要為了這則訊息寫檔或執行指令/)
  assert.match(r, /engine_id == "acp"[\s\S]{0,80}ACP_ROOM_NOTE/)
  assert.match(r, /starts_with\("\[群組 "\)/)
})

test('#1685 守門：上游 5xx（括號 code 5xx＋HTML response 兩特徵）沒動過手時自動再試一次，仍失敗保留原文', () => {
  const p = prod(src('bridge/engines/acp_policy.rs'))
  const u = p.split('pub fn upstream_5xx')[1].split('\n}\n')[0]
  assert.match(u, /html response/)
  assert.match(u, /\(code /)
  assert.match(u, /starts_with\('5'\)/)
  const w = src('bridge/engines/acp_worker.rs')
  assert.match(w, /is_network_error\(&e\.message\) \|\| upstream_5xx\(&e\.message\)\.is_some\(\)/, '重試條件要含上游 5xx')
  assert.match(w, /still && up\.is_none\(\)/, '5xx 再試仍失敗不能改寫成「連不上」，要留原文')
  assert.match(w, /e\.had_steps \|\| cfg\.protocol != "agy-stream"/, '動過手就不重送')
  assert.match(w, /（這一輪可能做了一半）/)
})
