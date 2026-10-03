// 一次性測試用：用 H 金鑰開邀請碼，註冊測試節點並把金鑰寫到 ~/.irori-relay/<id>.key（不印金鑰）
// 用法：node tools-provision.mjs <新代號> [顯示名]
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
const URL_ = 'https://hwtahctsgjcemtwzlvnq.supabase.co/functions/v1/irori-relay'
const dir = path.join(os.homedir(), '.irori-relay')
const hkey = fs.readFileSync(path.join(dir, 'H.key'), 'utf8').trim()
const id = process.argv[2], name = process.argv[3] || id
const inv = await (await fetch(`${URL_}?action=invite`, { method: 'POST', headers: { 'x-relay-key': hkey, 'content-type': 'application/json' }, body: JSON.stringify({ note: 'bridge test node' }) })).json()
if (!inv.invite) { console.log('invite failed', JSON.stringify({ ...inv, invite: undefined })); process.exit(1) }
const r = await fetch(`${URL_}?action=register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: inv.invite, id, name, kind: 'other', machine: '家用機', note: 'machine bridge test node (disposable)' }) })
const d = await r.json()
if (!d.key) { console.log('register failed', r.status, JSON.stringify({ ...d, key: undefined })); process.exit(1) }
fs.writeFileSync(path.join(dir, `${id}.key`), d.key)
console.log('registered', d.id, 'key saved')
