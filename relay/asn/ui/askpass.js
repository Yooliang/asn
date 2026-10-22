// 密碼請求確認窗：內容由 Rust 端（askpass_info）給；按確定把輸入交給 Rust 端（askpass_answer）後立刻清空輸入欄。
// 輸入的字只存在這個畫面的 secret 變數：不寫進瀏覽器儲存、不放網址、不印出來、不碰剪貼簿。
import { blockContextMenu } from './lib/nomenu.mjs'
import { invoke } from './lib/tauri.mjs'
import { viewModel, countdownText, parseId } from './lib/askpass-dialog.mjs'

const { createApp, ref, computed, onMounted, onBeforeUnmount, nextTick } = Vue
const id = parseId(location.search)

createApp({
  setup() {
    const vm = ref(null)
    const err = ref('')
    const secret = ref('')
    const done = ref(false)
    const box = ref(null)
    const sec = ref(0)
    let timer = 0
    const left = computed(() => countdownText(sec.value))

    const finish = async value => {
      if (done.value || id === null) return
      done.value = true
      const payload = value === null ? null : value
      secret.value = ''
      if (box.value) box.value.value = ''
      try { await invoke('askpass_answer', { id, secret: payload }) } catch { /* 已逾時或已取消：視窗會被關掉 */ }
    }
    const ok = () => finish(vm.value?.kind === 'secret' ? secret.value : '')
    const cancel = () => finish(null)

    onMounted(async () => {
      if (id === null) { err.value = '這個視窗的網址不正確。'; return }
      try {
        vm.value = viewModel(await invoke('askpass_info', { id }))
      } catch (e) { err.value = '這個請求已經結束。'; return }
      sec.value = vm.value.secondsLeft
      timer = setInterval(() => { if (sec.value > 0) sec.value -= 1 }, 1000)
      await nextTick()
      box.value?.focus()
    })
    onBeforeUnmount(() => { clearInterval(timer); secret.value = '' })
    document.addEventListener('keydown', e => { if (e.key === 'Escape') cancel() })
    return { vm, err, secret, done, box, left, ok, cancel }
  },
}).mount('#app')
blockContextMenu(document)
