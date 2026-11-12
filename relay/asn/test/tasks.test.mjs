// #539 之三：「工作項目」大按鈕——件數從個人訊息讀、header 拿掉那段、列表資料整理、前後端接線。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { headerPsm, idleCountOf, taskCountOf, taskView } from '../ui/lib/tasks.mjs'
import { buildFriends, psmOf } from '../ui/lib/roster.mjs'
import { overlayLocal } from '../ui/lib/local-status.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('件數：從個人訊息的「背景工作 N 件」讀；沒有、怪格式都是 0', () => {
  assert.equal(taskCountOf('demo・背景工作 3 件'), 3)
  assert.equal(taskCountOf('背景工作 12 件'), 12)
  assert.equal(taskCountOf('demo・背景工作 2 件・背景運行'), 2)
  for (const s of ['demo', '', null, undefined, 42, '背景工作中', '背景工作 x 件', '背景工作 0 件', `背景工作 ${'9'.repeat(30)} 件`]) assert.equal(taskCountOf(s), 0, String(s))
})

test('件數：遠端名單與本機現讀拿到的個人訊息都讀得到（不用動後台）', () => {
  const [f] = buildFriends([{ id: 'W', name: '別台', agents: [{ name: 'a', status: 'busy', cwd_label: 'proj', detail: '背景工作 4 件' }] }], { selfNode: 'H', selfName: '我' })
  assert.equal(taskCountOf(f.psm), 4)
  assert.equal(taskCountOf(psmOf({ detail: '背景工作 1 件' })), 1)
  const friends = new Map([['H/a', { id: 'H/a', node: 'H', agent: 'a', status: 'online', psm: 'proj', engine: 'claude' }]])
  const next = overlayLocal(friends, 'H', [{ name: 'a', status: 'busy', detail: '背景工作 2 件' }], new Map([['H/a', 'proj']]))
  assert.equal(taskCountOf(next.get('H/a').psm), 2)
})

test('header：拿掉「背景工作 N 件」那段，其餘個人訊息照舊', () => {
  assert.equal(headerPsm('demo・背景工作 3 件'), 'demo')
  assert.equal(headerPsm('背景工作 3 件'), '')
  assert.equal(headerPsm('背景工作 3 件・背景運行'), '背景運行')
  assert.equal(headerPsm('demo・背景工作 3 件・背景運行'), 'demo・背景運行')
  assert.equal(headerPsm('demo・背景運行'), 'demo・背景運行')
  assert.equal(headerPsm('demo・等你回答'), 'demo・等你回答')
  assert.equal(headerPsm('我的背景工作 3 件夾'), '我的背景工作 3 件夾', '不是獨立一段的不動')
  assert.equal(headerPsm(null), '')
})

test('列表資料：缺欄位、怪格式不報錯；件數取名單與查詢較大的，補「還有 N 件」', () => {
  const v = taskView({ ok: true, count: 3, items: [{ id: 'b1', description: ' 建置 ', kind: 'shell' }, { description: '' }, null, 'x', { id: 5, description: 7, kind: {} }] }, 5)
  assert.deepEqual(v.items, [
    { id: 'b1', text: '建置', kind: 'shell' },
    { id: 't1', text: '（沒有描述）', kind: '' },
    { id: 't2', text: '（沒有描述）', kind: '' },
  ])
  assert.equal(v.count, 5)
  assert.equal(v.more, 2)
  for (const q of [null, undefined, {}, { items: '壞' }, { ok: false, reason: '缺少名字' }]) {
    const e = taskView(q)
    assert.deepEqual([e.count, e.items.length, e.more], [0, 0, 0], JSON.stringify(q))
    assert.equal(e.empty, '目前沒有背景工作')
  }
  assert.equal(taskView(null, 2).more, 2, '舊版外掛（查不到列表）只顯示件數')
})

test('接線：功能列查 tasksQuery、徽章顯示件數、header 用 headerPsm；前後端指令名一致；後端只讀檔', () => {
  const bar = read('ui/lib/actionbar.mjs')
  assert.match(bar, /tasks: Boolean\(props\.api\?\.tasksQuery\)/)
  assert.match(bar, /props\.api\.tasksQuery\(\{ name: name\.value \}\)/)
  assert.match(bar, /class="ab-badge" v-if="slot\.tasks\.count > 0" :aria-label="'正在跑 ' \+ slot\.tasks\.count \+ ' 件'">\{\{ slot\.tasks\.count \}\}/, '紅數字只算在跑的；只有閒置時不畫 0')
  assert.match(bar, /<small class="ab-idle" v-if="slot\.tasks\.idle > 0" :aria-label="'閒置 ' \+ slot\.tasks\.idle \+ ' 件'">閒置 \{\{ slot\.tasks\.idle \}\}<\/small>/)
  assert.match(bar, /function onTasks\(\) \{\n\s*if \(!slot\.value\.tasks\.ok\) return/, '反灰時點了不查、不打開')
  const pane = read('ui/lib/chatpane.mjs')
  assert.match(pane, /<span class="to-psm" v-if="toPsm" v-html="emo\(toPsm\)"><\/span>/)
  assert.match(pane, /headerPsm\(props\.friend\?\.psm\)/)
  assert.match(read('ui/lib/tauri.mjs'), /tasksQuery: req => invoke\('tasks_query', \{ req \}\)/)
  const lib = read('src-tauri/src/lib.rs')
  assert.match(lib, /#\[cfg\(desktop\)\]\n#\[tauri::command\]\nasync fn tasks_query\(/)
  assert.match(lib, /subagents_query, tasks_query,/)
  const rs = read('src-tauri/src/launch/tasks.rs').split('#[cfg(test)]')[0]
  assert.ok(!/Command::new|spawn\(|fs::write|remove_file/.test(rs), '只讀檔，不寫、不刪、不啟動子程序')
})

// #1368：外掛把背景工作分成在跑與閒置，個人訊息是「背景工作 N 件・閒置 M 件」
test('閒置（#1368）：件數只算在跑的；閒置另外讀', () => {
  assert.equal(taskCountOf('demo・背景工作 2 件・閒置 3 件'), 2)
  assert.equal(idleCountOf('demo・背景工作 2 件・閒置 3 件'), 3)
  assert.equal(taskCountOf('背景工作 0 件・閒置 1 件'), 0)
  assert.equal(idleCountOf('背景工作 0 件・閒置 1 件'), 1)
  assert.equal(idleCountOf('背景工作 0 件・閒置 1 件・背景運行'), 1)
  for (const s of ['demo・背景工作 3 件', '', null, undefined, '閒置中', '我的閒置 3 件夾', '閒置 x 件']) assert.equal(idleCountOf(s), 0, String(s))
  const [f] = buildFriends([{ id: 'W', name: '別台', agents: [{ name: 'a', status: 'busy', cwd_label: 'proj', detail: '背景工作 1 件・閒置 2 件' }] }], { selfNode: 'H', selfName: '我' })
  assert.deepEqual([taskCountOf(f.psm), idleCountOf(f.psm)], [1, 2], '遠端名單一樣讀得到')
})

test('header（#1368）：「背景工作 N 件」與緊接的「閒置 M 件」一起拿掉，「・」不留多', () => {
  assert.equal(headerPsm('demo・背景工作 2 件・閒置 3 件'), 'demo')
  assert.equal(headerPsm('背景工作 0 件・閒置 1 件'), '')
  assert.equal(headerPsm('背景工作 0 件・閒置 1 件・背景運行'), '背景運行')
  assert.equal(headerPsm('demo・背景工作 2 件・閒置 3 件・背景運行'), 'demo・背景運行')
  assert.equal(headerPsm('demo・閒置 3 件'), 'demo・閒置 3 件', '沒有背景工作那段的不動')
})

test('列表資料（#1368）：分在跑與閒置兩組，各自補「還有 N 件」；沒帶 st 的當在跑', () => {
  const q = { ok: true, count: 2, idle: 3, items: [
    { id: 'b1', description: '建置', kind: 'shell', st: 'run' },
    { id: 'm1', description: '看日誌', kind: 'monitor', st: 'idle' },
    { id: 'b2', description: '舊外掛' },
    { id: 'm2', description: '舊監看', st: 'idle' },
  ] }
  const v = taskView(q, 2, 3)
  assert.deepEqual(v.items.map(i => i.id), ['b1', 'b2'])
  assert.deepEqual(v.idle, [{ id: 'm1', text: '看日誌', kind: 'monitor' }, { id: 'm2', text: '舊監看', kind: '' }])
  assert.deepEqual([v.count, v.more, v.idleCount, v.idleMore], [2, 0, 3, 1])
  assert.equal(v.idleTitle, '閒置中，可以收掉')
  assert.equal(v.idleTag, '閒置')
  const onlyIdle = taskView({ items: [{ id: 'm1', st: 'idle' }] }, 0, 1)
  assert.deepEqual([onlyIdle.count, onlyIdle.items.length, onlyIdle.idle.length, onlyIdle.more, onlyIdle.idleMore], [0, 0, 1, 0, 0])
  assert.deepEqual([taskView(null, 0, 2).idleMore, taskView(null).idleCount], [2, 0], '舊版 App 查不到列表時只顯示件數')
})

test('列表畫面（#1368）：先列在跑的，閒置收在後面一段、段落標題與每件標「閒置」', () => {
  const bar = read('ui/lib/actionbar.mjs')
  const run = bar.indexOf('v-for="it in taskList.items"'), idle = bar.indexOf('v-for="it in taskList.idle"')
  assert.ok(run > 0 && idle > run, '在跑的在前')
  assert.match(bar, /<li class="menu-note ab-idle-head" role="presentation">\{\{ taskList\.idleTitle \}\}<\/li>/)
  assert.match(bar, /v-for="it in taskList\.idle"[^\n]*<span class="ab-sub-kind">\{\{ taskList\.idleTag \}\}<\/span>/)
  assert.match(bar, /taskView\(tasks\.q, slot\.value\.tasks\.count, slot\.value\.tasks\.idle\)/)
  assert.match(bar, /v-if="!taskList\.items\.length && !taskList\.more && !taskList\.idle\.length && !taskList\.idleMore"/, '只有閒置時不顯示「目前沒有背景工作」')
})

test('大按鈕（#1368）：只有閒置、沒有在跑時不畫紅色「0」，只留小字「閒置 M」', () => {
  const bar = read('ui/lib/actionbar.mjs')
  const badgeIf = /class="ab-badge" v-if="([^"]+)"/.exec(bar)[1]
  const idleIf = /class="ab-idle" v-if="([^"]+)"/.exec(bar)[1]
  const show = (expr, tasks) => Function('slot', `return (${expr})`)({ tasks })
  const onlyIdle = { count: 0, idle: 2 }
  assert.equal(show(badgeIf, onlyIdle), false, '在跑 0、閒置 2：不畫紅數字')
  assert.equal(show(idleIf, onlyIdle), true, '小字照樣顯示')
  assert.deepEqual([show(badgeIf, { count: 3, idle: 1 }), show(idleIf, { count: 3, idle: 1 })], [true, true])
  assert.deepEqual([show(badgeIf, { count: 2, idle: 0 }), show(idleIf, { count: 2, idle: 0 })], [true, false])
})
