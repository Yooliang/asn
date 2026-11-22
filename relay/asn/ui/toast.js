// 右下角提示：內容由網址參數帶入（純文字，用 {{ }} 顯示，不經 v-html）；點一下開對話。
import { blockContextMenu } from './lib/nomenu.mjs'
import { autoAvatarDataUrl, isAvatarDataUrl } from './lib/avatar.mjs'
import { toastApi } from './lib/tauri.mjs'

const { createApp } = Vue
const q = new URLSearchParams(location.search)
const t = { cid: q.get('cid') ?? '', title: q.get('title') ?? '', line: q.get('line') ?? '', status: q.get('status') ?? 'online', hue: Number(q.get('hue')) || 210, dp: q.get('dp') ?? '?' }
// 大頭貼：設備上傳的圖（通過格式檢查才用）；否則用好友 id 畫自動產生的那張
t.src = isAvatarDataUrl(q.get('av')) ? q.get('av') : autoAvatarDataUrl(t.cid)

createApp({
  setup() {
    return { t, open: () => toastApi.click(t.cid) }
  },
}).mount('#app')
// 掛載後等兩個畫面更新，再回報「這扇畫好了」：--shot 截圖等它才拍（慢的機器上透明視窗可能還沒出內容，#1953）；正式使用只是多一次呼叫
requestAnimationFrame(() => requestAnimationFrame(() => { toastApi.painted().catch(() => { /* 回報不到只是 --shot 截圖多等到上限，不影響提示本身 */ }) }))
blockContextMenu(document)
