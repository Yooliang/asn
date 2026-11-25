// 安裝並登入的常駐進度小窗：內容全來自 Rust 端的事件（固定句子）；按「取消」只是請 Rust 端在這一步做完後停下。
import { blockContextMenu } from './lib/nomenu.mjs'
import { setupProgressApi, createWindowHub, ctl } from './lib/tauri.mjs'
import { CANCEL_LABEL, CLOSE_LABEL, applyEvent, canCancel, initialView, requestCancel, statusLines } from './lib/setup-progress.mjs'
import { installUiLog } from './lib/ui-log.mjs'
// 這個視窗的 [ASN] 記錄也寫進 ui.log（#2106 ⑥），行裡帶視窗名
installUiLog({ source: 'setup-progress' })

const { createApp, reactive, computed } = Vue

createApp({
  setup() {
    const state = reactive({ v: initialView() })
    const apply = e => { state.v = applyEvent(state.v, e) }
    // 小窗開得比事件慢：先向 Rust 要最後一個事件，再接著聽
    void setupProgressApi.snapshot().then(list => { for (const e of list ?? []) apply(e) }).catch(() => { /* 拿不到最後一個事件，就等下一個事件；出口已 console.warn */ })
    const hub = createWindowHub()   // 沒有 AsnCore 的小窗：只有事件中心＋Rust 橋
    hub.on('agent-setup', apply)
    hub.on('agent-setup-remote', apply)
    const cancel = () => {
      if (!canCancel(state.v)) return
      state.v = requestCancel(state.v)
      void setupProgressApi.cancel().catch(() => { /* 取消請求沒送到：畫面已顯示取消中，安裝照舊跑完；出口已 console.warn */ })
    }
    return { v: computed(() => state.v), lines: computed(() => statusLines(state.v)), can: computed(() => canCancel(state.v)), cancel, close: () => ctl('close'), CANCEL_LABEL, CLOSE_LABEL }
  },
}).mount('#app')
blockContextMenu(document)
