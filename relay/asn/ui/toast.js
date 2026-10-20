// 右下角提示：內容由網址參數帶入（純文字，用 {{ }} 顯示，不經 v-html）；點一下開對話。
import { invoke } from './lib/tauri.mjs'

const { createApp } = Vue
const q = new URLSearchParams(location.search)
const t = { cid: q.get('cid') ?? '', title: q.get('title') ?? '', line: q.get('line') ?? '', status: q.get('status') ?? 'online', hue: Number(q.get('hue')) || 210, dp: q.get('dp') ?? '?' }

createApp({
  setup() {
    return { t, open: () => invoke('toast_click', { cid: t.cid }) }
  },
}).mount('#app')
