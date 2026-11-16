// 新手引導卡（#1605）的畫面元件：電腦版名單與手機設備卡共用。資料與規則在 new-computer-guide.mjs。
// props：rows（guideRows 的結果）、btnClass（電腦版 aero-btn、手機版 m-btn）、hint（手機：某一列的補充說明，{ key, text }）
// canRecheck／rechecking：有「重新檢查」鈕（電腦版）、正在檢查中（鈕反灰、寫「正在檢查…」）；事件 recheck
// 事件：act（按動作鈕，帶那一列）、site（點官網，帶 site）、hide（先不用）
import { GUIDE_TEXT } from './new-computer-guide.mjs'

const ACTION_TEXT = { open: GUIDE_TEXT.open, login: GUIDE_TEXT.login, install: GUIDE_TEXT.install }

export const NewGuideCard = {
  name: 'NewGuideCard',
  props: { rows: { type: Array, required: true }, btnClass: { type: String, default: 'aero-btn' }, hint: { type: Object, default: null }, rechecking: { type: Boolean, default: false }, canRecheck: { type: Boolean, default: false } },
  emits: ['act', 'site', 'hide', 'recheck'],
  setup() { return { T: GUIDE_TEXT, actionText: r => ACTION_TEXT[r.action] ?? '' } },
  template: `<section class="ng-card" aria-label="新手引導">
    <h3 class="ng-title">{{ T.title }}</h3>
    <ul class="ng-rows">
      <li class="ng-row" v-for="r in rows" :key="r.key" :data-vendor="r.key">
        <span class="ng-name">{{ r.label }}</span>
        <span class="ng-act">
          <span class="ng-checking" v-if="r.checking" role="status">{{ T.checking }}</span>
          <button type="button" :class="[btnClass, 'ng-btn']" v-else-if="r.action" :data-act="r.action" @click="$emit('act', r)">{{ actionText(r) }}</button>
        </span>
        <p class="ng-note" v-if="r.note">{{ r.note }}</p>
        <p class="ng-note" v-if="r.site">{{ r.site.before }}<a class="ng-link" href="#" role="link" @click.prevent="$emit('site', r.site)">{{ r.site.name }}</a>{{ r.site.after }}</p>
        <p class="ng-note ng-edge" v-if="r.site">{{ T.edgeKeep }}</p>
        <p class="ng-note ng-hint" v-if="hint && hint.key === r.key && hint.text" role="alert">{{ hint.text }}</p>
      </li>
    </ul>
    <div class="ng-foot">
      <button type="button" :class="[btnClass, 'ng-recheck']" v-if="canRecheck" :disabled="rechecking" @click="$emit('recheck')">{{ rechecking ? T.checking : T.recheck }}</button>
      <button type="button" class="ng-hide" @click="$emit('hide')">{{ T.hide }}</button>
    </div>
  </section>`,
}
