// 工作管理員的樹狀畫面（#1860 F）：ASN ＞ 終端服務 ＞ 各代理。電腦、手機、別台設備共用這一份元件，樣式 .tm-* 在 style.css。
// 元件只吃整理好的資料（controller.view().tree，見 task-tree.mjs）：不讀名單、不呼叫後端；按鈕按下去只往外送 act（操作名, 值），
// 操作名沿用 tm-ask／tm-handover／tm-view／tm-adopt，由外面接到既有的停止、交接、看畫面、納入管理。
// 收合狀態（▾）與小字展開（點整列）都由元件自己記，5 秒更新資料時不會被重設。小字預設收起，主行只留名稱、狀態、標籤、重複警示與操作鈕。
// 這個檔在 node 也要能載入（測試），所以 Vue 只在元件 setup 裡才取用。
import { AsnButton, AsnConfirm, AsnStatus } from './ui-kit.mjs'
import { COLUMNS, DASH, TEXT as TM } from './task-manager.mjs'
import { TREE_TEXT, ROOT_KEY, isCollapsed, toggleCollapsed } from './task-tree.mjs'

// 欄位名只有 COLUMNS 一個來源（原本表格的表頭）
const LABEL = Object.freeze({ engine: COLUMNS[1], pid: COLUMNS[2], memory: COLUMNS[3], uptime: COLUMNS[4], cmp: COLUMNS[6], where: COLUMNS[7] })

/** 一個節點的小字欄位（引擎、程序編號、記憶體、開了多久、壓縮次數）：{ k, v }；整理成純函式，畫面與測試共用。預設收起，點那一列才看得到。
 * 「請交接／交接中」的標籤要讓人據以行動，留在主行，不在這裡 */
export function nodeFields(n) {
  const out = [
    { k: LABEL.engine, v: n.engine },
    { k: LABEL.pid, v: n.pid },
    { k: LABEL.memory, v: n.memory },
    { k: LABEL.uptime, v: n.uptime },
  ]
  // 壓縮次數只有 Claude 視窗有；其他列不放（原本表格每列都寫「—」，樹裡不再逐列重複）
  if (n.cmpText !== DASH || n.cmpTag) out.push({ k: LABEL.cmp, v: n.cmpText })
  return out
}

export const TaskNode = {
  name: 'TaskNode',
  components: { AsnButton, AsnConfirm, AsnStatus },
  props: {
    node: { type: Object, required: true },
    restart: { type: Object, default: null },   // ASN、終端服務才有：{ target, ask（確認文字，空白＝沒在確認）, busy, disabled, error }
    level: { type: Number, default: 1 },
    foldable: { type: Boolean, default: false },
    folded: { type: Boolean, default: false },
    stateText: { type: String, default: '' },   // 狀態那一格要寫的字（ASN 寫「運作中」、終端服務寫「底下 N 個代理」）；空白就用這一列自己的狀態
    busy: { type: Boolean, default: false },
    open: { type: Boolean, default: false },   // 小字展開了沒（狀態由 TaskTree 記，這裡只畫）
  },
  emits: ['fold', 'act', 'toggle'],
  setup(props, { emit }) {
    const { computed } = globalThis.Vue
    const fields = computed(() => nodeFields(props.node))
    const state = computed(() => props.stateText || props.node.status)
    // 整列點一下切換小字（#2219）。▾ 收合與操作鈕（.tm-act）不算：點它們只做自己的事，不展開
    const onRow = e => {
      if (e?.target?.closest?.('.tm-act, .tm-fold')) return
      emit('toggle')
    }
    return { TM, TREE_TEXT, LABEL, fields, state, onRow }
  },
  template: `<div class="tm-node" :class="{ dup: node.dup, view: node.viewOnly }" :data-kind="node.kind" :data-level="level" role="treeitem" :aria-level="level" :aria-expanded="foldable ? String(!folded) : null" @click="onRow">
    <asn-button v-if="foldable" level="text" class="tm-fold" :aria-label="(folded ? TREE_TEXT.unfold : TREE_TEXT.fold) + ' ' + node.name" @click="$emit('fold')">{{ folded ? '▸' : '▾' }}</asn-button>
    <span v-else class="tm-fold-gap" aria-hidden="true"></span>
    <div class="tm-main">
      <div class="tm-title" role="button" tabindex="0" :aria-expanded="String(open)" @keydown.enter.prevent="$emit('toggle')" @keydown.space.prevent="$emit('toggle')"><b class="tm-name">{{ node.name }}</b><span class="tm-tag dup" v-if="node.dup">{{ TM.dupTag }}</span><span class="tm-state">{{ state }}</span><span class="tm-tag" v-if="node.cmpTag" :class="node.cmpState === 'handing' ? 'cmp-go' : 'cmp-warn'">{{ node.cmpTag }}</span></div>
      <small class="tm-dupnote" v-if="node.dupNote">{{ node.dupNote }}</small>
      <div class="tm-detail" v-if="open">
        <small class="tm-meta"><span class="tm-f" v-for="f in fields" :key="f.k">{{ f.k }} {{ f.v }}</span></small>
        <small class="tm-where">{{ LABEL.where }} <span class="tm-src"><span class="tm-tag native" v-if="node.native">{{ node.source }}</span><template v-else>{{ node.source }}</template></span></small>
      </div>
    </div>
    <div class="tm-act" @click.stop @keydown.stop>
      <asn-button state="danger" class="tm-stop" v-if="!node.viewOnly && !node.handing" :disabled="!node.canStop || busy" :title="node.why" :aria-label="TM.stop + ' ' + node.name" @click="$emit('act', 'tm-ask', node.key)">{{ TM.stop }}</asn-button>
      <small class="tm-viewonly" v-else-if="node.showViewOnly && !restart" :title="node.why">{{ TM.viewOnly }}</small><!-- 有「重啟」的列（ASN、終端服務）不寫「只能看」，免得跟旁邊的重啟矛盾（#1860 F） -->
      <small class="tm-why" v-if="!node.viewOnly && !node.canStop && node.why">{{ node.why }}</small>
      <asn-button class="tm-handover" v-if="node.canHandover" :disabled="busy" :title="TM.handoverTip" :aria-label="TM.handover + ' ' + node.name" @click="$emit('act', 'tm-handover', node.name)">{{ TM.handover }}</asn-button>
      <asn-button class="tm-view-btn" v-if="node.canView" :disabled="busy" :title="TM.viewTip" :aria-label="TM.view + ' ' + node.name" @click="$emit('act', 'tm-view', node.name)">{{ TM.view }}</asn-button>
      <asn-button class="tm-adopt" v-if="node.canAdopt" :disabled="busy" :title="TM.adoptTip" :aria-label="TM.adopt + ' ' + node.name" @click="$emit('act', 'tm-adopt', node.key)">{{ TM.adopt }}</asn-button>
      <template v-if="restart">
        <asn-status v-if="restart.busy" class="tm-restarting" kind="busy" :text="TREE_TEXT.restarting"></asn-status>
        <asn-button v-else-if="!restart.ask" class="tm-restart" :disabled="busy || restart.disabled" :aria-label="TREE_TEXT.restart + ' ' + node.name" @click="$emit('act', 'tm-restart-ask', restart.target)">{{ TREE_TEXT.restart }}</asn-button>
      </template>
    </div>
    <small class="tm-why tm-restart-err" v-if="restart && restart.error" role="alert">{{ restart.error }}</small>
    <asn-confirm class="tm-restart-confirm" v-if="restart && restart.ask" danger :text="restart.ask" :yes="TREE_TEXT.restart" :no="TREE_TEXT.cancel" @yes="$emit('act', 'tm-restart-confirm', restart.target)" @no="$emit('act', 'tm-restart-cancel')"></asn-confirm>
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
    // 小字展開：和收合子樹分開記，以列的穩定鍵（node.key）為準，5 秒更新換了 tree 也不會重設
    const opened = ref([])
    const isOpen = node => isCollapsed(opened.value, node.key)
    const toggle = node => { opened.value = toggleCollapsed(opened.value, node.key) }
    return { ROOT_KEY, folded, fold, base, act, isOpen, toggle }
  },
  template: `<div class="tm-tree" role="tree">
    <task-node v-if="tree.root" :node="tree.root.node" :level="1" foldable :folded="folded(ROOT_KEY)" :state-text="tree.root.statusText" :restart="tree.root.restart" :busy="busy" :open="isOpen(tree.root.node)" @fold="fold(ROOT_KEY)" @toggle="toggle(tree.root.node)" @act="act"></task-node>
    <div class="tm-kids" :class="{ top: !tree.root }" role="group" v-if="!tree.root || !folded(ROOT_KEY)">
      <template v-for="g in tree.groups" :key="g.key">
        <task-node :node="g.node" :level="base()" foldable :folded="folded(g.key)" :state-text="g.summary" :restart="g.restart" :busy="busy" :open="isOpen(g.node)" @fold="fold(g.key)" @toggle="toggle(g.node)" @act="act"></task-node>
        <div class="tm-kids" role="group" v-if="!folded(g.key)">
          <task-node v-for="a in g.agents" :key="a.key" :node="a" :level="base() + 1" :busy="busy" :open="isOpen(a)" @toggle="toggle(a)" @act="act"></task-node>
        </div>
      </template>
      <task-node v-for="d in tree.direct" :key="d.key" :node="d" :level="base()" :busy="busy" :open="isOpen(d)" @toggle="toggle(d)" @act="act"></task-node>
    </div>
  </div>`,
}
