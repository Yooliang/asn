// 右下角提示：內容由網址參數帶入（純文字，用 {{ }} 顯示，不經 v-html）；點一下開對話。
import { blockieDataUrl, isAvatarDataUrl } from './lib/avatar.mjs'
import { invoke } from './lib/tauri.mjs'

const { createApp } = Vue
const q = new URLSearchParams(location.search)
const t = { cid: q.get('cid') ?? '', title: q.get('title') ?? '', line: q.get('line') ?? '', status: q.get('status') ?? 'online', hue: Number(q.get('hue')) || 210, dp: q.get('dp') ?? '?' }
// 大頭貼：設備上傳的圖（通過格式檢查才用）；否則用好友 id 畫自動產生的那張
t.src = isAvatarDataUrl(q.get('av')) ? q.get('av') : blockieDataUrl(t.cid)

createApp({
  setup() {
    return { t, open: () => invoke('toast_click', { cid: t.cid }) }
  },
}).mount('#app')
