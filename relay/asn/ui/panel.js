// 指引／設定的獨立視窗（分離模式）：只顯示，狀態與動作都交給名單視窗裡的樞紐（用事件溝通，跟 chat.js 同一套）。
//   ?kind=guide  ＝ 指引視窗：asn:panel 事件告訴它現在顯示哪一篇
//   ?kind=setting＝ 設定視窗：asn:panel 告訴它顯示哪一類，asn:settings 送來設定快照，改了什麼用 asn:set 送回樞紐
// 設定值、金鑰、存檔都不在這扇視窗；唯一在這裡做的事是把選的圖裁成大頭貼（純畫面運算），裁好再交給樞紐上傳。
import { LineIcon } from './lib/line-icons.mjs'
import { blockContextMenu } from './lib/nomenu.mjs'
import { GuideDoc } from './lib/guide-doc.mjs'
import { SettingsPanel } from './lib/settings-panel.mjs'
import { PANEL_KINDS, panelItem, panelTitle } from './lib/panels.mjs'
import { selfAvatarSrc } from './lib/avatar.mjs'
import { plainMessage } from './lib/plain-errors.mjs'
import { avatarFromFile } from './lib/avatar-canvas.mjs'
import { RESIZE_DIRS, ctl, emit, fpShowCancel, initFrame, knownDeviceApi, listen, resizeFrom } from './lib/tauri.mjs'
import { installUiLog } from './lib/ui-log.mjs'
import { FpQrCanvas, QR_TEXT, normalizeQr } from './lib/fp-qr.mjs'
import { FP_SHOW_TEXT, FP_SHOW_WINDOW_MS, groupFp16 } from './lib/fp-show.mjs'
import { AsnButton } from './lib/ui-kit.mjs'
// 這個視窗的 [ASN] 記錄也寫進 ui.log（#2106 ⑥），行裡帶視窗名
installUiLog({ source: 'panel' })

const { createApp, ref, reactive, computed, onMounted } = Vue
await initFrame()
const qs = new URLSearchParams(location.search)
const q = qs.get('kind')
// ?kind=fpshow＝手機正在核對這台的指紋（#1863）：只由 Rust 的領取迴圈開關，不是分頁、不跟樞紐打招呼
const kind = q === 'fpshow' ? 'fpshow' : PANEL_KINDS.includes(q) ? q : 'guide'

// 核對指紋的視窗：請求編號與到期時間（毫秒）由 Rust 放在網址，新的請求取代舊的時用 asn:fpshow 換；QR 與指紋向本機要
function useFpShow() {
  const until0 = Number(qs.get('until'))
  const fps = reactive({ id: qs.get('id') ?? '', until: Number.isFinite(until0) && until0 > 0 ? until0 : Date.now() + FP_SHOW_WINDOW_MS, left: 0, qr: null, fp: '', err: '', busy: false })
  const tickLeft = () => { fps.left = Math.min(FP_SHOW_WINDOW_MS, Math.max(0, fps.until - Date.now())) }   // 最多顯示 5 分鐘（請求的壽命）
  const load = async () => {
    try {
      const qr = normalizeQr(await knownDeviceApi.ownFingerprintQr())
      if (!qr) throw new Error('bad_qr_rows')
      fps.qr = qr
    } catch (e) { console.info('[ASN] 指紋 QR Code 做不出來', String(e?.message ?? e)); fps.err = FP_SHOW_TEXT.pcQrFailed }
    try { fps.fp = groupFp16(String(await knownDeviceApi.ownFingerprint() ?? '').slice(0, 16)) } catch (e) { console.info('[ASN] 這台的指紋讀不到', String(e?.message ?? e)) }
  }
  listen('asn:fpshow', p => { if (typeof p?.id === 'string') { fps.id = p.id; fps.busy = false } if (Number.isFinite(p?.until)) fps.until = p.until; tickLeft() })
  const fpsCancel = async () => {
    if (fps.busy || !fps.id) return
    fps.busy = true
    try { await fpShowCancel(fps.id) } catch (e) { console.info('[ASN] 取消核對沒送出，直接關窗', String(e?.message ?? e)); ctl('close') }
  }
  tickLeft()
  setInterval(tickLeft, 1000)
  void load()
  return { fps, fpsCancel }
}

const app = createApp({
  setup() {
    const key = ref(''), snap = ref(null), settings = ref(null), avatars = ref({}), localMsg = ref('')
    const item = computed(() => panelItem(kind, key.value))
    const title = computed(() => panelTitle(kind, key.value))
    // 頭像上傳時選到壞圖的訊息在這裡產生（裁圖在這扇視窗），其餘訊息由樞紐的快照帶來
    const st = computed(() => (settings.value ? { ...settings.value, avMsg: localMsg.value || settings.value.avMsg } : null))
    const meAv = computed(() => selfAvatarSrc({ selfNode: snap.value?.selfNode ?? '', windowName: snap.value?.windowName ?? '', avatars: avatars.value }))
    listen('asn:panel', p => { if (p.kind === kind) { key.value = p.key; document.title = panelTitle(kind, p.key) } })
    listen('asn:settings', s => { settings.value = s; localMsg.value = '' })
    listen('asn:state', s => { snap.value = s })
    listen('asn:avatars', a => { avatars.value = a ?? {} })
    let sizeTimer = null
    const fpShow = kind === 'fpshow' ? useFpShow() : { fps: null, fpsCancel: () => {} }
    if (kind === 'fpshow') document.title = FP_SHOW_TEXT.pcTitle
    onMounted(() => {
      if (kind === 'fpshow') return   // 這扇不跟樞紐要內容、不記大小
      emit('asn:cmd', { op: 'panel-hello', kind })
      // 視窗大小記住：停下來才通知樞紐存檔（樞紐下次開這扇視窗時用）
      window.addEventListener('resize', () => {
        clearTimeout(sizeTimer)
        sizeTimer = setTimeout(() => emit('asn:set', { op: 'panel-size', kind, w: window.innerWidth, h: window.innerHeight }), 400)
      })
    })
    const pickFile = async file => {
      localMsg.value = ''
      try { emit('asn:set', { op: 'avatar-upload', value: await avatarFromFile(file) }) } catch (e) { localMsg.value = plainMessage(e) }
    }
    return {
      ...fpShow, FPS: FP_SHOW_TEXT, QR_TEXT,
      kind, key, title: computed(() => (kind === 'fpshow' ? FP_SHOW_TEXT.pcTitle : title.value)), itemTitle: computed(() => item.value?.title ?? ''), guide: computed(() => (kind === 'guide' ? item.value : null)),
      st, meAv, ctl, RESIZE_DIRS, resizeFrom, pickFile,
      act: (op, value) => emit('asn:set', { op, value }),
    }
  },
})
app.component('guide-doc', GuideDoc)
app.component('line-icon', LineIcon)
app.component('settings-panel', SettingsPanel)
app.component('fp-qr-canvas', FpQrCanvas)
app.component('asn-button', AsnButton)
app.mount('#app')
blockContextMenu(document)
