// 指引／設定的獨立視窗（分離模式）：只顯示，狀態與動作都交給名單視窗裡的樞紐（用事件溝通，跟 chat.js 同一套）。
//   ?kind=guide  ＝ 指引視窗：asn:panel 事件告訴它現在顯示哪一篇
//   ?kind=setting＝ 設定視窗：asn:panel 告訴它顯示哪一類，asn:settings 送來設定快照，改了什麼用 asn:set 送回樞紐
// 設定值、金鑰、存檔都不在這扇視窗；唯一在這裡做的事是把選的圖裁成大頭貼（純畫面運算），裁好再交給樞紐上傳。
import { blockContextMenu } from './lib/nomenu.mjs'
import { GuideDoc } from './lib/guide-doc.mjs'
import { SettingsPanel } from './lib/settings-panel.mjs'
import { PANEL_KINDS, panelItem, panelTitle } from './lib/panels.mjs'
import { selfAvatarSrc } from './lib/avatar.mjs'
import { avatarFromFile } from './lib/avatar-canvas.mjs'
import { RESIZE_DIRS, ctl, emit, initFrame, listen, resizeFrom } from './lib/tauri.mjs'

const { createApp, ref, computed, onMounted } = Vue
await initFrame()
const q = new URLSearchParams(location.search).get('kind')
const kind = PANEL_KINDS.includes(q) ? q : 'guide'

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
    onMounted(() => {
      emit('asn:cmd', { op: 'panel-hello', kind })
      // 視窗大小記住：停下來才通知樞紐存檔（樞紐下次開這扇視窗時用）
      window.addEventListener('resize', () => {
        clearTimeout(sizeTimer)
        sizeTimer = setTimeout(() => emit('asn:set', { op: 'panel-size', kind, w: window.innerWidth, h: window.innerHeight }), 400)
      })
    })
    const pickFile = async file => {
      localMsg.value = ''
      try { emit('asn:set', { op: 'avatar-upload', value: await avatarFromFile(file) }) } catch (e) { localMsg.value = e.message }
    }
    return {
      kind, key, title, itemTitle: computed(() => item.value?.title ?? ''), guide: computed(() => (kind === 'guide' ? item.value : null)),
      st, meAv, ctl, RESIZE_DIRS, resizeFrom, pickFile,
      act: (op, value) => emit('asn:set', { op, value }),
    }
  },
})
app.component('guide-doc', GuideDoc)
app.component('settings-panel', SettingsPanel)
app.mount('#app')
blockContextMenu(document)
