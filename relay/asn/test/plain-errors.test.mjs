// 錯誤轉白話集中＋空 catch 清理（#2106 ②）
// (a) 「已清理檔案」清單：這些檔不准有沒註解的空 catch（之後每張搬完就把檔加進來）
// (b) plain-errors.mjs 的字與搬之前一字不差（畫面上顯示的文字不能變）
// (c) 原檔照舊匯出同一份函式
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { agentSetupErrorText, KNOWN_PEER_FAILED_TEXT, knownPeerErrorText, plainMessage, renameErrorText } from '../ui/lib/plain-errors.mjs'
import { TEXT, errorText, renameErrorText as renameFromPeers } from '../ui/lib/mobile-known-peers.mjs'

const UI = fileURLToPath(new URL('../ui/', import.meta.url))
const read = f => fs.readFileSync(UI + f, 'utf8').replace(/\r\n/g, '\n')

// 已清理檔案：搬完一張就加進來
export const CLEANED = ['lib/voice-ui.mjs', 'lib/room-hub.mjs', 'lib/mobile-known-peers.mjs', 'lib/agent-install.mjs', 'lib/mobile-remote-view.mjs', 'shot.js', 'onboard.js', 'login.js', 'lib/relogin-flow.mjs']

// 沒有任何內容（連註解都沒有）的空 catch：catch { }、catch (e) { }、.catch(() => { })、.catch(e => { })
export const EMPTY_CATCH = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}|\.catch\(\s*(?:\([^)]*\)|\w+)\s*=>\s*\{\s*\}\s*\)/g

test('已清理的檔案：沒有沒註解的空 catch（要嘛 console.warn，要嘛留一行理由）', () => {
  for (const f of CLEANED) {
    const bad = read(f).match(EMPTY_CATCH) ?? []
    assert.deepEqual(bad, [], `${f} 有沒註解的空 catch：${bad.join(' ｜ ')}`)
  }
})

test('空 catch 偵測本身有效：會抓到四種寫法、放行有註解的', () => {
  for (const bad of ['try { a() } catch {}', 'try { a() } catch (e) { }', 'p.catch(() => {})', 'p.catch(e => { })']) assert.equal((bad.match(EMPTY_CATCH) ?? []).length, 1, bad)
  for (const ok of ['try { a() } catch { /* 理由 */ }', 'p.catch(() => { /* 理由 */ })', "try { a() } catch (e) { console.warn('[ASN]', 'x') }"]) assert.equal((ok.match(EMPTY_CATCH) ?? []).length, 0, ok)
})

test('已清理的檔案：console.warn 只記固定文字，不放變數（避免把內容、token 寫進 log）', () => {
  for (const f of CLEANED) for (const m of read(f).matchAll(/console\.warn\(([^)]*)\)/g)) assert.match(m[1], /^'\[ASN\]', '[^'$]*'$/, `${f}：${m[0]}`)
})

test('畫面文字與搬之前一字不差', () => {
  assert.equal(KNOWN_PEER_FAILED_TEXT, '操作沒有成功，請稍後再試。')
  assert.equal(TEXT.failed, '操作沒有成功，請稍後再試。')
  // 改名失敗：中文說明（≤120 字）原樣、其他說白話
  assert.equal(renameErrorText(new Error('名字太長了')), '名字太長了')
  assert.equal(renameErrorText('登入過期了，請重新登入'), '登入過期了，請重新登入')
  assert.equal(renameErrorText(new Error('HTTP 500 boom')), '操作沒有成功，請稍後再試。')
  assert.equal(renameErrorText(new Error('字'.repeat(121))), '操作沒有成功，請稍後再試。')
  assert.equal(renameErrorText(null), '操作沒有成功，請稍後再試。')
  // 確認／忘記失敗：只有「螢幕鎖」的說明原樣
  assert.equal(knownPeerErrorText(new Error('這支手機沒有設定螢幕鎖，請先設定再操作')), '這支手機沒有設定螢幕鎖，請先設定再操作')
  assert.equal(knownPeerErrorText(new Error('boom')), '操作沒有成功，請稍後再試。')
  assert.equal(knownPeerErrorText(undefined), '操作沒有成功，請稍後再試。')
  // 預設：沒有對照就是原文
  assert.equal(plainMessage(new Error('語音功能沒有回應，請再試一次。')), '語音功能沒有回應，請再試一次。')
})

test('安裝 Claude Code 失敗的畫面文字與搬之前一字不差（字串、Error、空 message 都照舊）', () => {
  assert.equal(agentSetupErrorText('已經在跑了'), '已經在跑了')
  assert.equal(agentSetupErrorText(new Error('沒有網路')), '沒有網路')
  assert.equal(agentSetupErrorText({ message: '' }), '[object Object]')
  assert.equal(agentSetupErrorText(null), 'null')
})

test('agent-install 失敗文字走 plain-errors，不自己寫轉換', () => {
  const s = read('lib/agent-install.mjs')
  assert.match(s, /import \{ agentSetupErrorText \} from '\.\/plain-errors\.mjs'/)
  assert.match(s, /const errText = agentSetupErrorText/)
  assert.doesNotMatch(s, /\.message \|\|/)
})

test('mobile-known-peers 照舊匯出同一份轉白話函式', () => {
  assert.equal(errorText, knownPeerErrorText)
  assert.equal(renameFromPeers, renameErrorText)
})

test('voice-ui 畫面上的錯誤文字走 plain-errors，不直接放 e.message', () => {
  const s = read('lib/voice-ui.mjs')
  assert.match(s, /import \{ plainMessage \} from '\.\/plain-errors\.mjs'/)
  assert.doesNotMatch(s, /state\.note = e\.message/)
  assert.equal((s.match(/state\.note = plainMessage\(e\)/g) ?? []).length, 2)
})

// ---- ④：onboard／login／relogin-flow ----
test('引導頁與本機重新登入失敗的畫面文字與搬之前一字不差', async () => {
  const { onboardErrorText, reloginErrorText } = await import('../ui/lib/plain-errors.mjs')
  assert.equal(onboardErrorText(new Error('寫入失敗')), '寫入失敗')
  assert.equal(onboardErrorText('字串'), '字串')
  assert.equal(onboardErrorText(null), 'null')
  assert.equal(onboardErrorText({ message: '' }), '')
  assert.equal(reloginErrorText('已經在跑了'), '已經在跑了')
  assert.equal(reloginErrorText(new Error('沒有網路')), '沒有網路')
  assert.equal(reloginErrorText({ message: '' }), '[object Object]')
  assert.equal(reloginErrorText(null), 'null')
})

test('onboard／login／relogin-flow：不直接 invoke(、錯誤文字走 plain-errors、指令名在出口', () => {
  const ob = read('onboard.js'), lg = read('login.js'), rf = read('lib/relogin-flow.mjs')
  for (const [n, s] of [['onboard.js', ob], ['login.js', lg], ['relogin-flow.mjs', rf]]) assert.doesNotMatch(s, /(?<![\w.$])invoke\(/, `${n} 還有直接 invoke(`)
  assert.match(ob, /failed\.value = onboardErrorText\(e\)/); assert.doesNotMatch(ob, /e\?\.message/)
  assert.match(rf, /reloginErrorText\(e\)/); assert.doesNotMatch(rf, /e\?\.message/)
  const ex = read('lib/tauri.mjs')
  for (const c of ['startup_info', 'quit_app', 'show_main', 'capture_ui_ready', 'take_shot', 'claude_mod_check', 'setup_remote_status', 'setup_remote_request']) assert.ok(ex.includes(`'${c}'`), c)
})

test('重新登入出口：指令名與參數形狀不變', async () => {
  const { makeReloginApi } = await import('../ui/lib/tauri.mjs')
  const calls = []
  const api = makeReloginApi(async (c, a) => { calls.push([c, a]); return null })
  await api.remoteStatus(); await api.remoteRequest('N1'); await api.cliLogin('claude')
  assert.deepEqual(calls, [['setup_remote_status', undefined], ['setup_remote_request', { node: 'N1', mode: 'relogin' }], ['ai_cli_login', { toolId: 'claude' }]])
})
