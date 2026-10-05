// 信件格式共用模組（mail-format.mjs）：「要不要回信」的決定規則（欄位優先、null 才看內文）、來信抬頭的 reply 欄位、
// 代寄抬頭 `[RELAY 寄信]` 的解析（含 reply=yes|no）、acp 轉接器從抬頭取 reply。純函式，不起行程；
// 橋、send.mjs、acp 轉接器的整合行為在 bridges／reply-notice／engine-contract／send／acp-* 測試裡。
// 執行：node --test relay/machine/test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NO_REPLY_RE, NO_REPLY_TIP, headReply, mailHead, parseSendHead, replyLabel, toReplyFlag, wantsReply } from '../mail-format.mjs'

const ID = '00000000-0000-0000-0000-000000000001'

test('toReplyFlag／replyLabel：true／false／yes／no 認得，null、undefined、其他都是「不知道」', () => {
  assert.deepEqual([true, 'yes', false, 'no', null, undefined, '?', 'maybe', 1, 0, ''].map(toReplyFlag), [true, true, false, false, null, null, null, null, null, null, null])
  assert.deepEqual([true, false, null, undefined].map(replyLabel), ['yes', 'no', '?', '?'])
})

test('wantsReply：欄位有明說就只看欄位（內文寫什麼都不管）；欄位是 null 才退回看舊式內文標記', () => {
  // 欄位優先：內文有標記但欄位說要等回信 → 要等；內文沒標記但欄位說不用回 → 不用
  assert.equal(wantsReply(true, '（不需回覆）內文有標記'), true)
  assert.equal(wantsReply(false, '請務必回覆我'), false)
  assert.equal(wantsReply(true, ''), true)
  assert.equal(wantsReply(false, undefined), false)
  // 過渡期相容：null／沒有欄位的舊信照內文標記
  for (const f of [null, undefined]) {
    assert.equal(wantsReply(f, '（不需回覆）純告知'), false)
    assert.equal(wantsReply(f, '純告知\n[No-Reply]'), false)
    assert.equal(wantsReply(f, '請回覆'), true)
    assert.equal(wantsReply(f, null), true)
  }
  assert.match('結尾（不需回覆）', NO_REPLY_RE)
  assert.doesNotMatch('reply=no', NO_REPLY_RE)
})

test('來信抬頭：欄位照舊、reply 加在最後（engine= 之後），前面的順序不動，舊的前綴式解析不受影響', () => {
  const m = { trust: 'member', from_node: 'W', from_agent: 'W-政策', to_agent: '視窗甲', id: ID, body: '內文', expects_reply: true }
  const head = mailHead(m, 'claude')
  assert.equal(head, `[RELAY 來信] trust=member from=W/W-政策 to=視窗甲 id=${ID} engine=claude reply=yes`)
  assert.deepEqual(/^\[RELAY 來信\][^\n]*?\bfrom=([^\s/]*)\/(\S*)/.exec(head).slice(1), ['W', 'W-政策'])
  assert.equal(/\bid=(\S+)/.exec(head)[1], ID)
  assert.equal(/\bengine=(\S+)/.exec(head)[1], 'claude')
  assert.match(head, /^\[RELAY 來信\] trust=member from=W\/W-政策 to=視窗甲 id=\S+ engine=claude/)
})

test('來信抬頭 reply：欄位 true → yes、false → no、null／沒有 → ?（只看欄位，不看內文）；預設引擎 claude；沒有寄件視窗時 from 後面是空的', () => {
  const m = (expects_reply, body = '請處理') => ({ trust: 'owner', from_node: 'XISU', id: ID, to_agent: 'T', body, expects_reply })
  assert.match(mailHead(m(true), 'codex'), / engine=codex reply=yes$/)
  assert.match(mailHead(m(false), 'codex'), / engine=codex reply=no$/)
  assert.match(mailHead(m(null)), / engine=claude reply=\?$/)
  assert.match(mailHead({ ...m(true), expects_reply: undefined }), / reply=\?$/)
  assert.match(mailHead(m(null, '（不需回覆）舊信有標記')), / reply=\?$/)   // 抬頭如實反映欄位，舊信的退路由收發室內部處理
  assert.match(mailHead(m(true)), /^\[RELAY 來信\] trust=owner from=XISU\/ to=T /)
})

test('headReply：取抬頭最後的 reply 欄位；沒有／不是來信抬頭回 null；視窗名裡自帶的 reply=no 騙不到', () => {
  const head = r => `[RELAY 來信] trust=member from=W/W-政策 to=T id=${ID} engine=gemini${r === undefined ? '' : ` reply=${r}`}`
  assert.equal(headReply(`${head('yes')}\n內文`), 'yes')
  assert.equal(headReply(`${head('no')}\n內文`), 'no')
  assert.equal(headReply(`${head('?')}\n內文`), '?')
  assert.equal(headReply(head('no')), 'no')                // 沒有內文也行
  assert.equal(headReply(`${head('no')}\r\n內文`), 'no')
  assert.equal(headReply(`${head(undefined)}\n內文`), null)   // 舊橋沒有這個欄位
  assert.equal(headReply('沒有抬頭\nreply=no'), null)
  assert.equal(headReply(`${head(undefined)}\nreply=no 在內文第二行`), null)   // 只看第一行
  assert.equal(headReply(`[RELAY 來信] trust=member from=W/x reply=no to=T id=${ID} engine=gemini reply=yes\n內文`), 'yes')   // 寄件人自填的視窗名
  assert.equal(headReply(null), null)
})

test('代寄抬頭：原有寫法照舊（to=節點、節點/視窗、re=、[RELAY 回信]、同一行後面接文字就當內文）；reply 沒寫就是 undefined', () => {
  assert.deepEqual(parseSendHead('[RELAY 寄信] to=XISU/希緒\n希緒你好'), { to_node: 'XISU', to_agent: '希緒', re: undefined, reply: undefined, body: '希緒你好' })
  assert.deepEqual(parseSendHead('[RELAY 寄信] to=XISU\n內文\n第二行'), { to_node: 'XISU', to_agent: undefined, re: undefined, reply: undefined, body: '內文\n第二行' })
  const withRe = parseSendHead(`[RELAY 回信] to=W/W-政策 re=${ID}\r\n好了`)
  assert.deepEqual([withRe.to_node, withRe.to_agent, withRe.re, withRe.reply, withRe.body], ['W', 'W-政策', ID, undefined, '好了'])
  assert.equal(parseSendHead('  \n[RELAY 寄信] to=XISU\nx').to_node, 'XISU')   // 前面有空白行也認
  assert.equal(parseSendHead('[RELAY 寄信] to=XISU 同一行的字\n下一行').body, '同一行的字\n下一行')
  assert.equal(parseSendHead('一般訊息，沒有寄信頭'), null)
  assert.equal(parseSendHead('x [RELAY 寄信] to=XISU\n內文'), null)
})

test('代寄抬頭 reply=yes|no：放最後（有無 re= 都行）、放 re= 前面也行；大小寫不拘；不認得的值當內文', () => {
  const a = parseSendHead('[RELAY 寄信] to=XISU/希緒 reply=no\n通知你一下')
  assert.deepEqual([a.to_node, a.to_agent, a.re, a.reply, a.body], ['XISU', '希緒', undefined, 'no', '通知你一下'])
  const b = parseSendHead(`[RELAY 寄信] to=W/W-政策 re=${ID} reply=yes\n好了`)
  assert.deepEqual([b.to_node, b.to_agent, b.re, b.reply, b.body], ['W', 'W-政策', ID, 'yes', '好了'])
  const c = parseSendHead(`[RELAY 回信] to=W reply=no re=${ID}\n好了`)
  assert.deepEqual([c.to_node, c.to_agent, c.re, c.reply, c.body], ['W', undefined, ID, 'no', '好了'])
  assert.equal(parseSendHead('[RELAY 寄信] to=XISU reply=NO\nx').reply, 'no')
  assert.equal(parseSendHead('[RELAY 寄信] to=XISU reply=no\r\nx').body, 'x')
  const d = parseSendHead('[RELAY 寄信] to=XISU reply=maybe\n內文')
  assert.equal(d.reply, undefined); assert.equal(d.body, 'reply=maybe\n內文')
  // 值後面要有邊界：reply=yesx／reply=nope 不能被當成 yes／no
  for (const v of ['yesx', 'nope', 'no1']) {
    const x = parseSendHead(`[RELAY 寄信] to=XISU reply=${v}\n內文`)
    assert.equal(x.reply, undefined, v); assert.equal(x.body, `reply=${v}\n內文`, v)
  }
  assert.equal(parseSendHead('[RELAY 寄信] to=XISU reply=no').reply, 'no')   // 行尾（沒有換行）也算邊界
  // 只認抬頭那一行：內文第二行開頭的 reply=no 是內文
  const e = parseSendHead('[RELAY 寄信] to=XISU\nreply=no 這是內文的第一行')
  assert.equal(e.reply, undefined); assert.equal(e.body, 'reply=no 這是內文的第一行')
})

test('逾時提醒的提示句：講明 --no-reply 與代寄的 reply=no', () => {
  assert.equal(NO_REPLY_TIP, '只是告知的信，寄件時用 --no-reply（代寄寫 reply=no）就不會提醒')
})
