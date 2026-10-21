// 登入畫面（新電腦、沒有節點金鑰時由名單視窗轉過來）：系統瀏覽器登入 → Rust 端換權杖並存好 → 自動替這台電腦建立節點 → 重新啟動進入名單。
// 權杖與節點金鑰都只在 Rust 端，這裡只看得到「登入了沒」與錯誤文字。
import { blockContextMenu } from './lib/nomenu.mjs'
import { PROVIDERS, canStart, errorText, needsDeviceSetup, phaseText } from './lib/login.mjs'
import { RESIZE_DIRS, authApi, ctl, initFrame, invoke, resizeFrom } from './lib/tauri.mjs'

const { createApp, ref, computed } = Vue
await initFrame()
const info = await invoke('startup_info')
document.title = `Agent Sync Network Messenger (${info.version})`

const app = createApp({
  setup() {
    const phase = ref('idle'), provider = ref(''), error = ref('')
    const note = computed(() => phaseText(phase.value, provider.value))
    const finish = async () => {
      phase.value = 'setting'
      await authApi.setupDevice()   // 建立節點、存好金鑰；非 --shot 時 Rust 端稍後自動重新啟動
    }
    const start = async key => {
      if (!canStart(phase.value)) return
      provider.value = key; error.value = ''; phase.value = 'waiting'
      try {
        const st = await authApi.login(key)
        if (needsDeviceSetup(false, st)) await finish()
      } catch (e) { error.value = errorText(e); phase.value = 'error' }
    }
    return { PROVIDERS, RESIZE_DIRS, resizeFrom, ctl, phase, error, note, canStart, start, cancel: () => authApi.cancel(), quit: () => invoke('quit_app') }
  },
})
app.mount('#app')
blockContextMenu(document)

// --shot：畫面畫好就截圖並結束
if (info.shot) {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r))
  await sleep(700)
  await invoke('show_main').catch(() => {})
  await sleep(500)
  await invoke('capture_ui_ready', { tag: 'login-ready' })
  await invoke('take_shot', { tab: 'login' })
  await invoke('quit_app')
}
