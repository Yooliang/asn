// 附件下方的一排小字動作「儲存｜另存新檔」（手機多「分享」）（#1911）。圖片與（#1912）檔案卡共用這一個元件，
// 兩邊動作與長相一致。只顯示、只發 act 事件（帶動作代號 save｜saveas｜share），不碰網路；項目由 photo-inline.mjs 的 actionItems 給。
// off＝反灰（下載中）：還是畫出來讓人知道之後會有，但不能按。note＝底下橘字（例如「剩 2 天可下載」），空字串不畫。
export const AttActions = {
  name: 'AttActions',
  props: {
    items: { type: Array, default: () => [] },
    off: { type: Boolean, default: false },
    note: { type: String, default: '' },
    label: { type: String, default: '' },   // 給讀屏軟體：這排動作是對哪個附件
  },
  emits: ['act'],
  template: `
    <div class="att-acts-wrap">
      <div class="att-acts" :class="{ off }" role="group" :aria-label="label || '附件動作'">
        <template v-for="(it, i) in items" :key="it.key">
          <i v-if="i > 0" aria-hidden="true">｜</i>
          <button type="button" :data-act="it.key" :aria-disabled="off ? 'true' : null" @click.stop="!off && $emit('act', it.key)">{{ it.label }}</button>
        </template>
      </div>
      <div class="att-meta soon" v-if="note">{{ note }}</div>
    </div>`,
}
