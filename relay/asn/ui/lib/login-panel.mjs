// 設定頁「帳號」分類裡的「登入狀態」區塊：未登入顯示登入鈕；已登入只顯示 email 與登出（綁定是登入後自動做的，沒有按鈕）。
// 自己呼叫 Rust 指令（登入狀態與權杖都在 Rust 端，不經名單樞紐的設定快照）；整合模式與分離視窗共用。
// 這個檔在 node 也要能載入（測試），所以 Vue 與 Tauri 只在元件 setup 裡才取用。
import { PROVIDERS, accountView, errorText } from './login.mjs'
import { authApi, invoke } from './tauri.mjs'

export const LoginPanel = {
  setup() {
    const { ref, computed, onMounted } = globalThis.Vue
    const status = ref(null), info = ref(null), busy = ref(false), msg = ref(''), waiting = ref(false)
    const view = computed(() => accountView(status.value, info.value))
    const refresh = async () => {
      try {
        status.value = await authApi.status()
        info.value = null
        if (status.value?.signed_in) info.value = await authApi.accountInfo()
      } catch (e) { msg.value = errorText(e) }
    }
    const run = async (fn, ok = '') => {
      if (busy.value) return
      busy.value = true; msg.value = ''
      try { await fn(); if (ok) msg.value = ok } catch (e) { msg.value = errorText(e) } finally { busy.value = false; waiting.value = false }
      await refresh()
    }
    // 登入完成後自動綁定這台電腦（舊租戶還沒被認領時不擋，小字會提示）
    const login = key => run(async () => { waiting.value = true; await authApi.login(key); waiting.value = false; await authApi.bind() })
    const logout = () => run(() => authApi.logout(), '已登出，正在回到登入畫面…（這台電腦的節點金鑰沒有動）')
    onMounted(refresh)
    return { PROVIDERS, view, busy, msg, waiting, login, logout, cancel: () => authApi.cancel() }
  },
  template: `<section class="set-card login-set" aria-label="登入狀態">
      <header class="vendor-h"><b>登入狀態</b><small>Google／GitHub</small></header>
      <p class="login-state">{{ view.title }}</p>
      <small>{{ view.detail }}</small>
      <div class="av-btns" v-if="!view.signedIn">
        <button v-for="p in PROVIDERS" :key="p.key" class="aero-btn" type="button" :disabled="busy" @click="login(p.key)">{{ p.label }}</button>
        <button v-if="waiting" class="aero-btn" type="button" @click="cancel">取消</button>
      </div>
      <div class="av-btns" v-else>
        <button class="aero-btn" type="button" :disabled="busy" @click="logout">登出</button>
      </div>
      <small v-if="waiting" role="status">請在瀏覽器完成登入，完成後回到這裡。</small>
      <small role="status">{{ msg }}</small>
    </section>`,
}
