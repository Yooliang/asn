// 工作管理員的樹狀畫面（#1860 F）：ASN ＞ 終端服務 ＞ 各代理。電腦、手機、別台設備共用這一份元件，樣式 .tm-* 在 style.css。
// 元件只吃整理好的資料（controller.view().tree，見 task-tree.mjs）：不讀名單、不呼叫後端；按鈕按下去只往外送 act（操作名, 值），
// 操作名沿用 tm-ask／tm-handover／tm-view／tm-adopt，由外面接到既有的停止、交接、看畫面、納入管理。
// 收合狀態（▾）由元件自己記，5 秒更新資料時不會被打回展開。
// 這個檔在 node 也要能載入（測試），所以 Vue 只在元件 setup 裡才取用。
import { AsnButton } from './ui-kit.mjs'
import { COLUMNS, DASH, TEXT as TM } from './task-manager.mjs'
import { TREE_TEXT, ROOT_KEY, isCollapsed, toggleCollapsed } from './task-tree.mjs'

// 欄位名只有 COLUMNS 一個來源（原本表格的表頭）
const LABEL = Object.freeze({ engine: COLUMNS[1], pid: COLUMNS[2], memory: COLUMNS[3], uptime: COLUMNS[4], cmp: COLUMNS[6], where: COLUMNS[7] })

/** 一個節點的小字欄位（引擎、程序編號、記憶體、開了多久、壓縮次數）：{ k, v, tag, tagState }；整理成純函式，畫面與測試共用 */
export function nodeFields(n) {
  const out = [
    { k: LABEL.engine, v: n.engine },
    { k: LABEL.pid, v: n.pid },
    { k: LABEL.memory, v: n.memory },
    { k: LABEL.uptime, v: n.uptime },
  ]
  // 壓縮次數只有 Claude 視窗有；其他列不放（原本表格每列都寫「—」，樹裡不再逐列重複）
  if (n.cmpText !== DASH || n.cmpTag) out.push({ k: LABEL.cmp, v: n.cmpText, tag: n.cmpTag, tagState: n.cmpState })
  return out
}

export const TaskNode = {
  name: 'TaskNode',
  components: { AsnButton },
  props: {
    node: { type: Object, required: true },
    level: { type: Number, default: 1 },
    foldable: { type: Boolean, default: false },
    folded: { type: Boolean, default: false },
    stateText: { type: String, default: '' },   // 狀態那一格要寫的字（ASN 寫「運作中」、終端服務寫「底下 N 個代理」）；空白就用這一列自己的狀態
    busy: { type: Boolean, default: false },
  },
  emits: ['fold', 'act'],
  setup(props) {
    const { computed } = globalThis.Vue
    const fields = computed(() => nodeFields(props.node))
    const state = computed(() => props.stateText || props.node.status)
    return { TM, TREE_TEXT, LABEL, fields, state }
  },
  template: `<div class="tm-node" :class="{ dup: node.dup, view: node.viewOnly }" :data-kind="node.kind" :data-level="level" role="treeitem" :aria-level="level" :aria-expanded="foldable ? String(!folded) : null">
    <asn-button v-if="foldable" level="text" class="tm-fold" :aria-label="(folded ? TREE_TEXT.unfold : TREE_TEXT.fold) + ' ' + node.name" @click="$emit('fold')">{{ folded ? '▸' : '▾' }}</asn-button>
    <span v-else class="tm-fold-gap" aria-hidden="true"></span>
    <div class="tm-main">
      <div class="tm-title"><b class="tm-name">{{ node.name }}</b><span class="tm-tag dup" v-if="node.dup">{{ TM.dupTag }}</span><span class="tm-state">{{ state }}</span></div>
      <small class="tm-dupnote" v-if="node.dupNote">{{ node.dupNote }}</small>
      <small class="tm-meta"><span class="tm-f" v-for="f in fields" :key="f.k">{{ f.k }} {{ f.v }}<template v-if="f.tag"> <span class="tm-tag" :class="f.tagState === 'handing' ? 'cmp-go' : 'cmp-warn'">{{ f.tag }}</span></template></span></small>
      <small class="tm-where">{{ LABEL.where }} <span class="tm-src"><span class="tm-tag native" v-if="node.native">{{ node.source }}</span><template v-else>{{ node.source }}</template></span></small>
    </div>
    <div class="tm-act">
      <asn-button state="danger" class="tm-stop" v-if="!node.viewOnly && !node.handing" :disabled="!node.canStop || busy" :title="node.why" :aria-label="TM.stop + ' ' + node.name" @click="$emit('act', 'tm-ask', node.key)">{{ TM.stop }}</asn-button>
      <small class="tm-viewonly" v-else-if="node.showViewOnly" :title="node.why">{{ TM.viewOnly }}</small>
      <small class="tm-why" v-if="!node.viewOnly && !node.canStop && node.why">{{ node.why }}</small>
      <asn-button class="tm-handover" v-if="node.canHandover" :disabled="busy" :title="TM.handoverTip" :aria-label="TM.handover + ' ' + node.name" @click="$emit('act', 'tm-handover', node.name)">{{ TM.handover }}</asn-button>
      <asn-button class="tm-view-btn" v-if="node.canView" :disabled="busy" :title="TM.viewTip" :aria-label="TM.view + ' ' + node.name" @click="$emit('act', 'tm-view', node.name)">{{ TM.view }}</asn-button>
      <asn-button class="tm-adopt" v-if="node.canAdopt" :disabled="busy" :title="TM.adoptTip" :aria-label="TM.adopt + ' ' + node.name" @click="$emit('act', 'tm-adopt', node.key)">{{ TM.adopt }}</asn-button>
    </div>
  </div>`,
}

export const TaskTree = {
  name: 'TaskTree',
  components: { TaskNode },
  props: {
    tree: { type: Object, required: true },   // controller.view().tree
    busy: { type: Boolean, default: false },
  },
  emits: ['act'],
  setup(props, { emit }) {
    const { ref } = globalThis.Vue
    const collapsed = ref([])
    const folded = key => isCollapsed(collapsed.value, key)
    const fold = key => { collapsed.value = toggleCollapsed(collapsed.value, key) }
    // 沒有 ASN 本體那一列時，終端服務與直接掛的列就是最外層（層級少一層）
    const base = () => (props.tree.root ? 2 : 1)
    const act = (op, value) => emit('act', op, value)
    return { ROOT_KEY, folded, fold, base, act }
  },
  template: `<div class="tm-tree" role="tree">
    <task-node v-if="tree.root" :node="tree.root.node" :level="1" foldable :folded="folded(ROOT_KEY)" :state-text="tree.root.statusText" :busy="busy" @fold="fold(ROOT_KEY)" @act="act"></task-node>
    <div class="tm-kids" :class="{ top: !tree.root }" role="group" v-if="!tree.root || !folded(ROOT_KEY)">
      <template v-for="g in tree.groups" :key="g.key">
        <task-node :node="g.node" :level="base()" foldable :folded="folded(g.key)" :state-text="g.summary" :busy="busy" @fold="fold(g.key)" @act="act"></task-node>
        <div class="tm-kids" role="group" v-if="!folded(g.key)">
          <task-node v-for="a in g.agents" :key="a.key" :node="a" :level="base() + 1" :busy="busy" @act="act"></task-node>
        </div>
      </template>
      <task-node v-for="d in tree.direct" :key="d.key" :node="d" :level="base()" :busy="busy" @act="act"></task-node>
    </div>
  </div>`,
}
