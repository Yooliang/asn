// 釘選徽章（#1729 起兼作狀態燈）：頭像右下角的小圓點，裡面一支圖釘，顏色照夥伴狀態（不再是另一個藍圈）（電腦名單、手機名單共用，三種外觀同一個元件；樣式在 style.css 的 .pin-dot）。
// 放在頭像的外框裡（.avb 或 .m-av-wrap，兩者都是 position:relative）。這個檔在 node 也要能載入，所以不取用 Vue。
export const PinDot = {
  name: 'PinDot',
  props: { status: { type: String, default: 'online' } },   // 顏色照狀態：在線綠、忙碌紅、離線灰（#1729）；群組沒有狀態，用在線
  template: `<span class="pin-dot" :class="'st-' + status" role="img" aria-label="已釘選" title="已釘選"><svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path d="M9 3h6l-1 6 3 3v2h-4v6l-1 1-1-1v-6H7v-2l3-3z" fill="currentColor"/></svg></span>`,
}
