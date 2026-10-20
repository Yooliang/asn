// 一台雲端環境住好幾位代理：roster 名單、inbox 依收件代理篩、send 的寄件人必須在名單上
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createReceiver } from '../recv.mjs'
import { loadAgents } from '../config.mjs'
import { startFakeRelay, U } from './fake-relay.mjs'
import { apiFor, rm, run, tmpEnv } from './helpers.mjs'

const KEY = { IRORI_RELAY_KEY: 'fake-grok-node-key' }

test('loadAgents：agents.json 優先於 IRORI_CLOUD_AGENTS；去重、略過收發室、status 不合法當 idle；都沒有就只有預設那位', () => {
  const a = tmpEnv('http://127.0.0.1:1', { IRORI_CLOUD_AGENTS: 'Grok, 小真 ,小真,家用收發室,' })
  try {
    assert.deepEqual(loadAgents(a.cfg).map(x => x.name), ['Grok', '小真'])
    fs.mkdirSync(a.cfg.mailDir, { recursive: true })
    fs.writeFileSync(a.cfg.agentsFile, JSON.stringify([{ name: '正見', status: 'busy', cwd_label: 'policy' }, { name: '牧陽', status: 'weird' }, '檔案']))
    assert.deepEqual(loadAgents(a.cfg), [
      { name: '正見', status: 'busy', engine: 'grok', cwd_label: 'policy' },
      { name: '牧陽', status: 'idle', engine: 'grok', cwd_label: 'grok-cloud' },
      { name: '檔案', status: 'idle', engine: 'grok', cwd_label: 'grok-cloud' },
    ])
    fs.writeFileSync(a.cfg.agentsFile, '壞掉的 json')
    assert.deepEqual(loadAgents(a.cfg).map(x => x.name), ['Grok', '小真'])
  } finally { rm(a.root) }
  const b = tmpEnv('http://127.0.0.1:1')
  try { assert.deepEqual(loadAgents(b.cfg).map(x => x.name), ['Grok']) } finally { rm(b.root) }
})

test('roster：名單上每位各一列，改 agents.json 下一次回報就生效', async () => {
  const st = await startFakeRelay()
  const a = tmpEnv(st.url, { IRORI_CLOUD_AGENTS: 'Grok,小真' })
  try {
    const rx = createReceiver({ api: apiFor(a.cfg), cfg: a.cfg, log: () => {} })
    await rx.rosterOnce()
    assert.deepEqual(st.rosters[0].agents.map(x => x.name), ['Grok', '小真'])
    fs.mkdirSync(a.cfg.mailDir, { recursive: true })
    fs.writeFileSync(a.cfg.agentsFile, JSON.stringify([{ name: '正見' }]))
    await rx.rosterOnce()
    assert.deepEqual(st.rosters[1].agents.map(x => x.name), ['正見'])
  } finally { await st.close(); rm(a.root) }
})

test('inbox --agent：只列寄給那位的；沒指定收件代理或不在名單上的算給預設那位', async () => {
  const a = tmpEnv('http://127.0.0.1:1', { IRORI_CLOUD_AGENTS: 'Grok,正見' })
  try {
    fs.mkdirSync(a.cfg.mailDir, { recursive: true })
    const m = (id, to) => JSON.stringify({ id: U(id), from_node: 'w02', from_agent: '工作機', to_agent: to, body: `信${id}`, expects_reply: true })
    fs.writeFileSync(a.cfg.inboxFile, [m(1, '正見'), m(2, null), m(3, '不存在的人'), m(4, 'Grok')].join('\n') + '\n')
    const ids = async who => (await run('inbox.mjs', ['--json', '--agent', who], { env: a.env })).stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l).id)
    assert.deepEqual(await ids('正見'), [U(1)])
    assert.deepEqual(await ids('Grok'), [U(2), U(3), U(4)])
  } finally { rm(a.root) }
})

test('send --from：必須在名單上，不在就 exit 1 且不連線', async () => {
  const st = await startFakeRelay()
  const a = tmpEnv(st.url, { ...KEY, IRORI_CLOUD_AGENTS: 'Grok,正見' })
  try {
    const ok = await run('send.mjs', ['--to', 'w02/工作機', '--body', '收到', '--no-reply', '--from', '正見', '--reply-to', U(1)], { env: a.env })
    assert.equal(ok.code, 0, ok.stderr)
    assert.equal(st.sent[0].from_agent, '正見')
    const bad = await run('send.mjs', ['--to', 'w02/工作機', '--body', 'x', '--no-reply', '--from', '冒名'], { env: a.env })
    assert.equal(bad.code, 1)
    assert.equal(st.sent.length, 1)
  } finally { await st.close(); rm(a.root) }
})
