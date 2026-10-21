// 登入畫面（沒登入時由名單視窗轉過來；舊電腦也要登入一次）：系統瀏覽器登入 → Rust 端換權杖並存好 →
//   沒有節點金鑰：自動建立節點並重新啟動進入名單；已有節點金鑰：自動綁到帳號（失敗不擋）後直接進名單。
// 這台已有節點金鑰時，另有小字連結「暫時不登入」照舊進名單。
// 權杖與節點金鑰都只在 Rust 端，這裡只看得到「登入了沒」與錯誤文字。
import { blockContextMenu } from './lib/nomenu.mjs'
import { LAST_USED_LABEL, PROVIDERS, SKIP_LABEL, canStart, errorText, phaseText, showSkip } from './lib/login.mjs'
import { RESIZE_DIRS, authApi, ctl, initFrame, invoke, resizeFrom } from './lib/tauri.mjs'

const { createApp, ref, computed } = Vue
await initFrame()
const info = await invoke('startup_info')
document.title = `Agent Sync Network Messenger (${info.version})`

const app = createApp({
  setup() {
    const phase = ref('idle'), provider = ref(''), error = ref('')
    const note = computed(() => phaseText(phase.value, provider.value))
    const canSkip = info.can_skip_login === true
    // 上次登入的方式與頭像（Rust 端讀 last-login.json；沒登入過就是空）：頭像放進大框、那顆按鈕標「上次使用」
    const lastProvider = info.last_login?.provider || ''
    const lastAvatar = info.last_login?.avatar || ''
    // 登入完成後自動處理金鑰：沒有金鑰＝建節點（Rust 端稍後自動重新啟動）；有金鑰＝綁到帳號，不管成功與否都進名單
    const finish = async () => {
      phase.value = 'setting'
      try {
        const out = await authApi.bind()
        if (out?.state !== 'created' && !info.shot) location.replace('list.html')
      } catch (e) { error.value = errorText(e); phase.value = 'error' }
    }
    const start = async key => {
      if (!canStart(phase.value)) return
      provider.value = key; error.value = ''; phase.value = 'waiting'
      try { await authApi.login(key) } catch (e) { error.value = errorText(e); phase.value = 'error'; return }
      await finish()
    }
    const skip = async () => {
      if (!showSkip(canSkip, phase.value)) return
      try { await authApi.skip(); if (!info.shot) location.replace('list.html') } catch (e) { error.value = errorText(e); phase.value = 'error' }
    }
    return { LAST_USED_LABEL, lastProvider, lastAvatar, PROVIDERS, RESIZE_DIRS, resizeFrom, ctl, phase, error, note, canStart, canSkip, SKIP_LABEL, showSkip, start, skip, finish, cancel: () => authApi.cancel(), quit: () => invoke('quit_app') }
  },
})
const vm = app.mount('#app')
// 已登入但這台還沒有節點金鑰（例如上次建立節點中斷）：直接接著做，不用再登入一次
const resumed = !info.can_skip_login && (await authApi.status().catch(() => null))?.signed_in ? vm.finish() : null
blockContextMenu(document)

// --shot：畫面畫好就截圖並結束
if (info.shot) {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r))
  await resumed   // 已登入的情境：等自動建立節點做完再截
  await sleep(700)
  await invoke('show_main').catch(() => {})
  await sleep(500)
  await invoke('capture_ui_ready', { tag: 'login-ready' })
  await invoke('take_shot', { tab: 'login' })
  await invoke('quit_app')
}
