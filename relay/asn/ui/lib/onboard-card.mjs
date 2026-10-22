// 首次登入引導的畫面元件（電腦版 onboard.html 與手機版 m.html 共用）。邏輯在 onboard.mjs；這裡只管填寫與逐步前進。
// 每一步按下一步時就存（帳號名稱走後台、設備名稱走本機改名），最後一步完成才呼叫 done（由外面設旗標、進名單）。
// 這個檔在 node 也要能載入（測試），所以 Vue 只在 setup 裡取用。
import { STEP_ACCOUNT, STEP_DEVICE, TEXT, checkName, stepLabel } from './onboard.mjs'

export const OnboardCard = {
  props: {
    steps: { type: Array, required: true },
    deviceDefault: { type: String, default: '' },
    api: { type: Object, required: true },   // { setAccountName(name), setDeviceName(name) }
    mobile: { type: Boolean, default: false },
  },
  emits: ['done'],
  setup(props, { emit }) {
    const { ref, computed } = globalThis.Vue
    const idx = ref(0), busy = ref(false), error = ref('')
    const accountText = ref(''), deviceText = ref(props.deviceDefault)
    const step = computed(() => props.steps[idx.value])
    const last = computed(() => idx.value >= props.steps.length - 1)
    const head = computed(() => (step.value === STEP_ACCOUNT ? TEXT.accountHead : TEXT.deviceHead))
    const hint = computed(() => (step.value === STEP_ACCOUNT ? TEXT.accountHint : TEXT.deviceHint))
    const progress = computed(() => stepLabel(props.steps, step.value))
    const submit = async () => {
      if (busy.value) return
      const c = checkName(step.value === STEP_ACCOUNT ? accountText.value : deviceText.value)
      if (!c.ok) { error.value = c.error; return }
      busy.value = true; error.value = ''
      try {
        if (step.value === STEP_ACCOUNT) await props.api.setAccountName(c.name)
        else await props.api.setDeviceName(c.name)
        if (last.value) { emit('done'); return }
        idx.value += 1
      } catch (e) { error.value = String(e?.message ?? e) || '儲存沒有成功，請再試一次' } finally { busy.value = false }
    }
    return { TEXT, STEP_ACCOUNT, STEP_DEVICE, step, last, head, hint, progress, accountText, deviceText, busy, error, submit }
  },
  template: `<form class="onboard-form" @submit.prevent="submit" novalidate>
      <p class="login-note onboard-progress" v-if="progress">{{ progress }}</p>
      <label class="onboard-field"><b>{{ head }}</b>
        <input v-if="step === STEP_ACCOUNT" class="set-input" v-model="accountText" maxlength="40" autocomplete="off" enterkeyhint="done" :disabled="busy" aria-label="帳號名稱">
        <input v-else class="set-input" v-model="deviceText" maxlength="40" autocomplete="off" enterkeyhint="done" :disabled="busy" aria-label="設備名稱">
      </label>
      <p class="login-sub onboard-hint">{{ hint }}</p>
      <p class="login-err" v-if="error" role="alert">{{ error }}</p>
      <button type="submit" :class="mobile ? 'm-btn m-btn-big' : 'aero-btn login-btn'" :disabled="busy">{{ busy ? TEXT.saving : (last ? TEXT.done : TEXT.next) }}</button>
      <p class="login-note" v-if="last">{{ TEXT.settingsNote }}</p>
    </form>`,
}
