// 登出區塊（LogoutPanel，設定「個人」頁最下面）：真的掛載、在「已登入」狀態下查。
// 這支補回 #1763 T5 改寫時被拿掉的舊斷言：舊測試檢查原始碼裡有
//   <asn-button state="danger" :disabled="busy" @click="ask">登出</asn-button>
// 也就是①有一顆「登出」鈕、②是危險（紅）鈕、③忙的時候會變灰、④按下去先出確認（不是直接登出）。
// 這裡四件事都用實際渲染結果查，另外加上：選「只登出／登出並關閉」會送對的指令、取消不呼叫後端、沒登入也沒訊息時整塊不出現。
//
// tauri.mjs 在載入時就把 __TAURI__ 抓起來，所以要先放假的、再動態載入元件；node --test 每支測試檔各自一個行程，不會污染別支。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountComponent } from './helpers/render.mjs'
import { waitFor } from './helpers/wait-for.mjs'

const calls = []
let signedIn = true
let release = null
globalThis.__TAURI__ = {
  core: {
    invoke: async (cmd, args) => {
      calls.push([cmd, args])
      if (cmd === 'auth_status') return { signed_in: signedIn }
      if (cmd === 'autostart_get') return false
      if (cmd === 'auth_logout') return new Promise((resolve) => { release = resolve })
      return null
    },
  },
}
const { LogoutPanel } = await import('../ui/lib/login-panel.mjs')
const { LOGOUT_CANCEL_LABEL, LOGOUT_ONLY_LABEL, LOGOUT_STOP_LABEL, LOGOUT_DONE_TEXT } = await import('../ui/lib/login.mjs')

const withPanel = async (fn, { in: inState = true } = {}) => {
  calls.length = 0; release = null; signedIn = inState
  const m = mountComponent(LogoutPanel)
  try { return await fn(m) } finally { release?.(null); m.unmount() }
}
const logoutBtn = (m) => m.findAll('.logout-set button').find((b) => b.textContent.trim() === '登出') ?? null
const logoutCalls = () => calls.filter(([c]) => c === 'auth_logout')

test('已登入：渲染出一顆「登出」鈕，是危險（紅）鈕、可以按', async () => {
  await withPanel(async (m) => {
    const btn = await waitFor(() => logoutBtn(m), { what: '登出鈕出現' })
    assert.ok(btn.classList.contains('st-danger'), '危險鈕（紅）')
    assert.equal(btn.disabled, false, '閒置時可以按')
    assert.equal(m.find('[role=alertdialog]'), null, '還沒按之前沒有確認框')
  })
})

test('按「登出」先出確認框（說明＋取消／只登出／登出並關閉），不直接登出；取消不呼叫後端', async () => {
  await withPanel(async (m) => {
    await m.trigger(await waitFor(() => logoutBtn(m)), 'click')
    const ask = m.find('[role=alertdialog][aria-label="確認登出"]')
    assert.ok(ask, '出現確認登出框')
    assert.equal(logoutBtn(m), null, '確認框出現時，原本的登出鈕收起來')
    const labels = m.findAll('button', ask).map((b) => b.textContent.trim())
    assert.deepEqual(labels, [LOGOUT_CANCEL_LABEL, LOGOUT_ONLY_LABEL, LOGOUT_STOP_LABEL])
    assert.equal(logoutCalls().length, 0, '還沒選之前不登出')
    await m.trigger(m.findByText(LOGOUT_CANCEL_LABEL, 'button', ask), 'click')
    assert.equal(m.find('[role=alertdialog]'), null, '取消後框收起來')
    assert.ok(logoutBtn(m), '取消後登出鈕回來')
    assert.equal(logoutCalls().length, 0, '取消沒有呼叫後端')
  })
})

test('登出進行中（忙）：登出鈕變灰、按不動；做完恢復並顯示已登出的說明；「只登出」送 stop=false', async () => {
  await withPanel(async (m) => {
    await m.trigger(await waitFor(() => logoutBtn(m)), 'click')
    await m.trigger(m.findByText(LOGOUT_ONLY_LABEL, 'button', m.find('[role=alertdialog]')), 'click')
    assert.deepEqual(logoutCalls(), [['auth_logout', { stop: false }]], '只登出 → stop=false')
    const busyBtn = await waitFor(() => logoutBtn(m), { what: '忙的時候登出鈕回來（灰的）' })
    assert.equal(busyBtn.disabled, true, '忙的時候登出鈕變灰')
    assert.ok(busyBtn.classList.contains('st-danger'))
    await m.trigger(busyBtn, 'click')
    assert.equal(m.find('[role=alertdialog]'), null, '灰的鈕按下去不會又開確認框')
    release(null)
    await waitFor(() => m.container.textContent.includes(LOGOUT_DONE_TEXT), { what: '顯示已登出的說明' })
    assert.equal(logoutBtn(m).disabled, false, '做完後恢復可按')
  })
})

test('「登出並關閉 ASN」送 stop=true', async () => {
  await withPanel(async (m) => {
    await m.trigger(await waitFor(() => logoutBtn(m)), 'click')
    await m.trigger(m.findByText(LOGOUT_STOP_LABEL, 'button', m.find('[role=alertdialog]')), 'click')
    assert.deepEqual(logoutCalls(), [['auth_logout', { stop: true }]])
  })
})

test('沒登入、也沒有訊息：整塊登出區都不出現（沒有登出鈕）', async () => {
  await withPanel(async (m) => {
    await waitFor(() => calls.some(([c]) => c === 'auth_status'), { what: '查過登入狀態' })
    await new Promise((r) => setTimeout(r, 30))   // 讓 refresh 的非同步更新跑完，確認「查完了還是沒登入」才算數
    await m.nextTick()
    assert.equal(m.find('.logout-set'), null)
    assert.equal(logoutBtn(m), null)
  }, { in: false })
})
