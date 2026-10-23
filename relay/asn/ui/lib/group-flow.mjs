// 群組的各個對話框怎麼走（建立群組、邀請別人、加入群組、成員與設定）：狀態機，不碰 DOM。
// 電腦版與手機版共用同一份；畫面是 group-sheet.mjs。reactive 由頁面帶進來（Vue 的 reactive），測試用預設的原物件。
// 後台的呼叫（api）、複製到剪貼簿（copy）、開某個群組（openRoom）、重抓群組列表（refreshRooms）、名單（getFriends）、
// 某個群組的資料（getRoom）、一對一的本機對話紀錄（logOf）都由頁面帶進來，這裡不 import 任何平台的東西。
import { INVITE_NOTE, SEED_DEFAULT, addableAi, aiChoices, buildCreate, clampSeed, createError, groupErrorText, inviteBody, inviteLead, inviteView, memberRows, parseInviteInput, previewView, seedPreview } from './groups.mjs'

export const VIEWS = ['create', 'invite', 'join', 'manage']
const blank = () => ({
  view: '', busy: false, error: '', note: '',
  // 建立
  name: '', picks: [], choices: [],
  // 邀請
  target: null, seed: SEED_DEFAULT, lead: '', preview: [], step: '', link: null, copied: false,
  // 加入
  input: '', code: '', join: null,
  // 成員與設定
  roomId: '', roomName: '', members: [], addable: [], host: false, external: false, leaving: false, focusAdd: false,
})

export function createGroupFlow({ api, copy, openRoom, refreshRooms, getFriends, getRoom, logOf, reactive = x => x }) {
  const state = reactive(blank())
  const reset = (over = {}) => { Object.assign(state, blank(), over) }
  const fail = e => { state.error = groupErrorText(e?.message ?? e); state.busy = false }
  const guard = async fn => {
    if (state.busy) return
    state.busy = true; state.error = ''
    try { await fn() } catch (e) { fail(e) } finally { state.busy = false }
  }
  const close = () => reset()

  // ---------- 建立群組 ----------
  function openCreate() { reset({ view: 'create', choices: aiChoices(getFriends()) }) }
  function togglePick(key) {
    const i = state.picks.indexOf(key)
    if (i >= 0) state.picks.splice(i, 1); else state.picks.push(key)
  }
  const createProblem = () => createError(state.name, state.picks)
  const submitCreate = () => guard(async () => {
    const err = createProblem()
    if (err) { state.error = err; return }
    const r = await api.create(buildCreate(state.name, state.picks))
    const id = r?.id
    await refreshRooms()
    close()
    if (id) openRoom(id)
  })

  // ---------- 邀請別人加入（一對一或群組） ----------
  function refreshPreview() {
    const t = state.target
    state.lead = inviteLead(t, state.seed)
    state.preview = t?.type === 'friend' ? seedPreview(logOf(t.friend), t.friend?.nick, state.seed) : []
  }
  function openInvite(target) {
    reset({ view: 'invite', target, step: 'confirm', seed: SEED_DEFAULT })
    refreshPreview()
  }
  function setSeed(v) { state.seed = clampSeed(v); refreshPreview() }
  const confirmInvite = () => guard(async () => {
    const res = await api.inviteCreate(inviteBody(state.target, state.seed))
    state.link = inviteView(res)
    state.step = 'link'; state.copied = false
  })
  async function copyLink() {
    if (!state.link) return
    try { await copy(state.link.link); state.copied = true; state.note = '' } catch { state.note = '複製失敗，請長按連結自己複製。' }
  }
  const revokeInvite = () => guard(async () => {
    if (!state.link?.id) return
    await api.inviteRevoke(state.link.id)
    state.step = 'revoked'; state.link = null
  })

  // ---------- 加入群組（點連結、貼碼） ----------
  function openJoin(code = '') {
    reset({ view: 'join', input: code, step: 'input' })
    if (code) return lookup()
  }
  const lookup = () => guard(async () => {
    const code = parseInviteInput(state.input)
    if (!code) { state.error = '邀請碼看起來不對，請貼上完整的連結或邀請碼。'; return }
    const p = await api.invitePreview(code)
    state.code = code; state.join = previewView(p); state.step = 'preview'
  })
  const acceptInvite = () => guard(async () => {
    if (!state.code) return
    const r = await api.inviteAccept(state.code)
    const id = r?.room_id
    await refreshRooms()
    close()
    if (id) openRoom(id)
  })

  // ---------- 成員與設定 ----------
  function loadManage() {
    const r = getRoom(state.roomId)
    if (!r) { state.members = []; state.addable = []; return }
    state.roomName = String(r.name || '未命名的群組')
    state.members = memberRows(r.members)
    state.addable = addableAi(getFriends(), r.members)
    state.host = r.is_host === true; state.external = r.external === true
  }
  function openManage(roomId, { focusAdd = false } = {}) {
    reset({ view: 'manage', roomId, focusAdd })
    loadManage()
  }
  const afterChange = async () => { await refreshRooms(); loadManage() }
  const addAi = key => guard(async () => { await api.aiAdd(state.roomId, [key]); await afterChange() })
  const removeAi = ref => guard(async () => {
    const m = (getRoom(state.roomId)?.members ?? []).find(x => x?.mine === true && x.key === ref)
    if (!m) return
    await api.aiRemove(state.roomId, m.key); await afterChange()
  })
  const setAllow = (ref, allow) => guard(async () => {
    const m = (getRoom(state.roomId)?.members ?? []).find(x => x?.mine === true && x.key === ref)
    if (!m) return
    await api.allowOthers(state.roomId, m.key, allow === true)
    const row = state.members.find(x => x.ref === ref); if (row) row.allowOthers = allow === true
  })
  function askLeave() { state.leaving = true }
  function cancelLeave() { state.leaving = false }
  const leave = () => guard(async () => {
    await api.leave(state.roomId)
    await refreshRooms()
    close()
  })

  return { state, close, openCreate, togglePick, createProblem, submitCreate, openInvite, setSeed, confirmInvite, copyLink, revokeInvite, openJoin, lookup, acceptInvite, openManage, addAi, removeAi, setAllow, askLeave, cancelLeave, leave, INVITE_NOTE }
}