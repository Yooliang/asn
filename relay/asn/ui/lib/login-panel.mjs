// 設定頁「帳號」分類裡的「登入狀態」區塊：未登入顯示登入鈕；已登入只顯示 email 與登出（綁定是登入後自動做的，沒有按鈕）。
// 自己呼叫 Rust 指令（登入狀態與權杖都在 Rust 端，不經名單樞紐的設定快照）；整合模式與分離視窗共用。
// 這個檔在 node 也要能載入（測試），所以 Vue 與 Tauri 只在元件 setup 裡才取用。
import { PROVIDERS, accountView, errorText } from './login.mjs'
import { authApi, invoke } from './tauri.mjs'
import { checkName } from './onboard.mjs'
import { accountDisplayName } from './mobile.mjs'

export const LoginPanel = {
  setup() {
    const { ref, computed, onMounted } = globalThis.Vue
    const status = ref(null), info = ref(null), busy = ref(false), msg = ref(''), waiting = ref(false)
    // 帳號名稱（我的名字，所有設備共用）：登入後才有；改了走後台 account_name
    const nameText = ref(''), nameBusy = ref(false), nameMsg = ref('')
    const view = computed(() => accountView(status.value, info.value))
    const refresh = async () => {
      try {
        status.value = await authApi.status()
        info.value = null
        if (status.value?.signed_in) { info.value = await authApi.accountInfo(); nameText.value = accountDisplayName(info.value?.owner_name, '') === '我' ? '' : accountDisplayName(info.value?.owner_name, '') }
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
    const saveName = async () => {
      if (nameBusy.value) return
      const c = checkName(nameText.value)
      if (!c.ok) { nameMsg.value = c.error; return }
      nameBusy.value = true; nameMsg.value = ''
      try { nameText.value = await authApi.setAccountName(c.name); nameMsg.value = '已儲存。' } catch (e) { nameMsg.value = errorText(e) } finally { nameBusy.value = false }
    }
    onMounted(refresh)
    return { nameText, nameBusy, nameMsg, saveName, PROVIDERS, view, busy, msg, waiting, login, logout, cancel: () => authApi.cancel() }
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
      <label class="login-name" v-if="view.signedIn">我的名字
        <span class="login-name-row"><input class="set-input" type="text" maxlength="40" v-model="nameText" :disabled="nameBusy" placeholder="例如：啟良" aria-label="帳號名稱" @keydown.enter.prevent="saveName"><button class="aero-btn" type="button" :disabled="nameBusy" @click="saveName">儲存</button></span>
        <small>帳號的名字，所有設備共用。</small>
      </label>
      <small v-if="nameMsg" role="status">{{ nameMsg }}</small>
      <small v-if="waiting" role="status">請在瀏覽器完成登入，完成後回到這裡。</small>
      <small role="status">{{ msg }}</small>
    </section>`,
}
