// 設定聊天窗的內容：某一類設定的表單。整合模式的右邊分頁與分離模式的設定視窗共用同一個元件。
// 元件只顯示「狀態快照」（st）並用 act 事件下指令；狀態與所有動作都在名單視窗的樞紐（list.js）——
// 金鑰、存檔、Rust 指令都不經過這裡，分離視窗也因此不持有任何設定狀態。
// 這個檔在 node 也要能載入（測試），所以 Vue 只在元件 setup 裡才取用。
import { AUTO_CHOICES, AUTO_LABEL, STT_LANGS, STT_LANG_LABEL, STT_MODELS, STT_MODEL_LABEL } from './voice-prefs.mjs'
import { BUBBLES, BUBBLE_LABEL, DP_LABEL, DP_MODES, MODES, MODE_LABEL, TOOLBARS, TOOLBAR_LABEL } from './merge.mjs'
import { CLOSE_CHOICES, CLOSE_LABEL, FRAMES, FRAME_LABEL, NOTIFY_ITEMS } from './prefs.mjs'
import { DIMS, groupOptions } from './dims.mjs'
import { LoginPanel, LogoutPanel } from './login-panel.mjs'
import { CloudInvitePanel } from './cloud-invite.mjs'
import { accountLine } from './claude-accounts.mjs'
import { catByKey, normalizeCatKey } from './settings-cats.mjs'
import { vendorIconSvg } from './vendor-icons.mjs'
import { USAGE_NOTE } from './usage.mjs'
import { quotaView } from './account-quota.mjs'
import { DEVICE_TEXT, canRemoveRow, dropAfter, moveFlags, removedRows, visibleRows } from './device-order.mjs'

// 元件會送出的指令（樞紐的 applySetting 要每個都接得住；測試對照這份清單）
export const SETTING_OPS = [
  'notify', 'now-playing', 'frame', 'mode', 'dpMode', 'toolbar', 'bubble', 'tabDim', 'groupDim',
  'voice-save', 'voice-install', 'acct-switch', 'acct-remove', 'acct-trust', 'device-switch', 'device-move', 'device-reorder', 'device-show', 'device-remove', 'device-restore',
  'closeTo', 'autostart', 'bridge-launch', 'bridge-unaddressed', 'bridge-takeover', 'bridge-takeover-yes', 'bridge-takeover-no', 'askpass-copy', 'autoCheck', 'check-update', 'usage-refresh', 'launch-max', 'launch-cwd', 'pi-setup-ask', 'pi-setup-install', 'pi-setup-cancel', 'pi-setup-remove', 'avatar-remove',
]

export const SettingsPanel = {
  components: { LoginPanel, LogoutPanel, CloudInvitePanel },
  props: { st: { type: Object, required: true }, catKey: { type: String, required: true }, meAv: { type: String, default: '' }, dev: { type: String, default: '' }, askRemove: { type: Boolean, default: false }, removedOpen: { type: Boolean, default: false } },
  emits: ['act', 'avatar-file'],
  setup(props, { emit }) {
    const { ref, computed, onMounted, onBeforeUnmount } = globalThis.Vue
    const fileEl = ref(null)
    // 舊的分類鍵（accounts）併進 devices
    const cat = computed(() => normalizeCatKey(props.catKey))
    const catIcon = catByKey('devices').icon
    // 設備與帳號：選中的設備頁籤（元件自己記；沒選或選的不在了就用這台，再不然第一台）
    // 進來先看「全部設備的列表」；點一列進該設備的細部頁（picked＝設備鍵），返回回列表。dev 屬性＝直接開某台的細部頁
    const picked = ref(props.dev)
    const askRemove = ref(props.askRemove)   // 永久移除的二次確認（細部頁內）
    const removedOpen = ref(props.removedOpen)   // 列表底部「已永久移除」展開
    const allDevs = computed(() => (Array.isArray(props.st.devices) ? props.st.devices : []))
    // 列表含自動隱藏的設備（淡色、標「已隱藏」）；永久移除的不在列表，收在底部的「已永久移除」
    const devs = computed(() => visibleRows(allDevs.value))
    const removedDevs = computed(() => removedRows(allDevs.value))
    const flags = computed(() => moveFlags(devs.value, devs.value.find(d => d.self)?.key))
    const curDev = computed(() => devs.value.find(d => d.key === picked.value) ?? null)
    const open = key => { picked.value = key; askRemove.value = false }
    const backToList = () => { picked.value = ''; askRemove.value = false }
    const onRow = (key, ev) => { if (ev?.target?.closest?.('.dv-row-move')) return; open(key) }
    const removeNow = () => { const k = curDev.value?.key; if (!k) return; act('device-remove', k); backToList() }
    // 滑鼠拖放：拖到某列的上半＝插在前面、下半＝插在後面；放開時交給樞紐存順序
    const dragKey = ref(''), overKey = ref(''), overAfter = ref(false)
    const clearDrag = () => { dragKey.value = ''; overKey.value = ''; overAfter.value = false }
    const dragStart = (key, ev) => { if (devs.value.find(d => d.key === key)?.self) { ev.preventDefault(); return } dragKey.value = key; if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', key) } }
    const dragOver = (key, ev) => {
      if (!dragKey.value || dragKey.value === key) return
      ev.preventDefault()
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
      const r = ev.currentTarget.getBoundingClientRect()
      overKey.value = key; overAfter.value = dropAfter(ev.clientY, r.top, r.height)
    }
    const drop = (key, ev) => {
      ev.preventDefault()
      if (dragKey.value) act('device-reorder', { drag: dragKey.value, target: key, after: overKey.value === key && overAfter.value })
      clearDrag()
    }
    // 這台一定有 Claude 卡片（可加入帳號）；Codex 沒登入時也留著卡片寫登入說明
    const curVendors = computed(() => {
      const d = curDev.value
      if (!d) return []
      const list = Array.isArray(d.vendors) ? d.vendors.map(v => ({ ...v, accounts: v.accounts ?? [] })) : []
      if (!d.self) return list
      if (!list.some(v => v.key === 'claude')) list.unshift({ key: 'claude', label: 'Claude', accounts: [], switchable: false, switchHint: '' })
      if (!list.some(v => v.key === 'codex')) {
        const at = list.findIndex(v => v.key === 'claude') + 1
        list.splice(at, 0, { key: 'codex', label: 'OpenAI（Codex）', accounts: [], note: props.st.accounts?.codexLine || '', switchable: false, switchHint: '' })
      }
      return list
    })
    const act = (op, value) => emit('act', op, value)
    const pickFile = ev => { const f = ev.target.files?.[0]; ev.target.value = ''; if (f) emit('avatar-file', f) }
    return {
      fileEl, act, pickFile, USAGE_NOTE, accountLine, groupOptions,
      cat, catIcon, devs, removedDevs, flags, curDev, curVendors, askRemove, removedOpen, open, backToList, onRow, removeNow, dragKey, overKey, overAfter, clearDrag, dragStart, dragOver, drop, DEVICE_TEXT, canRemoveRow, vendorIcon: vendorIconSvg, qv: a => quotaView(a),
      AUTO_CHOICES, AUTO_LABEL, STT_LANGS, STT_LANG_LABEL, STT_MODELS, STT_MODEL_LABEL,
      MODES, MODE_LABEL, DP_MODES, DP_LABEL, TOOLBARS, TOOLBAR_LABEL, BUBBLES, BUBBLE_LABEL,
      CLOSE_CHOICES, CLOSE_LABEL, FRAMES, FRAME_LABEL, NOTIFY_ITEMS, DIMS,
    }
  },
  template: `<div class="list settings panel-set">
      <template v-if="catKey === 'me'">
        <login-panel></login-panel>
        <div class="av-set">
          <b>大頭貼</b>
          <input ref="fileEl" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden @change="pickFile">
          <div class="av-row">
            <div class="dp" :class="'st-' + st.status"><span><img :src="meAv" alt="我的大頭貼"></span></div>
            <div class="av-btns">
              <button class="aero-btn" type="button" @click="fileEl.click()" :disabled="st.avBusy">選擇圖片…</button>
              <button class="aero-btn" type="button" @click="act('avatar-remove')" :disabled="st.avBusy || !st.hasUpload">移除，改回自動產生</button>
            </div>
          </div>
          <small role="status">{{ st.avMsg || (st.hasUpload ? '目前用的是這台設備上傳的大頭貼。' : '目前用的是自動產生的大頭貼。') }}</small>
        </div>
      </template>
      <template v-if="catKey === 'me'">
        <div class="np-set">
          <b>正在聽的歌</b>
          <label class="chk"><input type="checkbox" :checked="st.nowPlaying?.on === true" @change="act('now-playing', $event.target.checked)" aria-label="顯示正在聽的歌" /><span>顯示正在聽的歌</span></label>
          <small>開啟後，好友會在你的狀態看到「♪ 正在聽：歌名 - 歌手」。只送歌名與歌手，播放中才顯示，暫停就不顯示；預設關閉。</small>
        </div>
        <logout-panel></logout-panel>
      </template>
      <template v-if="catKey === 'notify'">
        <label v-for="i in NOTIFY_ITEMS" :key="i.key" class="chk"><input type="checkbox" :checked="st.notify[i.key]" @change="act('notify', { key: i.key, on: $event.target.checked })" :aria-label="i.label" /><span>{{ i.label }}</span></label>
      </template>
      <template v-if="catKey === 'voice'">
        <div class="voice-set">
          <b>語音</b>
          <label>念出訊息的聲音
            <select class="set-sel" :value="st.voice.cfg.tts_voice" @change="act('voice-save', { tts_voice: $event.target.value })" aria-label="念出訊息的聲音" :disabled="!st.voice.enabled">
              <option value="">預設</option>
              <option v-for="v in st.voice.voices" :key="v.id" :value="v.id">{{ v.label }}</option>
            </select>
          </label>
          <label>收到新訊息自動念
            <select class="set-sel" :value="st.voice.cfg.tts_auto ? 'on' : 'off'" @change="act('voice-save', { tts_auto: $event.target.value === 'on' })" aria-label="收到新訊息自動念" :disabled="!st.voice.enabled"><option v-for="c in AUTO_CHOICES" :key="c" :value="c">{{ AUTO_LABEL[c] }}</option></select>
          </label>
          <small v-if="!st.voice.enabled">念出訊息要由維護者在後台啟用；對話裡每則對方的訊息旁有喇叭鈕，啟用後才念得出聲。</small>
          <small v-else>念出訊息時，那則訊息的文字會經收發室送到語音代理合成（微軟 Edge 的非公開介面，僅個人用）。語音輸入則完全在這台電腦上辨識。</small>
          <label>語音輸入的語言
            <select class="set-sel" :value="st.voice.cfg.stt_lang" @change="act('voice-save', { stt_lang: $event.target.value })" aria-label="語音輸入的語言"><option v-for="l in STT_LANGS" :key="l" :value="l">{{ STT_LANG_LABEL[l] }}</option></select>
          </label>
          <label>語音辨識模型
            <select class="set-sel" :value="st.voice.cfg.stt_model" @change="act('voice-save', { stt_model: $event.target.value })" aria-label="語音辨識模型"><option v-for="m in STT_MODELS" :key="m" :value="m">{{ STT_MODEL_LABEL[m] }}</option></select>
          </label>
          <div class="av-btns"><button class="aero-btn" type="button" @click="act('voice-install')" :disabled="st.voice.installBusy || st.voice.sttReady">下載語音辨識</button></div>
          <small role="status">{{ st.voice.note }}</small>
        </div>
      </template>
      <template v-if="cat === 'devices'">
        <div class="dv-set">
          <header class="dv-head">
            <h2 class="dv-title"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="catIcon"></path></svg>設備與帳號</h2>
          </header>
          <template v-if="!curDev">
            <small v-if="!devs.length">{{ DEVICE_TEXT.empty }}</small>
            <ul class="dv-list" aria-label="設備" v-else>
              <li v-for="d in devs" :key="d.key" :data-dev="d.key" :class="['dv-row', { hid: d.hidden, off: !d.online, dragging: dragKey === d.key, 'drop-before': overKey === d.key && !overAfter, 'drop-after': overKey === d.key && overAfter }]" :draggable="!d.self" @click="onRow(d.key, $event)" @dragstart="dragStart(d.key, $event)" @dragover="dragOver(d.key, $event)" @drop="drop(d.key, $event)" @dragend="clearDrag">
                <button class="dv-row-go" type="button" :aria-label="'查看 ' + d.label + ' 的帳號'"><span class="dv-name">{{ d.label }}</span><span class="dv-tag kind">{{ d.kind }}</span><span :class="['dv-tag', d.online ? 'on' : 'off']">{{ d.onlineText }}</span><span class="dv-tag me" v-if="d.self">這台</span><span class="dv-tag hid" v-if="d.hidden">{{ DEVICE_TEXT.hiddenTag }}</span></button>
                <span class="dv-row-move" v-if="!d.self" role="group" aria-label="設備順序">
                  <button class="aero-btn" type="button" :disabled="!flags[d.key].up" :aria-label="'上移 ' + d.label" @click.stop="act('device-move', { node: d.key, dir: -1 })">{{ DEVICE_TEXT.moveUp }}</button>
                  <button class="aero-btn" type="button" :disabled="!flags[d.key].down" :aria-label="'下移 ' + d.label" @click.stop="act('device-move', { node: d.key, dir: 1 })">{{ DEVICE_TEXT.moveDown }}</button>
                </span>
                <span class="dv-chev" aria-hidden="true">&rsaquo;</span>
              </li>
            </ul>
            <div class="dv-removed" v-if="removedDevs.length">
              <button class="dv-removed-link" type="button" :aria-expanded="removedOpen ? 'true' : 'false'" @click="removedOpen = !removedOpen">{{ DEVICE_TEXT.removedLink(removedDevs.length) }}</button>
              <ul v-if="removedOpen">
                <li v-for="d in removedDevs" :key="d.key"><span>{{ d.label }}</span><button class="aero-btn" type="button" @click="act('device-restore', d.key)">{{ DEVICE_TEXT.restore }}</button></li>
              </ul>
            </div>
          </template>
          <section class="dv-dev" v-else :aria-label="curDev.label">
            <div class="dv-dev-h">
              <button class="aero-btn dv-back" type="button" @click="backToList">{{ DEVICE_TEXT.back }}</button>
              <h3 class="dv-name">{{ curDev.label }}</h3>
              <span class="dv-tag kind">{{ curDev.kind }}</span>
              <span :class="['dv-tag', curDev.online ? 'on' : 'off']">{{ curDev.onlineText }}</span>
              <span class="dv-tag me" v-if="curDev.self">這台</span>
              <span class="dv-tag off" v-if="curDev.hidden">{{ DEVICE_TEXT.hiddenTag }}</span>
            </div>
            <div class="dv-hid-act" v-if="canRemoveRow(curDev)">
              <template v-if="!askRemove">
                <button class="aero-btn" type="button" @click="act('device-show', curDev.key)">{{ DEVICE_TEXT.showBack }}</button>
                <button class="aero-btn dv-danger" type="button" @click="askRemove = true">{{ DEVICE_TEXT.remove }}</button>
              </template>
              <template v-else>
                <p class="dv-confirm" role="alert">{{ DEVICE_TEXT.confirmRemove(curDev.label) }}</p>
                <button class="aero-btn dv-danger" type="button" @click="removeNow">{{ DEVICE_TEXT.removeYes }}</button>
                <button class="aero-btn" type="button" @click="askRemove = false">{{ DEVICE_TEXT.cancel }}</button>
              </template>
            </div>
            <small v-if="curDev.reportedText">{{ curDev.reportedText }}</small>
            <div :class="['dv-body', { off: !curDev.online }]">
              <div class="dv-empty" v-if="!curVendors.length"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h13v9H3zM1 18h17M19 8h3v11h-3z"></path></svg><span>{{ curDev.empty || '這台設備還沒有回報任何廠商' }}</span></div>
              <ul class="dv-vendors" v-else>
                <li :class="['dv-vendor', 'v-' + v.key]" v-for="v in curVendors" :key="v.key">
                  <header class="dv-vh"><span class="dv-vicon" aria-hidden="true" v-html="vendorIcon(v.key)"></span><b>{{ v.label }}</b></header>
                  <div class="dv-vb">
                    <template v-if="curDev.self && v.key === 'claude'">
                      <ul class="dv-accts" v-if="st.accounts.list.length">
                        <li :class="['dv-acct', { cur: a.current }]" v-for="a in st.accounts.list" :key="a.email">
                          <span class="dv-mail">{{ a.email }}</span>
                          <span class="dv-side">
                            <span class="dv-plan" v-if="a.plan">{{ a.plan }}</span>
                            <span class="dv-cur" v-if="a.current">使用中</span>
                            <button class="aero-btn" type="button" @click="act('acct-switch', a.email)" :disabled="st.accounts.busy || a.current">切換</button>
                            <button class="aero-btn" type="button" @click="act('acct-remove', a.email)" :disabled="st.accounts.busy">{{ st.accounts.confirmDel === a.email ? '確認刪除' : '刪除' }}</button>
                          </span>
                          <span class="dv-quota" :class="{ stale: qv(a).stale, out: qv(a).exhausted }">
                            <span>{{ qv(a).text }}</span>
                            <span v-if="qv(a).resetText">・{{ qv(a).resetText }}</span>
                            <span v-if="qv(a).meta">（{{ qv(a).meta }}）</span>
                          </span>
                        </li>
                      </ul>
                      <div class="dv-none" v-else>還沒有加入過帳號。</div>
                      <small v-if="st.accounts.current && !st.accounts.current.saved" class="acct-warn">目前登入的 {{ st.accounts.current.email }} 還沒加入帳號庫，ASN 會在一分鐘內自動加入，加入後才能切換到別的帳號。</small>
                      <small v-else-if="!st.accounts.current">這台電腦目前沒有 Claude 登入。</small>
                      <small v-if="st.accounts.autoNote" role="status">{{ st.accounts.autoNote }}</small>
                      <small role="status">{{ st.accounts.msg }}</small>
                      <small v-if="st.accounts.mod" role="status">{{ st.accounts.mod }}</small>
                      <label class="chk"><input type="checkbox" :checked="st.accounts.trustOwn" @change="act('acct-trust', $event.target.checked)" /><span>信任我自己的設備，別台要求切換這台時不用確認</span></label>
                      <small>預設會在這台跳出確認，按了同意才會切換。指令只帶 email，權杖不會經過收發室。</small>
                    </template>
                    <template v-else>
                      <ul class="dv-accts" v-if="v.accounts.length">
                        <li :class="['dv-acct', { cur: a.current }]" v-for="a in v.accounts" :key="a.email">
                          <span class="dv-mail">{{ a.email }}</span>
                          <span class="dv-side">
                            <span class="dv-plan" v-if="a.plan">{{ a.plan }}</span>
                            <span class="dv-cur" v-if="a.current">使用中</span>
                            <button class="aero-btn" type="button" v-else-if="v.key === 'claude' && !curDev.self && (v.switchable || v.switchHint)" :disabled="!v.switchable" @click="act('device-switch', { node: curDev.key, email: a.email })">切換</button>
                          </span>
                          <span class="dv-quota" :class="{ stale: a.quota.stale, out: a.quota.exhausted }" v-if="a.quota">
                            <span>{{ a.quota.text }}</span>
                            <span v-if="a.quota.resetText">・{{ a.quota.resetText }}</span>
                            <span v-if="a.quota.meta">（{{ a.quota.meta }}）</span>
                          </span>
                        </li>
                      </ul>
                      <div class="dv-none" v-else><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v4M12 16h.01"></path></svg>{{ v.note || '目前未回報任何帳號' }}</div>
                      <small v-if="v.switchHint">{{ v.switchHint }}</small>
                    </template>
                  </div>
                </li>
              </ul>
            </div>
          </section>
          <cloud-invite-panel></cloud-invite-panel>
        </div>
      </template>
      <template v-if="catKey === 'look'">
        <label>視窗外框
          <select class="set-sel" :value="st.frame" @change="act('frame', $event.target.value)" aria-label="視窗外框"><option v-for="f in FRAMES" :key="f" :value="f">{{ FRAME_LABEL[f] }}</option></select>
        </label>
        <label>視窗模式
          <select class="set-sel" :value="st.mode" @change="act('mode', $event.target.value)" aria-label="視窗模式"><option v-for="m in MODES" :key="m" :value="m">{{ MODE_LABEL[m] }}</option></select>
        </label>
        <label>頭像模式
          <select class="set-sel" :value="st.dpMode" @change="act('dpMode', $event.target.value)" aria-label="頭像模式"><option v-for="m in DP_MODES" :key="m" :value="m">{{ DP_LABEL[m] }}</option></select>
        </label>
        <label>工具列位置
          <select class="set-sel" :value="st.toolbar" @change="act('toolbar', $event.target.value)" aria-label="工具列位置"><option v-for="b in TOOLBARS" :key="b" :value="b">{{ TOOLBAR_LABEL[b] }}</option></select>
        </label>
        <label>文字底色
          <select class="set-sel" :value="st.bubble" @change="act('bubble', $event.target.value)" aria-label="文字底色"><option v-for="b in BUBBLES" :key="b" :value="b">{{ BUBBLE_LABEL[b] }}</option></select>
        </label>
      </template>
      <template v-if="catKey === 'window'">
        <label>關閉視窗時
          <select class="set-sel" :value="st.closeTo" @change="act('closeTo', $event.target.value)" aria-label="關閉視窗時"><option v-for="c in CLOSE_CHOICES" :key="c" :value="c">{{ CLOSE_LABEL[c] }}</option></select>
        </label>
        <small v-if="!st.trayOk">這台電腦建不起系統匣圖示，關閉視窗一律結束程式。</small>
        <label class="chk" v-if="st.autostart.supported"><input type="checkbox" :checked="st.autostart.on" :disabled="st.autostart.busy || (!!st.autostart.blocked && !st.autostart.on)" @change="act('autostart', $event.target.checked)" aria-label="登入時自動啟動 ASN" /><span>登入時自動啟動 ASN</span></label>
        <small v-if="st.autostart.supported && st.autostart.blocked" class="autostart-blocked">{{ st.autostart.blocked }}</small>
        <section class="set-card" aria-label="收發室" v-if="st.bridge">
          <label class="chk"><input type="checkbox" :checked="st.bridge.remoteLaunch" :disabled="st.bridge.busy" @change="act('bridge-launch', $event.target.checked)" aria-label="允許我的其他設備替這台開新視窗" /><span>允許我的其他設備替這台開新視窗</span></label>
          <label>沒指定收件人的信交給
            <input class="set-sel" type="text" maxlength="100" :value="st.bridge.unaddressedTo" :disabled="st.bridge.busy" placeholder="留空＝交給我本人" @change="act('bridge-unaddressed', $event.target.value)" aria-label="沒指定收件人的信交給哪個視窗" />
          </label>
          <small>寄來的信沒有指定收件視窗時，預設交給你本人，在對話裡標示「沒有指定收件人」。指定的視窗不在線時也會交給你本人。</small>
          <small v-if="st.bridge.running">這台的收發室目前由 ASN 負責。</small>
          <small v-else-if="st.bridge.legacy">這台的收發室目前由舊版收發室橋負責。</small>
          <template v-if="st.bridge.legacy && st.bridge.takeoverAllowed">
            <button v-if="!st.bridge.confirm" class="aero-btn" type="button" :disabled="st.bridge.busy" @click="act('bridge-takeover')">改由 ASN 負責</button>
            <div v-else class="upd-row">
              <small>要停掉舊版收發室橋，改由 ASN 負責嗎？</small>
              <button class="aero-btn" type="button" :disabled="st.bridge.busy" @click="act('bridge-takeover-yes')">確定</button>
              <button class="aero-btn" type="button" :disabled="st.bridge.busy" @click="act('bridge-takeover-no')">取消</button>
            </div>
          </template>
          <small v-if="st.bridge.error">{{ st.bridge.error }}</small>
        </section>
      </template>
      <template v-if="catKey === 'update'">
        <section class="set-card upd-card" aria-label="更新">
          <label class="chk"><input type="checkbox" :checked="st.autoCheck" @change="act('autoCheck', $event.target.checked)" aria-label="自動檢查更新" /><span>自動檢查更新</span></label>
          <div class="upd-row">
            <button class="aero-btn" type="button" @click="act('check-update')" :disabled="st.upd.checking || st.upd.installing">立即檢查</button>
            <div class="upd-status" :class="'tone-' + st.upd.status.tone" role="status">
              <b>{{ st.upd.status.head }}</b>
              <small v-for="(l, i) in st.upd.status.lines" :key="i">{{ l }}</small>
            </div>
          </div>
        </section>
        <section class="chlog" aria-label="版本更新記錄">
          <b>版本更新記錄</b>
          <p v-if="!(st.log && st.log.length)" class="chlog-none">沒有可顯示的更新記錄。</p>
          <article v-for="e in (st.log || [])" :key="e.version" class="chlog-item" :class="e.tag">
            <header><span class="chlog-ver">{{ e.version }}</span><span v-if="e.tag === 'current'" class="chlog-tag">目前版本</span><span v-else-if="e.tag === 'update'" class="chlog-tag upd">可更新</span><time v-if="e.date">{{ e.date }}</time></header>
            <ul><li v-for="(l, i) in e.lines" :key="i">{{ l }}</li></ul>
          </article>
        </section>
      </template>
      <template v-if="catKey === 'tabs'">
        <label>分頁依
          <select class="set-sel" :value="st.tabDim" @change="act('tabDim', $event.target.value)" aria-label="分頁依"><option v-for="d in DIMS" :key="d.key" :value="d.key">{{ d.label }}</option></select>
        </label>
        <label>分組依
          <select class="set-sel" :value="st.groupDim" @change="act('groupDim', $event.target.value)" aria-label="分組依"><option v-for="d in groupOptions(st.tabDim)" :key="d.key" :value="d.key">{{ d.label }}</option></select>
        </label>
      </template>
      <template v-if="catKey === 'launch'">
        <div class="launch-set">
          <b>啟動設定</b>
          <p class="launch-note">偵測本機 CLI 自動產生啟動方式；指令只在這台電腦決定，不上傳雲端。</p>
          <ul class="launch-tools">
            <li v-for="t in st.launch.tools" :key="t.id" :class="{ off: !t.installed }">
              <span class="launch-name">{{ t.label }}</span>
              <span class="launch-ver" v-if="t.installed">{{ t.version || '已安裝' }}</span>
              <span class="launch-hint" v-else>{{ t.installHint }}</span>
            </li>
          </ul>
          <section class="set-card" aria-label="pi 與 ASN 互通" v-if="st.piSetup">
            <b>{{ st.piSetup.title }}</b>
            <small v-for="(l, i) in st.piSetup.lines" :key="i">{{ l }}</small>
            <small v-if="st.piSetup.consent">{{ st.piSetup.consent }}</small>
            <div class="upd-row">
              <button class="aero-btn" type="button" v-if="st.piSetup.showAsk" :disabled="st.piSetup.busy" @click="act('pi-setup-ask')">{{ st.piSetup.askLabel }}</button>
              <button class="aero-btn" type="button" v-if="st.piSetup.showAgree" :disabled="st.piSetup.busy" @click="act('pi-setup-install')">{{ st.piSetup.agreeLabel }}</button>
              <button class="aero-btn" type="button" v-if="st.piSetup.showCancel" :disabled="st.piSetup.busy" @click="act('pi-setup-cancel')">{{ st.piSetup.cancelLabel }}</button>
              <button class="aero-btn" type="button" v-if="st.piSetup.showReinstall" :disabled="st.piSetup.busy" @click="act('pi-setup-install')">{{ st.piSetup.reinstallLabel }}</button>
              <button class="aero-btn" type="button" v-if="st.piSetup.showRemove" :disabled="st.piSetup.busy" @click="act('pi-setup-remove')">{{ st.piSetup.removeLabel }}</button>
            </div>
            <small v-if="st.piSetup.msg" role="status">{{ st.piSetup.msg }}</small>
          </section>
          <label>每小時開新夥伴上限
            <input class="set-input" type="number" min="1" max="20" :value="st.launch.maxPerHour" @change="act('launch-max', Number($event.target.value))">
          </label>
          <label>工作資料夾白名單（一行一個）
            <textarea class="set-area" rows="4" :value="st.launch.cwdText" @change="act('launch-cwd', $event.target.value)"></textarea>
          </label>
        <details class="set-adv" v-if="st.askpass">
          <summary>進階</summary>
          <section class="set-card" aria-label="密碼小幫手">
            <small>git 或 ssh 要密碼時由 ASN 跳窗請你輸入，密碼不會經過 AI。想用的話，在終端機執行下面這行（只對之後開的視窗生效；ASN 不會自動改你的設定）：</small>
            <code class="set-code">{{ st.askpass.example }}</code>
            <button class="aero-btn" type="button" @click="act('askpass-copy')">{{ st.askpass.copied ? '已複製' : '複製路徑' }}</button>
          </section>
        </details>
        </div>
      </template>
      <template v-if="catKey === 'usage'">
        <div class="usage-set">
          <div class="upd-row">
            <button class="aero-btn" type="button" @click="act('usage-refresh')" :disabled="st.usage.loading">重新整理</button>
            <small role="status">{{ st.usage.loading ? '正在讀取本機記錄…' : (st.usage.updated ? '更新於 ' + st.usage.updated : '') }}</small>
          </div>
          <small>{{ USAGE_NOTE }}</small>
          <small v-if="st.usage.error" class="acct-warn">{{ st.usage.error }}</small>
          <template v-if="st.usage.data">
            <small v-if="st.usage.data.empty">{{ st.usage.data.empty }}</small>
            <section class="set-card usage-card" v-for="p in st.usage.data.periods" :key="p.key" :aria-label="p.label">
              <header class="vendor-h"><b>{{ p.label }}</b><span class="usage-cost">約 {{ p.cost }}</span></header>
              <small>{{ p.tokens }} 個 token、{{ p.messages }} 則回覆</small>
              <small>{{ p.detail }}</small>
              <table class="usage-tbl" v-if="p.models.length">
                <thead><tr><th>模型</th><th>token</th><th>估算成本</th></tr></thead>
                <tbody><tr v-for="m in p.models" :key="m.model"><td>{{ m.model }}</td><td>{{ m.tokens }}</td><td>{{ m.cost }}</td></tr></tbody>
              </table>
            </section>
            <small v-if="st.usage.data.unpriced">{{ st.usage.data.unpriced }}</small>
            <small>{{ st.usage.data.priceLine }}</small>
          </template>
        </div>
      </template>
      <template v-if="catKey === 'about'">
        <small class="ver-line">版本 {{ st.version }}</small>
      </template>
    </div>`,
}
