// 封存夥伴：名單轉換、「已封存」群組、選單項目、送出與錯誤文字，以及接線守門（電腦版右鍵、手機「⋯」、Rust 指令只在對的清單、簽章）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ARCHIVE_GROUP_KEY, activeFriends, archiveHeading, archiveMenuItem, archivedFriends, archivedGroup, buildArchiveRequest, isGroupCollapsed, manageItems, runArchive, withArchivedGroup } from '../ui/lib/archive.mjs'
import { buildFriends } from '../ui/lib/roster.mjs'
import { groupHeading } from '../ui/lib/tabs.mjs'
import { rosterGroups } from '../ui/lib/mobile.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const PID = 'p_0123456789abcdef0123'
const F = (node, agent, o = {}) => ({ id: `${node}/${agent}`, node, agent, nick: agent, device: '家用機', status: 'online', engine: 'claude', ...o })

test('名單轉換：後台的 archived 旗標變成 friend.archived；沒帶（舊後台）＝沒封存；離線成員也一樣', () => {
  const members = [{ id: 'H', name: '家用機', agents: [{ name: '小文', partner_id: PID, archived: true }, { name: '小武' }], offline_agents: [{ name: '小離', archived: true }, { name: '小舊', archived: false }] }]
  const out = Object.fromEntries(buildFriends(members).map(f => [f.agent, f]))
  assert.deepEqual([out['小文'].archived, out['小武'].archived, out['小離'].archived, out['小舊'].archived], [true, false, true, false])
  assert.equal(out['小文'].partnerId, PID)
  assert.equal(out['小離'].status, 'offline')
})

test('封存與改名去重並存：同夥伴 ID 的舊名離線列只留一筆，且封存旗標跟著留下的那筆', () => {
  const members = [{ id: 'H', name: '家用機', agents: [{ name: '新名', partner_id: PID, archived: true }], offline_agents: [{ name: '舊名', partner_id: PID, archived: true }, { name: '別位', archived: false }] }]
  const f = buildFriends(members)
  assert.deepEqual(f.map(x => [x.agent, x.archived]).sort(), [['別位', false], ['新名', true]])
})

test('分流與群組：名單不含已封存；底部一個「已封存」群組，沒有已封存就沒有群組', () => {
  const list = [F('H', '甲'), F('H', '乙', { archived: true }), F('H', '丙', { archived: true, status: 'offline' }), F('H', '丁', { archived: false })]
  assert.deepEqual(activeFriends(list).map(f => f.agent), ['甲', '丁'], '保持原順序')
  assert.deepEqual(archivedFriends(list).map(f => f.agent), ['乙', '丙'])
  assert.equal(archivedGroup(activeFriends(list)), null)
  const groups = withArchivedGroup(rosterGroups(activeFriends(list), { selfNode: 'P' }), archivedFriends(list))
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0].items.map(f => f.agent), ['丁', '甲'], '一般名單沒有已封存的（照名字排）')
  const g = groups.at(-1)
  assert.deepEqual([g.key, g.kind, g.items.map(f => f.agent)], [ARCHIVE_GROUP_KEY, 'archived', ['乙', '丙']], '離線的排在後面')
  assert.equal(groupHeading(g), '已封存（2）')
  assert.equal(archiveHeading(0), '已封存（0）')
  assert.equal(withArchivedGroup([], []).length, 0)
})

test('收合：已封存群組預設收合，其他預設展開；使用者展開後照使用者的', () => {
  assert.equal(isGroupCollapsed({}, ARCHIVE_GROUP_KEY), true)
  assert.equal(isGroupCollapsed({}, 'H'), false)
  assert.equal(isGroupCollapsed({ [ARCHIVE_GROUP_KEY]: false }, ARCHIVE_GROUP_KEY), false)
  assert.equal(isGroupCollapsed({ H: true }, 'H'), true)
})

test('選單：能管理的視窗最後一項是「封存」（已封存的是「取消封存」）；離線也有；不需要電腦在線或開放；人、手機、收發室沒有', () => {
  const ctx = { machines: { H: { online: true, launcher: null } }, loaded: true, signedIn: true }
  const on = manageItems(F('H', '小文'), ctx)
  assert.deepEqual(on.map(i => i.key), ['info', 'rename', 'model', 'close', 'handover', 'archive'])
  assert.equal(on.at(-1).label, '封存')
  const off = manageItems(F('H', '小離', { status: 'offline' }), { ...ctx, machines: {} })
  assert.deepEqual(off.map(i => i.key), ['resume', 'archive'])
  assert.equal(off.at(-1).ok, true, '電腦不在線也能封存')
  const codex = manageItems(F('H', '小碼', { status: 'offline', engine: 'codex' }), ctx)
  assert.deepEqual(codex.map(i => i.key), ['archive'], '不能喚醒的離線夥伴也能封存')
  const un = manageItems(F('H', '小文', { archived: true }), ctx)
  assert.deepEqual([un.at(-1).key, un.at(-1).label], ['unarchive', '取消封存'])
  assert.deepEqual(manageItems(F('P', '手機'), { ...ctx, nonWindowNodes: ['P'] }), [])
  assert.deepEqual(manageItems(F('H', '家用收發室'), ctx), [])
  assert.deepEqual(manageItems(F('H', 'X', { room: true }), ctx), [])
  assert.equal(archiveMenuItem(F('H', 'a'), { signedIn: false }).ok, false)
  assert.match(archiveMenuItem(F('H', 'a'), { signedIn: false }).reason, /登入/)
  assert.equal(archiveMenuItem(F('H', 'a'), { supported: false }).ok, false)
})

test('送出：內容只含節點、名字、旗標與（有的話）夥伴 ID；成功與失敗都是純中文，不露節點與夥伴 ID', async () => {
  assert.deepEqual(buildArchiveRequest(F('H', '小文', { partnerId: PID }), true), { node: 'H', name: '小文', archived: true, partner_id: PID })
  assert.deepEqual(buildArchiveRequest(F('H', '小文'), false), { node: 'H', name: '小文', archived: false })
  const seen = []
  const ok = await runArchive({ partnerArchive: async b => { seen.push(b); return { ok: true, archived: true } } }, F('H', '小文', { partnerId: PID }), true)
  assert.equal(ok.ok, true); assert.match(ok.text, /已封存/); assert.doesNotMatch(ok.text, /p_[0-9a-f]{20}|\bH\b/)
  assert.deepEqual(seen, [{ node: 'H', name: '小文', archived: true, partner_id: PID }])
  assert.match((await runArchive({ partnerArchive: async () => ({ ok: true }) }, F('H', 'a'), false)).text, /取消封存/)
  const bad = async msg => await runArchive({ partnerArchive: async () => { throw new Error(msg) } }, F('H', 'a'), true)
  assert.match((await bad('尚未登入，無法封存夥伴')).text, /登入/)
  assert.match((await bad('partner_archive HTTP 404 not_found')).text, /找不到|更新/)
  assert.match((await bad('partner_archive HTTP 403 protected')).text, /收發室/)
  assert.match((await bad('partner_archive 連線失敗：timeout')).text, /網路/)
  const none = await runArchive({}, F('H', 'a'), true)
  assert.deepEqual([none.ok, /更新/.test(none.text)], [false, true], '沒有這個介面（舊版）')
})

test('接線：電腦版右鍵與手機「⋯」只用 manageItems；已封存另成群組；取消封存有入口；介面名單與 Rust 指令', () => {
  const list = read('ui/list.js'), lhtml = read('ui/list.html'), m = read('ui/m.js'), mhtml = read('ui/m.html')
  assert.match(list, /rosterShownGroups\(activeFriends\(friends\.value\), o\)/, '電腦版名單只放沒封存的')
  assert.match(list, /withArchivedGroup\(injectPendingGroups\(/)
  assert.match(list, /collapsed = reactive\(\{ \[ARCHIVE_GROUP_KEY\]: true \}\)/, '已封存預設收合')
  assert.match(list, /it\.key === 'archive' \|\| it\.key === 'unarchive'\) \{ void setArchived\(f, it\.key === 'archive'\)/)
  assert.match(lhtml, /\['resume', 'close', 'archive', 'unarchive'\]\.includes\(it\.key\) \? '' : '…'/, '封存與取消封存不加刪節號（直接執行）')
  assert.match(lhtml, /@contextmenu\.prevent="g\.kind !== 'archived' && openDeviceMenu/, '已封存群組標題沒有設備選單')
  assert.match(m, /rosterGroups\(activeFriends\(friends\.value\), o\)/, '手機名單只放沒封存的')
  assert.match(m, /collapsed = reactive\(\{ \[ARCHIVE_GROUP_KEY\]: true \}\)/)
  assert.match(m, /op === 'archive' \|\| op === 'unarchive'\) \{ history\.back\(\); void setArchived\(chatFriend\.value, op === 'archive'\)/)
  assert.match(mhtml, /v-if="g\.kind === 'archived'" :aria-label="'取消封存 ' \+ c\.nick" @click="setArchived\(c, false\)"/, '手機已封存群組每列有取消封存')
  assert.match(read('ui/lib/tauri.mjs'), /partnerArchive: body => invoke\('relay_partner_archive', \{ body \}\)/)
  assert.match(m, /partnerArchive: body => invoke\('android_partner_archive', \{ body \}\)/)
  for (const f of [lhtml, mhtml, read('ui/lib/archive.mjs')]) assert.doesNotMatch(f, /archive[^>]*\{\{\s*c\.(node|partnerId)/, '不顯示節點與夥伴 ID')
})

test('守門：Rust 指令——電腦版只在電腦清單、手機只在手機清單；都走本人簽章，沒憑證在打後台之前就回錯；後台只對簽章動作讀簽章', () => {
  const lib = read('src-tauri/src/lib.rs'), rs = read('src-tauri/src/android.rs'), relay = read('src-tauri/src/relay.rs')
  assert.match(lib, /#\[cfg\(desktop\)\]\n#\[tauri::command\]\nasync fn relay_partner_archive\([^)]*\) -> Result<Value, String> \{\n    let r = relay_of\(&app\)\?;\n    let token = account::signing_token\(&auth\)\.await;\n    r\.partner_archive_signed\(&body, token\.as_deref\(\)\)\.await/)
  const d = /#\[cfg\(desktop\)\]\n\s*let builder = builder\s*\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\);/.exec(lib)
  const mob = /#\[cfg\(not\(desktop\)\)\]\n\s*let builder = builder\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\);/.exec(lib)
  assert.match(d[1], /\brelay_partner_archive\b/); assert.doesNotMatch(d[1], /android_partner_archive/)
  assert.match(mob[1], /android::android_partner_archive/); assert.doesNotMatch(mob[1], /\brelay_partner_archive\b/, '電腦端指令不能進手機清單')
  assert.match(rs, /pub async fn android_partner_archive\b[\s\S]*?signing_token\(&auth\)\.await[\s\S]*?partner_archive_signed\(&body, token\.as_deref\(\)\)/)
  assert.match(relay, /pub async fn partner_archive_signed[\s\S]*?ok_or\("尚未登入，無法封存夥伴"\)\?;[\s\S]*?api_signed\("partner_archive"/)
  assert.match(read('../../supabase/functions/relay/index.ts'), /action === "partner_archive"\) \? await signedUserId/)
})

test('守門：m.js 裡 watch 的來源只能取用「已經定義」的變數（來源函式會立刻執行；放在 const 之前會踩到初始化前取用，整個監看失效）', () => {
  const lines = read('ui/m.js').split('\n')
  const declAt = name => lines.findIndex(l => new RegExp(`^\\s*const ${name}\\b`).test(l))
  let checked = 0
  lines.forEach((l, i) => {
    if (!/^\s*watch\(\[/.test(l)) return
    const src = l.slice(0, l.indexOf('], ') + 1)   // 只看來源陣列
    for (const m of src.matchAll(/\b(\w+)\.value\b/g)) {
      const d = declAt(m[1])
      if (d < 0) continue
      checked++
      assert.ok(d < i, `watch（第 ${i + 1} 行）用到 ${m[1]}，但它在第 ${d + 1} 行才定義`)
    }
  })
  assert.ok(checked >= 1, '至少檢查到 acct')
  assert.ok(lines.some(l => /^\s*watch\(\[\(\) => friends\.value\.length, \(\) => acct\.value\.signed_in\]/.test(l)), '補最後一句話的 watch 還在')
})

