// 電腦版首次登入引導（#166）：登入後、進名單之前先填「帳號名稱」（帳號已有名字就跳過）與「這台設備的名稱」。
// 名單視窗啟動時判斷要不要來這裡（list.js）；完成後記下本機旗標，轉回名單。判斷與文字在 lib/onboard.mjs。
import { blockContextMenu } from './lib/nomenu.mjs'
import { OnboardCard } from './lib/onboard-card.mjs'
import { ConnectStep } from './lib/connect-tools.mjs'
import { ONBOARD_STORE, TEXT, markOnboarded, planOnboarding } from './lib/onboard.mjs'
import { RESIZE_DIRS, authApi, ctl, initFrame, invoke, resizeFrom, store } from './lib/tauri.mjs'

const { createApp, ref } = Vue
await initFrame()
const info = await invoke('startup_info')
document.title = `Agent Sync Network Messenger (${info.version})`
const flag = store(ONBOARD_STORE)
const plan = await planOnboarding({ store: flag, status: authApi.status, accountInfo: authApi.accountInfo, startup: info })
if (plan.steps.length === 0) location.replace('list.html')

const app = createApp({
  setup() {
    const steps = ref(plan.steps), failed = ref(''), connect = ref(false)
    const api = {
      setAccountName: name => authApi.setAccountName(name),
      setDeviceName: name => (name === info.window_name ? Promise.resolve() : invoke('set_window_name', { name })),
    }
    // 第 3 步「連接你的 AI 工具」（#343）：名字都填好之後才出現；只有新用戶會走到這裡（舊用戶 plan.steps 是空的，直接進名單）
    const connectApi = {
      piSetupStatus: () => invoke('pi_setup_status'),
      quotaConnect: () => invoke('claude_quota_hook_connect'),
      piInstall: () => invoke('pi_setup_install'),
      modAuto: on => invoke('claude_mod_auto_set', { on }),
      piLogin: () => invoke('ai_cli_login', { toolId: 'pi' }),
    }
    const finish = async () => {
      try { await markOnboarded(flag); location.replace('list.html') } catch (e) { steps.value = []; connect.value = false; failed.value = String(e?.message ?? e) }
    }
    return { TEXT, RESIZE_DIRS, resizeFrom, ctl, steps, failed, connect, connectApi, deviceDefault: info.window_name, api, finish, quit: () => invoke('quit_app') }
  },
})
app.component('onboard-card', OnboardCard)
app.component('connect-step', ConnectStep)
app.mount('#app')
blockContextMenu(document)
