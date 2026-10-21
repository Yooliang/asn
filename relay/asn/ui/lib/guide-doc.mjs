// 一篇指引的顯示：全部用文字插值（不插入原始標記），步驟自動編號。整合模式的右邊分頁與分離模式的指引視窗共用。
import { numbered } from './guides.mjs'

export const GuideDoc = {
  props: { guide: { type: Object, required: true } },
  setup: props => ({ rows: globalThis.Vue.computed(() => numbered(props.guide.blocks)) }),
  template: `<article class="guide-article"><h2>{{ guide.title }}</h2>
    <template v-for="(b, i) in rows" :key="i">
      <h3 v-if="b.k === 'h'">{{ b.t }}</h3>
      <p v-else-if="b.k === 'p'">{{ b.t }}</p>
      <p v-else-if="b.k === 'li'" class="g-step"><b>{{ b.n }}</b><span>{{ b.t }}</span></p>
      <pre v-else-if="b.k === 'code'" class="g-code"><code>{{ b.t }}</code></pre>
      <p v-else class="g-note">{{ b.t }}</p>
    </template></article>`,
}
