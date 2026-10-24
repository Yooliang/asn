// 網頁核准頁的畫面程式。登入憑證只放在這個模組的變數（記憶體），不寫任何儲存空間；
// 登入往返（跳去 Google／GitHub 再回來）只暫存「驗證碼、state、短碼、名字」，回來讀完就清掉。
// 不寫 console。暴力防護由後台負責（每帳號輸錯 5 次鎖 15 分鐘），這裡只把後台的拒絕原樣告訴使用者，不自動重試。
import * as L from './logic.mjs'

const $ = id => document.getElementById(id)
const KEY = 'asn-link-stash'
let token = null
let busy = false

const stashRead = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null') } catch { return null } }
const stashClear = () => { try { sessionStorage.removeItem(KEY) } catch { /* 沒有儲存空間就算了 */ } }
const stashWrite = o => { try { sessionStorage.setItem(KEY, JSON.stringify(o)) } catch { /* 同上 */ } }

function say(text) { $('msg').textContent = text; $('msg').hidden = !text }
function show() {
  $('login-box').hidden = !!token
  $('approve-box').hidden = !token
  $('who').textContent = token ? '已登入。確認短碼沒錯後，按「核准」：' : ''
}
function lock(on) { busy = on; for (const b of document.querySelectorAll('button')) b.disabled = on }

async function post(url, init) {
  try {
    const r = await fetch(url, { ...init, cache: 'no-store', referrerPolicy: 'no-referrer', credentials: 'omit' })
    return { status: r.status, body: await r.json().catch(() => null) }
  } catch { return { status: 0, body: null } }
}

async function startLogin(provider) {
  if (busy) return
  const userCode = L.normalizeUserCode($('code').value)
  const verifier = L.newVerifier(), state = L.newState()
  const url = L.buildAuthorizeUrl({ provider, state, challenge: await L.challengeOf(verifier) })
  if (!url) return say('不支援這種登入方式')
  stashWrite({ v: verifier, s: state, c: userCode ?? '', n: $('name').value, i: $('nodeid').value })
  location.assign(url)
}

async function finishLogin(authCode, state) {
  const stash = stashRead()
  stashClear()                       // 一次性：不管成敗都不留
  history.replaceState(null, '', '/link/' + (stash?.c ? '?code=' + stash.c : ''))
  if (stash) { $('code').value = stash.c || ''; $('name').value = stash.n || $('name').value; $('nodeid').value = stash.i || '' }
  if (!L.checkReturn(stash, state).ok) return say('登入沒有完成（這次登入的資料對不上），請再按一次登入')
  const r = L.buildTokenRequest({ authCode, verifier: stash.v })
  const { status, body } = await post(r.url, r.init)
  token = L.tokenFromReply(status, body)
  if (!token) say(status === 0 ? L.errorText('network') : '登入沒有成功，請再試一次')
}

async function approve(ev) {
  ev.preventDefault()
  if (busy) return
  say('')
  const req = L.buildApproveRequest({ token, userCode: $('code').value, name: $('name').value, nodeId: $('nodeid').value })
  if (req.error) return say(req.error)
  lock(true)
  const reply = await post(req.url, req.init)
  const res = L.readApproveReply(reply.status, reply.body)
  lock(false)
  if (res.ok) {
    token = null
    $('form').hidden = true
    $('warn').hidden = true
    $('done').textContent = `已核准「${res.name || res.id}」（節點代號 ${res.id}）。回到主機畫面，幾秒內會自動完成；這個頁面可以關掉了。`
    $('done').hidden = false
    history.replaceState(null, '', '/link/')
    return
  }
  if (L.isLoginProblem(res.code)) token = null
  say(res.text)
  show()
}

async function main() {
  const c = L.classifyReturn(location.search)
  if (c.kind === 'code') { $('code').value = c.userCode }
  else if (c.kind === 'oauth') await finishLogin(c.authCode, c.state)
  else if (c.kind === 'oauth_error') { stashClear(); history.replaceState(null, '', '/link/'); say('登入沒有完成，請再按一次登入') }
  show()
  for (const b of document.querySelectorAll('[data-provider]')) b.addEventListener('click', () => startLogin(b.dataset.provider))
  $('form').addEventListener('submit', approve)
}
main()
