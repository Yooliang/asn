// 語音通話標記（畫面端）：通話中寄出的信帶結構化旗標 voice，本機記錄標上、對話畫面顯示「語音」小標示。
// 收信端怎麼用這個旗標見 relay/machine/test/voice-mail.test.mjs（抬頭）與 Rust 內建橋的測試。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { AsnCore } from '../ui/lib/core.mjs'
import { CALL_MARKER } from '../ui/lib/call-session.mjs'
import { isVoiceMsg } from '../ui/lib/voice-mark.mjs'
import { startFakeRelay } from './fake-relay.mjs'
import { httpTransport, memStore } from './helpers.mjs'

const NAME = 'T-ASN'
const members = [
  { id: 'T', agents: [{ name: NAME, status: 'idle', cwd_label: 'asn' }] },
  { id: 'W', agents: [{ name: 'W-政策', status: 'idle', cwd_label: 'policy-tw' }] },
]
const read = f => fs.readFileSync(new URL(`../ui/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

async function setup() {
  const relay = await startFakeRelay({ node: 'T', members })
  const base = httpTransport(relay.url, NAME)
  const sent = []
  const transport = { ...base, send: p => { sent.push(p); return base.send(p) } }
  const core = new AsnCore({ transport, store: memStore(), selfNode: 'T', windowName: NAME, isChatVisible: async () => false, pollMs: 60_000, rosterMs: 60_000 })
  await core.start()
  return { relay, core, sent }
}

test('寄信：send 帶 voice:true 才送旗標、本機記錄標 voice；一般寄信完全不帶', async () => {
  const { relay, core, sent } = await setup()
  const id = 'W/W-政策'
  assert.equal((await core.send(id, '打字的一句')).ok, true)
  assert.equal((await core.send(id, `${CALL_MARKER}\n語音的一句`, { voice: true })).ok, true)
  assert.equal((await core.send(id, '假旗標', { voice: 'true' })).ok, true, '只認布林 true')
  assert.equal('voice' in sent[0], false)
  assert.equal(sent[1].voice, true)
  assert.equal('voice' in sent[2], false)
  const log = core.logOf(id).filter(m => m.k === 'me')
  assert.deepEqual(log.map(m => m.voice === true), [false, true, false])
  await core.stop(); await relay.close()
})

test('小標示：本機旗標或舊記錄的通話提示行都算語音；對方的信、打字的信不算', () => {
  assert.equal(isVoiceMsg({ k: 'me', text: '嗨', voice: true }), true)
  assert.equal(isVoiceMsg({ k: 'me', text: `${CALL_MARKER}\n嗨` }), true)
  assert.equal(isVoiceMsg({ k: 'me', text: '嗨' }), false)
  assert.equal(isVoiceMsg({ k: 'them', text: `${CALL_MARKER}\n嗨` }), false)
  assert.equal(isVoiceMsg(null), false)
})

test('守門：通話兩條路徑（電腦、手機）都帶 voice 旗標；各層 send 事件把第二個參數傳下去；畫面有標示且文字純中文', () => {
  for (const f of ['lib/call-session.mjs', 'lib/mobile-call.mjs']) assert.match(read(f), /send\(`\$\{CALL_MARKER\}\\n\$\{text\}`, \{ voice: true \}\)/, f)
  assert.match(read('lib/chatpane.mjs'), /isVoiceMsg\(m\)[^>]*>🎤 語音</)
  assert.match(read('chat.js'), /voice: opts\?\.voice === true/)
  assert.match(read('list.js'), /core\.send\(c\.id, c\.text, \{ voice: c\.voice === true \}\)/)
  assert.match(read('list.js'), /const sendTo = async \(id, text, opts\) => \{ const r = await core\.send\(id, text, opts\)/)
  assert.match(read('list.html'), /\(text, opts\) => sendTo\(t\.id, text, opts\)/)
  assert.match(read('m.html'), /\(text, opts\) => sendTo\(chatFriend\.id, text, opts\)/)
  assert.match(read('m.js'), /send: async \(text, opts\) => \{ const r = await core\.send\(lastChat\.value, text, opts\)/)
  assert.match(read('m.js'), /const sendTo = async \(id, text, opts\) =>/)
})
