// 畫面那條執行緒不做讀寫檔、不等網路（todo-next-191）：Tauri 2 沒標 async 的指令跑在主執行緒，
// 記憶體吃緊、磁碟在換頁時一卡幾秒，Windows 就判定「沒有回應」（11-03 asn.exe 被關、收發室跟著斷）。
// 1. 守門：同步指令（#[tauri::command] 底下不是 async fn、也沒標 (async)）的本體不准直接讀寫檔、拿帳號鎖、等網路；
//    現有還沒改的列在 PENDING，之後改掉就從清單拿掉（清單只准變短）。
// 2. 這次改的幾支一定要是非同步。
// 3. 存檔：同一個存檔名一支寫完才送下一支、內容在呼叫當下定好、前一支失敗不擋後一支。
// 注意：守門是提醒，不是保證。它只看指令本體裡直接寫的讀寫檔；把 I/O 包一層 helper、或換一種屬性寫法
// （例如 #[tauri::command(rename_all = ...)]）就掃不到。審查時仍要看同步指令實際做了什麼。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'src')

function rsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) return d.name === 'tests' ? [] : rsFiles(p)
    return d.name.endsWith('.rs') && d.name !== 'tests.rs' ? [p] : []
  })
}

// 回 [{ file, name, async, body }]：每個 Tauri 指令
function commands() {
  const out = []
  for (const file of rsFiles(SRC)) {
    const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    const re = /#\[(?:cfg_attr\(feature = "gui", )?tauri::command(\(async\))?\)?\]/g
    let m
    while ((m = re.exec(src))) {
      const after = src.slice(m.index)
      const f = /\n(?:\s*(?:#\[[^\n]*\]|\/\/[^\n]*)\n)*\s*(pub(?:\([a-z]+\))? )?(async )?fn ([a-z0-9_]+)/.exec(after)
      if (!f) continue
      const start = m.index + f.index + f[0].length
      const open = src.indexOf('{', start)
      let depth = 0, i = open
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++
        else if (src[i] === '}' && --depth === 0) break
      }
      out.push({ file: path.relative(SRC, file), name: f[3], async: Boolean(m[1] || f[2]), body: src.slice(open, i + 1) })
    }
  }
  return out
}

// 直接在本體裡做這些事＝會卡住畫面
const IO = [/std::fs::/, /\bfs::(read|write|remove|create_dir|rename|copy|metadata)/, /write_atomic\(/, /ui_log::append\(/, /\bLOCK\.lock\(\)/, /local_switch\(/, /profile_lookup/, /load_all\(/, /quota_all_with_waiting\(/, /reqwest/, /block_on\(/]
// 還沒改的同步指令（之後改成非同步就從這裡拿掉；清單只准變短）
// 這一刀只改 asn真 點名的那幾支；守門順手找出的這四支另排（todo-next-191 後續）
const PENDING = new Set(['grok_account_current', 'grok_account_switch', 'term_view_input', 'capture_ui_ready'])

test('守門：同步的 Tauri 指令本體不直接讀寫檔、拿帳號鎖、等網路（還沒改的列在 PENDING）', () => {
  const cmds = commands()
  assert.ok(cmds.length > 200, `找到的指令太少（${cmds.length}），規則可能失效`)
  const bad = cmds.filter(c => !c.async && IO.some(r => r.test(c.body))).map(c => `${c.file}:${c.name}`)
  assert.deepEqual(bad.filter(n => !PENDING.has(n.split(':')[1])), [], '這些同步指令在畫面那條執行緒上讀寫檔或等網路，請改成 async 或 #[tauri::command(async)]')
  for (const n of PENDING) assert.ok(bad.some(b => b.endsWith(':' + n)), `${n} 已經不是同步 I/O 了，請從 PENDING 拿掉`)
})

test('這次改的指令都是非同步（todo-next-191）', () => {
  const byName = new Map(commands().map(c => [c.name, c]))
  for (const n of ['store_load', 'store_save', 'ui_log', 'claude_quota_all', 'claude_accounts_list', 'claude_account_current', 'claude_account_save', 'claude_account_switch', 'claude_account_delete', 'claude_account_undo']) {
    assert.ok(byName.has(n), n)
    assert.equal(byName.get(n).async, true, n)
  }
  // 切換帳號最多等 5 秒網路：在 spawn_blocking 裡跑，不佔非同步執行緒
  assert.match(byName.get('claude_account_switch').body, /off_main\(move \|\| local_switch\(&email\)\)/)
  // 同時寫：存檔、畫面記錄各有自己的鎖
  const lib = fs.readFileSync(path.join(SRC, 'lib.rs'), 'utf8')
  assert.match(byName.get('store_save').body, /STORE_LOCK\.lock\(\)/)
  assert.match(lib, /static STORE_LOCK: std::sync::Mutex<\(\)>/)
  assert.match(fs.readFileSync(path.join(SRC, 'ui_log.rs'), 'utf8'), /static APPEND_LOCK: std::sync::Mutex<\(\)>/)
})

test('存檔：同一個存檔名照呼叫順序一支寫完才送下一支；內容在呼叫當下定好；失敗不擋後面', async () => {
  const log = []
  let release
  const prev = globalThis.__TAURI__
  globalThis.__TAURI__ = {
    core: {
      invoke: async (cmd, a) => {
        log.push(`start ${a.name} ${a.text}`)
        if (a.text === '{"n":1}') await new Promise(r => { release = r })
        if (a.text === '{"n":2}') throw new Error('磁碟滿了')
        log.push(`end ${a.name} ${a.text}`)
      },
    },
  }
  try {
    const { store } = await import(`../ui/lib/tauri.mjs?t=${Date.now()}`)
    const me = store('me'), other = store('other')
    const data = { n: 1 }
    const p1 = me.save(data)
    data.n = 99   // 呼叫之後才改的資料不影響這一次
    const p2 = me.save({ n: 2 })
    const p3 = me.save({ n: 3 })
    const q = other.save({ x: 1 })   // 別的存檔名不用等
    await q
    assert.deepEqual(log, ['start me {"n":1}', 'start other {"x":1}', 'end other {"x":1}'])
    release()
    await p1
    await assert.rejects(p2, /磁碟滿了/)
    await p3
    assert.deepEqual(log.filter(l => l.includes(' me ')), ['start me {"n":1}', 'end me {"n":1}', 'start me {"n":2}', 'start me {"n":3}', 'end me {"n":3}'])
  } finally {
    globalThis.__TAURI__ = prev
  }
})
