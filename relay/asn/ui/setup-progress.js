// 安裝並登入的常駐進度小窗：內容全來自 Rust 端的事件（固定句子）；按「取消」只是請 Rust 端在這一步做完後停下。
import { blockContextMenu } from './lib/nomenu.mjs'
import { invoke, listen, ctl } from './lib/tauri.mjs'
import { CANCEL_LABEL, CLOSE_LABEL, applyEvent, canCancel, initialView, requestCancel, statusLines } from './lib/setup-progress.mjs'

const { createApp, reactive, computed } = Vue

createApp({
  setup() {
    const state = reactive({ v: initialView() })
    const apply = e => { state.v = applyEvent(state.v, e) }
    // 小窗開得比事件慢：先向 Rust 要最後一個事件，再接著聽
    void invoke('setup_progress_snapshot').then(list => { for (const e of list ?? []) apply(e) }).catch(() => {})
    void listen('agent-setup', apply)
    void listen('agent-setup-remote', apply)
    const cancel = () => {
      if (!canCancel(state.v)) return
      state.v = requestCancel(state.v)
      void invoke('agent_setup_cancel').catch(() => {})
    }
    return { v: computed(() => state.v), lines: computed(() => statusLines(state.v)), can: computed(() => canCancel(state.v)), cancel, close: () => ctl('close'), CANCEL_LABEL, CLOSE_LABEL }
  },
}).mount('#app')
blockContextMenu(document)
