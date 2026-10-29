// 設定頁第一頁（個人）裡的「登入狀態」區塊：未登入顯示登入鈕；已登入顯示 email 與我的名字（登出鈕在同一頁最下面，見 LogoutPanel）（綁定是登入後自動做的，沒有按鈕）。
// 自己呼叫 Rust 指令（登入狀態與權杖都在 Rust 端，不經名單樞紐的設定快照）；整合模式與分離視窗共用。
// 這個檔在 node 也要能載入（測試），所以 Vue 與 Tauri 只在元件 setup 裡才取用。
import { PROVIDERS, accountView, errorText } from './login.mjs'
import { authApi, invoke } from './tauri.mjs'
import { checkName } from './onboard.mjs'
import { accountDisplayName } from './mobile.mjs'
import { checkAiWakeLimit, AI_WAKE_LIMIT_LABEL, AI_WAKE_LIMIT_NOTE } from './ai-wake-limit.mjs'

export const LoginPanel = {
  setup() {
    const { ref, computed, onMounted } = globalThis.Vue
    const status = ref(null), info = ref(null), busy = ref(false), msg = ref(''), waiting = ref(false)
    // 帳號名稱（我的名字，所有設備共用）：登入後才有；改了走後台 account_name
    const nameText = ref(''), nameBusy = ref(false), nameMsg = ref('')
    // 群組裡 AI 之間互相叫醒的上限（帳號層設定）
    const wakeText = ref('20'), wakeBusy = ref(false), wakeMsg = ref('')
    const view = computed(() => accountView(status.value, info.value))
    const refresh = async () => {
      try {
        status.value = await authApi.status()
        info.value = null
        if (status.value?.signed_in) { info.value = await authApi.accountInfo(); void authApi.getAiWakeLimit().then(n => { wakeText.value = String(n) }).catch(() => {}); nameText.value = accountDisplayName(info.value?.owner_name, '') === '我' ? '' : accountDisplayName(info.value?.owner_name, '') }
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
    const saveName = async () => {
      if (nameBusy.value) return
      const c = checkName(nameText.value)
      if (!c.ok) { nameMsg.value = c.error; return }
      nameBusy.value = true; nameMsg.value = ''
      try { nameText.value = await authApi.setAccountName(c.name); nameMsg.value = '已儲存。' } catch (e) { nameMsg.value = errorText(e) } finally { nameBusy.value = false }
    }
    const saveWake = async () => {
      if (wakeBusy.value) return
      const c = checkAiWakeLimit(wakeText.value)
      if (!c.ok) { wakeMsg.value = c.error; return }
      wakeBusy.value = true; wakeMsg.value = ''
      try { wakeText.value = String(await authApi.setAiWakeLimit(c.value)); wakeMsg.value = '已儲存。' } catch (e) { wakeMsg.value = errorText(e) } finally { wakeBusy.value = false }
    }
    onMounted(refresh)
    return { wakeText, wakeBusy, wakeMsg, saveWake, AI_WAKE_LIMIT_LABEL, AI_WAKE_LIMIT_NOTE, nameText, nameBusy, nameMsg, saveName, PROVIDERS, view, busy, msg, waiting, login, cancel: () => authApi.cancel() }
  },
  template: `<section class="set-card login-set" aria-label="登入狀態">
      <header class="vendor-h"><b>登入狀態</b><small>Google／GitHub</small></header>
      <p class="login-state">{{ view.title }}</p>
      <small>{{ view.detail }}</small>
      <div class="av-btns" v-if="!view.signedIn">
        <button v-for="p in PROVIDERS" :key="p.key" class="aero-btn" type="button" :disabled="busy" @click="login(p.key)">{{ p.label }}</button>
        <button v-if="waiting" class="aero-btn" type="button" @click="cancel">取消</button>
      </div>
      <label class="login-name" v-if="view.signedIn">我的名字
        <span class="login-name-row"><input class="set-input" type="text" maxlength="40" v-model="nameText" :disabled="nameBusy" placeholder="例如：啟良" aria-label="帳號名稱" @keydown.enter.prevent="saveName"><button class="aero-btn" type="button" :disabled="nameBusy" @click="saveName">儲存</button></span>
        <small>帳號的名字，所有設備共用。</small>
      </label>
      <label class="login-name" v-if="view.signedIn">{{ AI_WAKE_LIMIT_LABEL }}
        <span class="login-name-row"><input class="set-input" type="number" min="0" max="200" step="1" v-model="wakeText" :disabled="wakeBusy" aria-label="AI 之間互相叫醒的上限" @keydown.enter.prevent="saveWake"><button class="aero-btn" type="button" :disabled="wakeBusy" @click="saveWake">儲存</button></span>
        <small>{{ AI_WAKE_LIMIT_NOTE }}</small>
      </label>
      <small v-if="wakeMsg" role="status">{{ wakeMsg }}</small>
      <small v-if="nameMsg" role="status">{{ nameMsg }}</small>
      <small v-if="waiting" role="status">請在瀏覽器完成登入，完成後回到這裡。</small>
      <small role="status">{{ msg }}</small>
    </section>`,
}

// 登出鈕：獨立放在設定第一頁最下面，與其他項目隔開；只在已登入時出現
export const LogoutPanel = {
  setup() {
    const { ref, onMounted } = globalThis.Vue
    const signedIn = ref(false), busy = ref(false), msg = ref('')
    const refresh = async () => { try { signedIn.value = !!(await authApi.status())?.signed_in } catch (e) { msg.value = errorText(e) } }
    const logout = async () => {
      if (busy.value) return
      busy.value = true; msg.value = ''
      try { await authApi.logout(); msg.value = '已登出，正在回到登入畫面…（這台電腦的節點金鑰沒有動）' } catch (e) { msg.value = errorText(e) } finally { busy.value = false }
      await refresh()
    }
    onMounted(refresh)
    return { signedIn, busy, msg, logout }
  },
  template: `<div class="logout-set" v-if="signedIn || msg">
      <div class="av-btns" v-if="signedIn"><button class="aero-btn logout-btn" type="button" :disabled="busy" @click="logout">登出</button></div>
      <small role="status">{{ msg }}</small>
    </div>`,
}
