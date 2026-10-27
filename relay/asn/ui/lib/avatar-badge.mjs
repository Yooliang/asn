// 統一頭像（#336 第二期）：頭像外框照上線狀態上色，右下角疊一個白底小方塊放廠商圖示；離線時整顆灰階。
// 電腦版（名單、釘選、終端列、對話上方、側欄大頭、訊息旁、群組發言者）與手機名單都用這一個元件，樣式只有 style.css 的 .avb 一套。
// 這個檔在 node 也要能載入（測試），所以不取用 Vue；元件只用 props 與 computed 寫法的物件。

import { vendorBadgeHtml, vendorIconSvg, withUniqueIds } from './vendor-icons.mjs'

export const AVATAR_SIZES = Object.freeze(['xs', 'sm', 'xl'])

// 小方塊裡放什麼：有夥伴就照夥伴推（pi 照背後的模型、ASN 用機器人 logo）；只知道廠商（群組發言者）就用廠商的圖；
// 都沒有（真人、群組、面板）就不放。回的都是內建固定字串，沒有外部資料。
export function avatarBadgeHtml({ friend = null, vendor = '' } = {}) {
  if (friend) return vendorBadgeHtml(friend)
  if (vendor) return vendorIconSvg(vendor)
  return ''
}

let seq = 0   // 每個頭像自己的尾碼（只在建立元件時取一次，重繪不會變）

export const AsnAvatar = {
  name: 'AsnAvatar',
  props: {
    src: { type: String, default: '' },          // 頭像圖；沒有就看 glyph
    glyph: { type: String, default: '' },        // 沒有圖時放的字（例如終端的 >_）
    friend: { type: Object, default: null },     // 夥伴：用來推廠商圖示；不傳＝不顯示小方塊
    vendor: { type: String, default: '' },       // 只知道廠商鍵時用（群組發言者）
    size: { type: String, default: 'xs' },
    status: { type: String, default: 'online' }, // 外框顏色（online／busy／away／offline）
    off: { type: Boolean, default: null },       // 整顆灰階；沒給就看 status 是不是離線
    hue: { type: Number, default: null },
  },
  data() { return { uid: `av${++seq}` } },
  computed: {
    sizeClass() { return AVATAR_SIZES.includes(this.size) ? this.size : 'xs' },
    isOff() { return this.off ?? this.status === 'offline' },
    badge() { return withUniqueIds(avatarBadgeHtml({ friend: this.friend, vendor: this.vendor }), this.uid) },
    hueStyle() { return Number.isFinite(this.hue) ? { '--h': this.hue } : null },
  },
  template: `<span class="avb" :class="[sizeClass, { off: isOff }]"><span class="dp" :class="[sizeClass, 'st-' + status]" :style="hueStyle"><span v-if="src"><img :src="src" alt=""></span><span v-else-if="glyph" class="term-glyph" aria-hidden="true">{{ glyph }}</span><span v-else></span></span><span class="avb-v" aria-hidden="true" v-if="badge" v-html="badge"></span></span>`,
}
