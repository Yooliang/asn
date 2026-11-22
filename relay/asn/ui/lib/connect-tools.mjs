// 引導頁第 3 步「連接你的 AI 工具」（#343，只有電腦版）：pi 與 ASN 互通、Claude 外掛。（Claude 額度不在這裡設定：ASN 直接查目前登入的帳號，#1883）
// 每一項各自勾選、按「完成」才依勾選執行；每項各自顯示結果，失敗不擋人進名單。沒勾的之後可以到「設定 → 啟動設定」補做。
// 純邏輯與元件放一起；這個檔在 node 也要能載入（測試），所以 Vue 只在 setup 裡取用。

import { modStatusLine } from './mod-line.mjs'

// pi 的官方說明（寫死在程式裡，不從遠端讀）
export const PI_DOC_URL = 'https://github.com/earendil-works/pi'

export const CONNECT_TEXT = {
  head: '連接你的 AI 工具',
  hint: '勾選要現在做的項目；沒勾的之後可以到「設定 → 啟動設定」再做。',
  piTitle: 'pi 與 ASN 互通',
  piDesc: '讓你自己開的 pi 也能從名單收發信。',
  piMissing: '沒偵測到 pi，裝好後可以到設定開啟互通',
  piDoc: 'pi 的官方說明',
  piLogin: '登入 pi',
  piLoginNote: '請在打開的視窗輸入 /login，ASN 不會看到你的登入資料',
  modTitle: 'Claude 外掛',
  modDesc: 'ASN 必要元件，會自動安裝，ASN 更新時一起更新。',
  done: '完成',
  running: '處理中…',
  enter: '進入名單',
  ok: '完成',
  skipped: '沒有勾選，之後可以到設定再做',
}

/** 預設勾選：pi 偵測到才勾；Claude 外掛固定勾選、不能取消 */
export const connectDefaults = ({ piDetected = false } = {}) => ({ pi: Boolean(piDetected), mod: true })

/**
 * 依勾選執行。ops：{ piInstall(), modInstall() }（都是 async）。
 * - pi：有勾才做；沒勾就不動（pi 沒偵測到時不做）
 * - Claude 外掛：必要元件，不管 choice 怎麼傳都一律馬上檢查並安裝一次
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
  if (choice.pi && piDetected) await step('pi', () => ops.piInstall(), '已開啟，之後自己開的 pi 也能收發信')
  else out.push({ key: 'pi', ok: true, text: piDetected ? CONNECT_TEXT.skipped : CONNECT_TEXT.piMissing })
  // 外掛：照 Rust 實際檢查的結果顯示（和設定頁同一份文字）；查不到結果就不寫任何成功字樣
  try {
    const report = await ops.modInstall()
    out.push({ key: 'mod', ok: !['failed', 'update_failed'].includes(report?.state), text: modStatusLine(report) })
  } catch (e) {
    out.push({ key: 'mod', ok: false, text: `沒有成功：${String(e?.message ?? e) || '原因不明'}` })
  }
  return out
}

export const ConnectStep = {
  props: {
    api: { type: Object, required: true },   // { piSetupStatus(), piInstall(), modInstall(), piLogin() }
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
      <label class="connect-card" :class="{ off: !piDetected }"><input type="checkbox" v-model="choice.pi" :disabled="busy || !!results || !piDetected"><span><b>{{ T.piTitle }}</b>
        <small v-if="piDetected">{{ T.piDesc }}</small>
        <small v-else>{{ T.piMissing }}（<a :href="PI_DOC_URL" target="_blank" rel="noopener">{{ T.piDoc }}</a>）</small>
        <button class="aero-btn" type="button" v-if="piDetected" @click.prevent="login">{{ T.piLogin }}</button>
        <small v-if="loginMsg">{{ loginMsg }}</small>
        <small v-if="resultOf('pi')" :class="{ 'login-err': !resultOf('pi').ok }">{{ resultOf('pi').text }}</small></span></label>
      <label class="connect-card"><input type="checkbox" checked disabled><span><b>{{ T.modTitle }}</b><small>{{ T.modDesc }}</small><small v-if="resultOf('mod') && resultOf('mod').text" :class="{ 'login-err': !resultOf('mod').ok }">{{ resultOf('mod').text }}</small></span></label>
      <button type="button" class="aero-btn login-btn" v-if="!results" :disabled="busy" @click="submit">{{ busy ? T.running : T.done }}</button>
      <button type="button" class="aero-btn login-btn" v-else @click="enter">{{ T.enter }}</button>
    </div>`,
}
