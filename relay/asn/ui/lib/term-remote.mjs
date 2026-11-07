// 看別台電腦上夥伴的畫面（#597 別台看畫面）。**只能看：** 這裡沒有任何打字、貼上、按鍵的路，
// xterm 也關掉輸入（disableStdin）。畫面內容在 Rust 端解密、擋重放、再過濾過才送來；xterm 只寫入，不解析連結。
// 開始時 Rust 端先確認是本人（Windows Hello 的 PIN 或指紋；沒有 Hello 就跳確認框），之後每 15 秒在背景回報一次，不再確認。
import { frameToWrite, loadXterm, xtermOptions } from './term-view.mjs'
const { ref, onMounted, onBeforeUnmount, nextTick } = globalThis.Vue ?? {}

export const REMOTE_LABEL = '看畫面'
export const REMOTE_TIP = '看這位夥伴在那台電腦上的畫面（只能看；再按一次回到訊息）'
export const FRAME_EVENT = 'term-view-remote-frame'
export const END_EVENT = 'term-view-remote-end'
/** 到期前多久提醒（毫秒） */
export const WARN_BEFORE_MS = 60_000

export const REMOTE_TEXT = {
  pin: where => `接下來會請你確認是本人（Windows Hello 的 PIN 或指紋，沒有的話是一個確認框），用來開始看${where}的畫面。`,
  waiting: '等那台電腦回應……',
  watching: (machine, name) => `正在看「${machine}」上「${name}」的畫面（只能看）`,
  soon: '再 1 分鐘就會結束，要繼續看請結束後再按一次。',
  stop: '結束',
  again: '再看一次',
  failed: '沒有開始。',
}

/** 這位夥伴能不能從這台看：電腦版、別台電腦的、不是離線、那台在本人帳號底下而且這台能發起（avail＝電腦端回的 true／false／null） */
export function remoteEntry({ api, friend, selfNode, avail }) {
  return Boolean(api) && Boolean(friend?.node) && friend.node !== selfNode && friend?.status !== 'offline' && avail === true
}

/** 問電腦端這台能不能看那台：true／false；問不到回 null（原因只進 console） */
export async function askRemote(api, node) {
  if (!api || typeof api.available !== 'function' || !node) return null
  try {
    const r = await api.available(node)
    return typeof r === 'boolean' ? r : null
  } catch (e) {
    console.info('[ASN] 查不到這台能不能看那台的畫面', String(e?.message ?? e))
    return null
  }
}

/** 唯讀的 xterm 設定：在本機看畫面的設定上關掉輸入 */
export const remoteXtermOptions = size => ({ ...xtermOptions(size), disableStdin: true })

/** 錯誤訊息給本人看的部分：Rust 端回的已經是白話；空的就用通用的 */
export function startError(e) {
  const s = String(e?.message ?? e ?? '').trim()
  return s || REMOTE_TEXT.failed
}

export const RemoteView = {
  props: {
    api: { type: Object, required: true },        // lib/tauri.mjs 的 remoteViewApi
    node: { type: String, required: true },
    name: { type: String, required: true },       // 夥伴名（那台的視窗名）
    machine: { type: String, default: '' },       // 那台電腦的名字
    active: { type: Boolean, default: true },
  },
  setup(props) {
    const host = ref(null), phase = ref('pin'), note = ref(''), soon = ref(false)
    let id = '', term = null, offFrame = null, offEnd = null, warnTimer = 0
    const where = () => (props.machine ? `「${props.machine}」上「${props.name}」` : `「${props.name}」`)
    const onVisible = () => { if (id) void props.api.pause(id, document.visibilityState === 'hidden').catch(() => {}) }
    const cleanup = () => {
      clearTimeout(warnTimer)
      offFrame?.(); offEnd?.(); offFrame = offEnd = null
      document.removeEventListener('visibilitychange', onVisible)
      term?.dispose?.(); term = null
    }
    const finish = text => { cleanup(); phase.value = 'ended'; note.value = text; id = '' }
    const start = async () => {
      cleanup()
      phase.value = 'pin'; note.value = ''; soon.value = false
      try {
        const Terminal = await loadXterm()
        offFrame = await props.api.listen(FRAME_EVENT, ev => {
          const f = ev?.payload
          if (!f || f.id !== id || !term) return
          if (phase.value !== 'watching') phase.value = 'watching'
          term.write(frameToWrite(f))
        })
        offEnd = await props.api.listen(END_EVENT, ev => { if (ev?.payload?.id === id) finish(ev.payload.text || '') })
        const r = await props.api.start(props.node, props.name, props.machine)
        id = r.id
        phase.value = 'waiting'
        await nextTick()
        term = new Terminal(remoteXtermOptions({ cols: 120, rows: 40 }))
        term.attachCustomWheelEventHandler(() => false)
        term.open(host.value)
        document.addEventListener('visibilitychange', onVisible)
        const left = Number(r.expires_s) * 1000 - Date.now() - WARN_BEFORE_MS
        warnTimer = setTimeout(() => { soon.value = true }, Math.max(0, left))
      } catch (e) {
        console.info('[ASN] 看別台畫面沒有開始', String(e?.message ?? e))
        finish(startError(e))
      }
    }
    const stop = () => { if (id) void props.api.stop(id).catch(() => {}) }
    onMounted(() => { if (props.active) void start() })
    onBeforeUnmount(() => { stop(); cleanup() })
    return { host, phase, note, soon, where, again: start, TEXT: REMOTE_TEXT }
  },
  template: `
<div class="term-view term-remote">
  <p class="term-view-ask" role="status" v-if="phase === 'pin'">{{ TEXT.pin(where()) }}</p>
  <p class="term-view-ask" role="status" v-else-if="phase === 'waiting'">{{ TEXT.waiting }}</p>
  <p class="term-remote-bar" role="status" v-else-if="phase === 'watching'">{{ TEXT.watching(machine || node, name) }}</p>
  <p class="term-view-lost" role="status" v-if="soon && phase !== 'ended'">{{ TEXT.soon }}</p>
  <div class="term-view-screen" ref="host" aria-label="別台電腦上的畫面（只能看）" v-show="phase === 'waiting' || phase === 'watching'"></div>
  <p class="term-view-lost" role="status" v-if="phase === 'ended'">{{ note }}<button class="aero-btn" type="button" @click="again">{{ TEXT.again }}</button></p>
</div>`,
}
