// 引導頁第 3 步「連接你的 AI 工具」（#343，只有電腦版）：讀 Claude 額度、pi 與 ASN 互通、Claude 外掛。
// 每一項各自勾選、按「完成」才依勾選執行；每項各自顯示結果，失敗不擋人進名單。沒勾的之後可以到「設定 → 啟動設定」補做。
// 純邏輯與元件放一起；這個檔在 node 也要能載入（測試），所以 Vue 只在 setup 裡取用。

// pi 的官方說明（寫死在程式裡，不從遠端讀）
export const PI_DOC_URL = 'https://github.com/earendil-works/pi'

export const CONNECT_TEXT = {
  head: '連接你的 AI 工具',
  hint: '勾選要現在做的項目；沒勾的之後可以到「設定 → 啟動設定」再做。',
  quotaTitle: '讀 Claude 額度',
  quotaDesc: '讓手機看得到這台 Claude 帳號還剩多少額度。會修改 Claude Code 設定檔裡「狀態列」那一欄，可以隨時在設定裡還原。',
  piTitle: 'pi 與 ASN 互通',
  piDesc: '讓你自己開的 pi 也能從名單收發信。',
  piMissing: '沒偵測到 pi，裝好後可以到設定開啟互通',
  piDoc: 'pi 的官方說明',
  piLogin: '登入 pi',
  piLoginNote: '請在打開的視窗輸入 /login，ASN 不會看到你的登入資料',
  modTitle: 'Claude 外掛',
  modDesc: '讓 Claude 視窗能收發信。取消勾選代表以後不自動安裝或更新；已經裝的會留著。',
  done: '完成',
  running: '處理中…',
  enter: '進入名單',
  ok: '完成',
  skipped: '沒有勾選，之後可以到設定再做',
}

/** 預設勾選：額度不勾（要改別的程式的設定檔）；pi 偵測到才勾；Claude 外掛勾（跟現在自動安裝一致） */
export const connectDefaults = ({ piDetected = false } = {}) => ({ quota: false, pi: Boolean(piDetected), mod: true })

/**
 * 依勾選執行。ops：{ quotaConnect(), piInstall(), modAuto(on) }（都是 async）。
 * - 額度、pi：有勾才做；沒勾就不動（pi 沒偵測到時不做）
 * - Claude 外掛：勾選＝打開「自動安裝或更新」並馬上檢查一次；沒勾＝把開關關掉（不裝也不更新，已經裝的不動）
 * 一項失敗不影響其他項。回 [{ key, ok, text }]（每項一列，給畫面照實顯示）
 */
export async function runConnect(choice, ops, { piDetected = false } = {}) {
  const out = []
  const step = async (key, fn, okText) => {
    try {
      await fn()
      out.push({ key, ok: true, text: okText })
    } catch (e) {
      out.push({ key, ok: false, text: `沒有成功：${String(e?.message ?? e) || '原因不明'}` })
    }
  }
  if (choice.quota) await step('quota', () => ops.quotaConnect(), '已接上，下次 Claude Code 更新狀態列時就會開始記額度')
  else out.push({ key: 'quota', ok: true, text: CONNECT_TEXT.skipped })
  if (choice.pi && piDetected) await step('pi', () => ops.piInstall(), '已開啟，之後自己開的 pi 也能收發信')
  else out.push({ key: 'pi', ok: true, text: piDetected ? CONNECT_TEXT.skipped : CONNECT_TEXT.piMissing })
  await step('mod', () => ops.modAuto(Boolean(choice.mod)), choice.mod ? '會自動安裝或更新' : '已關閉自動安裝或更新；已經裝的會留著')
  return out
}

export const ConnectStep = {
  props: {
    api: { type: Object, required: true },   // { piSetupStatus(), quotaConnect(), piInstall(), modAuto(on), piLogin() }
  },
  emits: ['done'],
  setup(props, { emit }) {
    const { ref, reactive, onMounted } = globalThis.Vue
    const piDetected = ref(false), busy = ref(false), results = ref(null), loginMsg = ref('')
    const choice = reactive(connectDefaults())
    onMounted(async () => {
      try { piDetected.value = Boolean((await props.api.piSetupStatus())?.pi) } catch { piDetected.value = false }
      choice.pi = piDetected.value
    })
    const submit = async () => {
      if (busy.value) return
      busy.value = true
      results.value = await runConnect(choice, props.api, { piDetected: piDetected.value })
      busy.value = false
    }
    const login = async () => {
      try { await props.api.piLogin(); loginMsg.value = CONNECT_TEXT.piLoginNote } catch (e) { loginMsg.value = `沒有成功：${String(e?.message ?? e)}` }
    }
    const resultOf = key => results.value?.find(r => r.key === key)
    return { T: CONNECT_TEXT, PI_DOC_URL, piDetected, busy, results, choice, submit, login, loginMsg, resultOf, enter: () => emit('done') }
  },
  template: `<div class="onboard-form connect-step">
      <b>{{ T.head }}</b>
      <p class="login-sub onboard-hint">{{ T.hint }}</p>
      <label class="connect-card"><input type="checkbox" v-model="choice.quota" :disabled="busy || !!results"><span><b>{{ T.quotaTitle }}</b><small>{{ T.quotaDesc }}</small><small v-if="resultOf('quota')" :class="{ 'login-err': !resultOf('quota').ok }">{{ resultOf('quota').text }}</small></span></label>
      <label class="connect-card" :class="{ off: !piDetected }"><input type="checkbox" v-model="choice.pi" :disabled="busy || !!results || !piDetected"><span><b>{{ T.piTitle }}</b>
        <small v-if="piDetected">{{ T.piDesc }}</small>
        <small v-else>{{ T.piMissing }}（<a :href="PI_DOC_URL" target="_blank" rel="noopener">{{ T.piDoc }}</a>）</small>
        <button class="aero-btn" type="button" v-if="piDetected" @click.prevent="login">{{ T.piLogin }}</button>
        <small v-if="loginMsg">{{ loginMsg }}</small>
        <small v-if="resultOf('pi')" :class="{ 'login-err': !resultOf('pi').ok }">{{ resultOf('pi').text }}</small></span></label>
      <label class="connect-card"><input type="checkbox" v-model="choice.mod" :disabled="busy || !!results"><span><b>{{ T.modTitle }}</b><small>{{ T.modDesc }}</small><small v-if="resultOf('mod')" :class="{ 'login-err': !resultOf('mod').ok }">{{ resultOf('mod').text }}</small></span></label>
      <button type="button" class="aero-btn login-btn" v-if="!results" :disabled="busy" @click="submit">{{ busy ? T.running : T.done }}</button>
      <button type="button" class="aero-btn login-btn" v-else @click="enter">{{ T.enter }}</button>
    </div>`,
}
