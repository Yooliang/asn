// 設定聊天窗的內容：某一類設定的表單。整合模式的右邊分頁與分離模式的設定視窗共用同一個元件。
// 元件只顯示「狀態快照」（st）並用 act 事件下指令；狀態與所有動作都在名單視窗的樞紐（list.js）——
// 金鑰、存檔、Rust 指令都不經過這裡，分離視窗也因此不持有任何設定狀態。
// 這個檔在 node 也要能載入（測試），所以 Vue 只在元件 setup 裡才取用。
import { TEXT as KNOWN, groupFp, createForgetConfirm } from './known-peers.mjs'
import { FpMark, deskFpMark } from './fp-mark.mjs'
import { DeviceIdentity, IDENTITY_TEXT } from './device-identity.mjs'
import { ACTION_TEXT } from './device-order.mjs'
import { AsnDialog } from './dialog.mjs'
import { NAME_MAX, deviceNameError, joinKnown, shortFp } from './device-known.mjs'
import { FpQrCanvas, QR_TEXT } from './fp-qr.mjs'
import { AUTO_CHOICES, AUTO_LABEL, STT_LANGS, STT_LANG_LABEL, STT_MODELS, STT_MODEL_LABEL } from './voice-prefs.mjs'
import { BUBBLES, BUBBLE_LABEL, DP_LABEL, DP_MODES, MODES, MODE_LABEL, TOOLBARS, TOOLBAR_LABEL } from './merge.mjs'
import { SKINS, SKIN_LABEL } from './skin.mjs'
import { CLOSE_CHOICES, CLOSE_LABEL, FRAMES, FRAME_LABEL, NOTIFY_ITEMS } from './prefs.mjs'
import { DIMS, groupOptions } from './dims.mjs'
import { LoginPanel, LogoutPanel } from './login-panel.mjs'
import { CloudInvitePanel } from './cloud-invite.mjs'
import { modStatusLine } from './mod-line.mjs'
import { accountLine, INCOMPLETE_LABEL, INCOMPLETE_REASON, loginIncomplete, usableAtText } from './claude-accounts.mjs'
import { catByKey, lookShows, normalizeCatKey } from './settings-cats.mjs'
import { vendorIconSvg } from './vendor-icons.mjs'
import { USAGE_NOTE } from './usage.mjs'
import { aboutView } from './about-info.mjs'
import { NO_QUOTA_TEXT, planLabel } from './account-quota.mjs'
import { DEVICE_TEXT, canRemoveRow, canShowBackRow, dropAfter, moveFlags, removedRows, visibleRows } from './device-order.mjs'
import { switchRowKey, switchResultOf } from './switch-result.mjs'
import { DEVICE_BUTTON_TEXT, DEVICE_ROW_TEXT, ROSTER_TEXT, accountDeviceRows, accountInUse, usedOnText } from './account-roster.mjs'
import { INSTALL_TEXT } from './agent-install.mjs'
import { DESK_RELOGIN_TEXT } from './relogin-flow.mjs'
import { QUOTA_TEXT, shareKey, vendorSections } from './quota-readers.mjs'
import { AGENT_INSTALL_UI } from './device-state.mjs'
import { COLUMNS as TM_COLUMNS, TEXT as TM } from './task-manager.mjs'
import { GH_REFS_LABEL, GH_REFS_NOTE } from './msg-ref.mjs'
import { LAUNCH_MAX_NOTE } from './launch-prefs.mjs'
import { UI_KIT } from './ui-kit.mjs'
import { TERM_SERVER_MISSING_NOTE, termServerWhyLine, keyProtectionNote, termFetchLine, termServerNote } from './term-server-setting.mjs'

// 元件會送出的指令（樞紐的 applySetting 要每個都接得住；測試對照這份清單）
export const SETTING_OPS = [
  'quota-source', 'quota-refresh', 'quota-mm-add', 'quota-mm-remove', 'quota-share', 'quota-unshare', 'quota-copy', 'quota-close',
  'notify', 'now-playing', 'skin', 'gh-refs', 'frame', 'mode', 'dpMode', 'toolbar', 'bubble', 'tabDim', 'groupDim',
  'voice-save', 'voice-install', 'acct-switch', 'acct-remove', 'acct-allow-switch', 'install-ask', 'install-yes', 'install-no', 'install-cancel', 'install-terminal', 'install-close', 'install-allow', 'relogin-ask', 'relogin-yes', 'relogin-no', 'relogin-close', 'grok-switch', 'device-switch', 'row-switch', 'device-move', 'device-reorder', 'device-show', 'device-remove',
  'closeTo', 'autostart', 'guard', 'guard-resume', 'open-link', 'open-guide', 'open-update', 'bridge-launch', 'bridge-auto-resume', 'bridge-compact', 'bridge-compact-n', 'tm-handover', 'known-forget', 'device-rename', 'device-rename-clear', 'known-qr', 'known-login-ok', 'bridge-term-server', 'bridge-term-fetch-retry', 'bridge-screen-watch', 'bridge-perm-phone', 'bridge-mobile-view', 'bridge-remote-input', 'bridge-unaddressed', 'bridge-takeover', 'bridge-takeover-yes', 'bridge-takeover-no', 'askpass-copy', 'autoCheck', 'check-update', 'releases-retry', 'usage-refresh', 'launch-max', 'launch-cwd-add', 'launch-cwd-remove', 'launch-cwd-suggest', 'launch-recheck', 'launch-install-ask', 'launch-install-yes', 'launch-install-no', 'pi-setup-ask', 'pi-setup-install', 'pi-setup-cancel', 'pi-setup-remove', 'avatar-remove', 'pi-login', 'open-ui-log', 'tm-open', 'tm-close', 'tm-ask', 'tm-cancel', 'tm-confirm', 'tm-wake', 'tm-adopt', 'tm-view',
]

export const SettingsPanel = {
  components: { ...UI_KIT, AsnDialog, LoginPanel, LogoutPanel, CloudInvitePanel, FpQrCanvas, FpMark, DeviceIdentity },
  props: { title: { type: String, default: '' }, st: { type: Object, required: true }, catKey: { type: String, required: true }, meAv: { type: String, default: '' }, dev: { type: String, default: '' }, devView: { type: String, default: 'info' }, askRemove: { type: Boolean, default: false }, removedOpen: { type: Boolean, default: false } },
  emits: ['act', 'avatar-file'],
  setup(props, { emit }) {
    const { ref, computed, watch, onMounted, onBeforeUnmount } = globalThis.Vue
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
    const view = ref(props.devView === 'acct' ? 'acct' : 'info')   // 選了某台之後看哪一頁：info＝詳情（預設）、acct＝帳號
    const open = key => { picked.value = key; view.value = allDevs.value.find(d => d.key === key)?.phone ? 'info' : 'acct'; askRemove.value = false; renaming.value = false }
    const openInfo = key => { picked.value = key; view.value = 'info'; askRemove.value = false; renaming.value = false }
    // 工作管理員：只有這台電腦有；進來才開始每 5 秒更新，離開（返回、換頁、關掉設定）就停（樞紐收到 tm-close）
    const openTasks = key => { picked.value = key; view.value = 'tasks'; askRemove.value = false; renaming.value = false; act('tm-open') }
    const backToList = () => { leaveView(); picked.value = ''; view.value = 'info'; askRemove.value = false; renaming.value = false }
    // 離開目前這一頁要收的東西：工作管理員停止更新、QR 收起來、改名輸入清掉
    const leaveView = () => {
      if (view.value === 'tasks') act('tm-close')
      if (view.value === 'qr' && props.st.known && props.st.known.qr) act('known-qr', false)
      if (renaming.value) act('device-rename-clear')
    }
    // 設備頁上方那排按鈕：工作管理員、詳情、QR Code、改名、帳號；按下才展開對應的內容
    const setView = v => {
      if (v === view.value) return
      leaveView()
      askRemove.value = false
      view.value = v
      renaming.value = false
      if (v === 'tasks') act('tm-open')
      if (v === 'qr' && !(props.st.known && props.st.known.qr)) act('known-qr', true)
    }
    onBeforeUnmount(() => leaveView())
    // 停在工作管理員時這台電腦從清單消失：退回清單並停掉每 5 秒更新
    watch(() => view.value === 'tasks' && !curDev.value?.self, gone => { if (gone) backToList() })
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
    // 帳號頁：這個帳號可以切到哪幾台（本機的 Claude／Grok 帳號庫，或別台設備回報裡有這個帳號、對方 ASN 在線、可切換、而且它還沒在用的）
    const switchTargets = (vendor, a) => {
      if (vendor !== 'claude' && vendor !== 'grok') return []
      const mail = String(a?.account ?? '').trim().toLowerCase()
      const out = []
      for (const d of allDevs.value) {
        if (d.hidden || d.removed) continue
        const v = (d.vendors ?? []).find(x => x.key === vendor)
        const has = (v?.accounts ?? []).find(x => String(x.email ?? '').trim().toLowerCase() === mail)
        if (!has || has.current || has.incomplete) continue
        if (d.self) {
          if (vendor === 'claude') out.push({ key: d.key, node: d.key, name: d.label, label: '這台', op: 'acct-switch', value: has.email })
          else if ((v.accounts ?? []).length > 1) out.push({ key: d.key, node: d.key, name: d.label, label: '這台', op: 'grok-switch', value: has.email })
        } else if (v.switchable) out.push({ key: d.key, node: d.key, name: d.label, label: d.label, op: 'device-switch', value: { node: d.key, email: has.email, vendor } })
      }
      return out
    }
    const act = (op, value) => emit('act', op, value)
    const about = computed(() => aboutView({ deviceName: props.st.deviceName }))
    // 帳號卡片的設備列（#2111 ②）：一台一列，列的狀態由共用的 accountDeviceRows 決定（手機同一個函式）。
    // 按下「切換」＝交給樞紐（row-switch）：該列顯示「切換中…」，結果在那一列下方原位顯示（#2111 ③；狀態在 st.accounts.rowSwitch，手機用同一份流程與文字）
    const rowState = computed(() => (props.st.accounts && props.st.accounts.rowSwitch) || {})
    const devRows = (vendor, a) => {
      const prefix = switchRowKey(vendor, a?.account, '')
      const busy = Object.keys(rowState.value).find(k => k.startsWith(prefix) && rowState.value[k].phase === 'busy')
      return accountDeviceRows(allDevs.value, vendor, a?.account, a?.usedOn, { switchingNode: busy ? busy.slice(prefix.length) : '' })
    }
    const rowResult = (vendor, a, node) => switchResultOf(rowState.value, switchRowKey(vendor, a?.account, node))
    const accountInUseOf = (vendor, a) => accountInUse(devRows(vendor, a), a?.current)
    const busyNow = computed(() => Boolean(props.st.accounts && (props.st.accounts.busy || (props.st.accounts.remote && props.st.accounts.remote.busy))))
    const pressDev = (vendor, a, b) => {
      if (b.state !== 'switch' || busyNow.value) return
      if (!switchTargets(vendor, a).some(x => x.node === b.node)) return
      act('row-switch', { vendor, email: a.account, node: b.node, label: b.label, self: b.self })
    }
    // MiniMax 的輸入欄只留在元件裡：送出就清空，不進設定頁快照
    // 設備改名：名字只有一個（存在後台）；輸入只在這個元件裡，存的時候才交給樞紐
    const renaming = ref(false), renameText = ref('')
    const renameErr = computed(() => (renameText.value.trim() === '' ? '' : deviceNameError(renameText.value)))
    const renameStart = () => { renameText.value = curDev.value?.named ? curDev.value.label : ''; renaming.value = true; act('device-rename-clear') }
    const renameCancel = () => { renameText.value = ''; renaming.value = false; act('device-rename-clear') }
    const renameSave = () => {
      const node = curDev.value?.key
      if (!node || deviceNameError(renameText.value)) return
      act('device-rename', { node, name: renameText.value.trim() })
      renaming.value = false; renameText.value = ''; view.value = 'info'   // 失敗的話錯誤顯示在名字下面（renameError），不在這裡清
    }
    const peers = computed(() => (props.st.known && Array.isArray(props.st.known.peers) ? props.st.known.peers : []).map(p => ({ ...p, id: p.node })))   // id＝節點（畫面不直接寫 node）
    // 只算畫面上真的畫出來的設備；已永久移除的（畫面沒有列）歸到「舊設備紀錄」，才找得到地方取消授權或忘記
    // 名單還沒讀到（一台設備都沒有）時，不要把所有紀錄暫時歸到「舊設備紀錄」（和手機版一致）
    const joined = computed(() => { const j = joinKnown(devs.value, peers.value); return devs.value.length ? j : { ...j, old: [] } })
    const curKnown = computed(() => (curDev.value ? joined.value.byNode[curDev.value.key] ?? null : null))
    const oldPeers = computed(() => joined.value.old)
    // 「帳號」鈕：手機沒有帳號可看，不出這顆
    const hasAcct = computed(() => !!curDev.value && (curDev.value.self || !curDev.value.phone))
    // 指紋：本機看自己的、別台看認得的紀錄；都沒有就不顯示這一列（沒有可以做的事）
    const deviceFp = computed(() => (curDev.value?.self && props.st.known && props.st.known.ownFp ? groupFp(props.st.known.ownFp) : curKnown.value ? groupFp(curKnown.value.fingerprint) : ''))
    // 忘記前先確認：誤按會讓那台下次連線要重新確認指紋
    const forgetBox = ref(null)
    const forget = createForgetConfirm({ box: forgetBox, forget: id => act('known-forget', id) })
    const mmEmail = ref('')
    const mmKey = ref('')
    const addMinimax = () => {
      act('quota-mm-add', { email: mmEmail.value, key: mmKey.value })
      mmKey.value = ''
      mmEmail.value = ''
    }
    const pickFile = ev => { const f = ev.target.files?.[0]; ev.target.value = ''; if (f) emit('avatar-file', f) }
    return { LAUNCH_MAX_NOTE, TM, TM_COLUMNS, openTasks, KNOWN, deskFpMark, QR_TEXT, groupFp, shortFp, NAME_MAX, deviceNameError, view, setView, hasAcct, deviceFp, IDENTITY_TEXT, ACTION_TEXT, canShowBackRow, openInfo, renaming, renameText, renameErr, renameStart, renameCancel, renameSave, joined, curKnown, oldPeers, forgetBox, forget,
      QUOTA_TEXT, shareKey, vendorSections, mmEmail, mmKey, addMinimax, devRows, rowResult, accountInUseOf, busyNow, pressDev, DEVICE_BUTTON_TEXT, DEVICE_ROW_TEXT,
      fileEl, act, about, modLine: modStatusLine, pickFile, USAGE_NOTE, accountLine, groupOptions, termServerNote, termFetchLine, TERM_SERVER_MISSING_NOTE, termServerWhyLine, keyProtectionNote,
      cat, catIcon, ROSTER_TEXT, usedOnText, INSTALL_TEXT, DESK_RELOGIN_TEXT, AGENT_INSTALL_UI, switchTargets, devs, removedDevs, flags, curDev, curVendors, askRemove, removedOpen, open, backToList, removeNow, dragKey, overKey, overAfter, clearDrag, dragStart, dragOver, drop, DEVICE_TEXT, canRemoveRow, vendorIcon: vendorIconSvg, NO_QUOTA_TEXT, planLabel, isIncomplete: loginIncomplete, INCOMPLETE_LABEL, INCOMPLETE_REASON, usableAt: a => usableAtText(a),
      AUTO_CHOICES, AUTO_LABEL, STT_LANGS, STT_LANG_LABEL, STT_MODELS, STT_MODEL_LABEL,
      MODES, MODE_LABEL, DP_MODES, DP_LABEL, TOOLBARS, TOOLBAR_LABEL, BUBBLES, BUBBLE_LABEL, SKINS, SKIN_LABEL, lookShows, GH_REFS_LABEL, GH_REFS_NOTE,
      CLOSE_CHOICES, CLOSE_LABEL, FRAMES, FRAME_LABEL, NOTIFY_ITEMS, DIMS,
    }
  },
  template: `<div class="list settings panel-set">
      <h2 class="panel-h" v-if="title && !(catKey === 'devices' && curDev)">{{ title }}</h2>
      <template v-if="catKey === 'me'">
        <login-panel></login-panel>
        <div class="av-set">
          <b>大頭貼</b>
          <input ref="fileEl" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden @change="pickFile">
          <div class="av-row">
            <div class="dp" :class="'st-' + st.status"><span><img :src="meAv" alt="我的大頭貼"></span></div>
            <div class="av-btns">
              <asn-button @click="fileEl.click()" :disabled="st.avBusy">選擇圖片…</asn-button>
              <asn-button @click="act('avatar-remove')" :disabled="st.avBusy || !st.hasUpload">移除，改回自動產生</asn-button>
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
          <small v-else>念出訊息時，那則訊息的文字會經 ASN 送到語音代理合成（微軟 Edge 的非公開介面，僅個人用）。語音輸入則完全在這台電腦上辨識。</small>
          <label>語音輸入的語言
            <select class="set-sel" :value="st.voice.cfg.stt_lang" @change="act('voice-save', { stt_lang: $event.target.value })" aria-label="語音輸入的語言"><option v-for="l in STT_LANGS" :key="l" :value="l">{{ STT_LANG_LABEL[l] }}</option></select>
          </label>
          <label>語音辨識模型
            <select class="set-sel" :value="st.voice.cfg.stt_model" @change="act('voice-save', { stt_model: $event.target.value })" aria-label="語音辨識模型"><option v-for="m in STT_MODELS" :key="m" :value="m">{{ STT_MODEL_LABEL[m] }}</option></select>
          </label>
          <div class="av-btns"><asn-button @click="act('voice-install')" :disabled="st.voice.installBusy || st.voice.sttReady">下載語音辨識</asn-button></div>
          <small role="status">{{ st.voice.note }}</small>
        </div>
      </template>
      <template v-if="cat === 'cloud'">
        <cloud-invite-panel></cloud-invite-panel>
      </template>
      <template v-if="cat === 'accounts'">
        <div class="dv-set dv-acctpage">
          <section class="dv-my" v-if="st.myAccounts || st.quotaReaders" :aria-label="st.myAccounts ? st.myAccounts.title : QUOTA_TEXT.title">
              <h3 class="dv-my-h" v-if="st.myAccounts">{{ st.myAccounts.title }}</h3>
              <small v-if="st.myAccounts && st.myAccounts.empty">{{ st.myAccounts.empty }}</small>
              <div class="dv-my-v" v-for="v in vendorSections(st.myAccounts, st.quotaReaders)" :key="v.key" :data-vendor="v.key">
                <header class="dv-vh"><span class="dv-vicon" aria-hidden="true" v-html="vendorIcon(v.key)"></span><b>{{ v.label }}</b>
                  <!-- 額度開關（原本在「額度來源」大段與啟動設定的「額度回報」，行為不變、只換位置）：只管這台電腦 -->
                  <span class="dv-vtog" v-if="st.quotaReaders && v.key === 'grok'">
                    <label class="chk"><input type="checkbox" :checked="st.quotaReaders.grok" :disabled="st.quotaReaders.busy" @change="act('quota-source', { source: 'grok', on: $event.target.checked })" /><span>{{ QUOTA_TEXT.grok }}</span></label>
                  </span>
                  <span class="dv-vtog" v-if="v.key === 'claude' && st.quotaReaders && st.quotaReaders.extraDirs.length">
                    <label class="chk" v-if="st.quotaReaders && st.quotaReaders.extraDirs.length"><input type="checkbox" :checked="st.quotaReaders.extra" :disabled="st.quotaReaders.busy" @change="act('quota-source', { source: 'extra_claude', on: $event.target.checked })" /><span>{{ QUOTA_TEXT.extra }}</span></label>
                  </span>
                </header>
                <div class="dv-vq" v-if="st.quotaReaders && v.key === 'grok'">
                  <small>{{ QUOTA_TEXT.grokNote }}{{ QUOTA_TEXT.thisPc }}</small>
                  <small class="acct-warn" v-if="st.quotaReaders.grok && st.quotaReaders.status.grok">{{ st.quotaReaders.status.grok }}</small>
                </div>
                <div class="dv-vq" v-if="st.quotaReaders && v.key === 'gemini'">
                  <small>{{ QUOTA_TEXT.agyShort }}{{ QUOTA_TEXT.thisPc }}</small>
                  <small class="acct-warn" v-if="st.quotaReaders.agy && st.quotaReaders.status.agy">{{ st.quotaReaders.status.agy }}</small>
                  <details><summary>{{ QUOTA_TEXT.more }}</summary><small>{{ QUOTA_TEXT.agyNote }}</small></details>
                </div>
                <div class="dv-vq" v-if="v.key === 'claude' && st.quotaReaders && st.quotaReaders.extraDirs.length">
                  <small>{{ QUOTA_TEXT.extraShort }}{{ QUOTA_TEXT.extraDirs(st.quotaReaders.extraDirs.length) }}{{ QUOTA_TEXT.thisPc }}</small>
                  <template v-if="st.quotaReaders.extra">
                    <small class="acct-warn" v-for="d in st.quotaReaders.extraDirs.filter(x => x.status)" :key="d.name">{{ d.status }}</small>
                    <small v-if="st.quotaReaders.extraRefresh">{{ QUOTA_TEXT.refreshActive }}</small>
                    <!-- 要打開自動換新的確認當下，風險與服務條款要看得到；平常收在「說明」裡 -->
                    <template v-if="st.quotaReaders.confirm === 'refresh'">
                      <small class="acct-warn">{{ QUOTA_TEXT.refreshRisk }}</small>
                      <small class="acct-warn">{{ QUOTA_TEXT.refreshWarn }}</small>
                    </template>
                    <span class="dv-ibtns">
                      <asn-button :disabled="st.quotaReaders.busy" @click="act('quota-refresh', !st.quotaReaders.extraRefresh)">{{ st.quotaReaders.extraRefresh ? QUOTA_TEXT.refreshOff : st.quotaReaders.confirm === 'refresh' ? QUOTA_TEXT.refreshConfirm : QUOTA_TEXT.refreshOn }}</asn-button>
                    </span>
                    <details><summary>{{ QUOTA_TEXT.more }}</summary>
                      <small>{{ QUOTA_TEXT.extraNote }}</small>
                      <small>{{ QUOTA_TEXT.refreshNote }}</small>
                      <small>{{ QUOTA_TEXT.refreshRisk }}</small>
                      <small>{{ QUOTA_TEXT.refreshWarn }}</small>
                      <small>{{ QUOTA_TEXT.refreshStopped }}</small>
                    </details>
                  </template>
                </div>
                <div class="dv-vq" v-if="st.quotaReaders && v.key === 'minimax'">
                  <small v-if="!st.quotaReaders.minimaxSupported">{{ QUOTA_TEXT.minimaxUnsupported }}</small>
                  <template v-else>
                    <small>{{ QUOTA_TEXT.minimaxNote }}{{ QUOTA_TEXT.thisPc }}</small>
                    <ul class="dv-accts" v-if="st.quotaReaders.minimax.length">
                      <li class="dv-acct" v-for="m in st.quotaReaders.minimax" :key="m.email">
                        <span class="dv-mail">{{ m.email }}</span>
                        <span class="dv-side"><asn-button state="danger" :disabled="st.quotaReaders.busy" @click="act('quota-mm-remove', m.email)">{{ st.quotaReaders.confirm === 'minimax\\n' + m.email ? QUOTA_TEXT.minimaxConfirmRemove : QUOTA_TEXT.minimaxRemove }}</asn-button></span>
                        <small class="dv-why acct-warn" v-if="!m.hasKey">{{ QUOTA_TEXT.minimaxNoKey }}</small>
                        <small class="dv-why acct-warn" v-else-if="m.status">{{ m.status }}</small>
                      </li>
                    </ul>
                    <form class="dv-mm" v-if="st.quotaReaders.minimax.length < 2" @submit.prevent="addMinimax">
                      <input type="email" autocomplete="off" :placeholder="QUOTA_TEXT.minimaxEmail" :aria-label="QUOTA_TEXT.minimaxEmail" v-model="mmEmail" />
                      <input type="password" autocomplete="off" :placeholder="QUOTA_TEXT.minimaxKey" :aria-label="QUOTA_TEXT.minimaxKey" v-model="mmKey" />
                      <asn-button type="submit" :disabled="st.quotaReaders.busy">{{ QUOTA_TEXT.minimaxAdd }}</asn-button>
                    </form>
                  </template>
                </div>
                <ul class="dv-accts">
                  <li :class="['dv-acct', { cur: accountInUseOf(v.key, a) }]" v-for="a in v.accounts" :key="a.account">
                    <span class="dv-who"><span class="dv-mail">{{ a.account }}</span><span class="dv-age" v-if="a.quota.ageLabel">（{{ a.quota.ageLabel }}）</span></span>
                    <span class="dv-side">
                      <span class="dv-plan" v-if="a.plan">{{ planLabel(a.plan) }}</span>
                      <span class="dv-cur" v-if="accountInUseOf(v.key, a)">使用中</span>
                      <span class="dv-plan dv-shared" v-if="a.shared">{{ QUOTA_TEXT.shareOn }}</span>
                    </span>
                    <span class="dv-quota" :class="{ stale: a.quota.stale, out: a.quota.exhausted }">
                      <span class="dv-bars" v-if="a.quota.bars && a.quota.bars.length">
                        <span class="dv-bar" v-for="b in a.quota.bars" :key="b.key" :class="{ done: b.expired }">
                          <span class="dv-bl">{{ b.label }}</span>
                          <span class="dv-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="b.pct" :aria-label="b.label + '剩餘額度'"><span class="dv-fill" :class="{ low: b.low }" :style="{ width: (b.expired ? 0 : b.pct) + '%' }"></span></span>
                          <span class="dv-bp">{{ b.expired ? '' : '剩 ' + b.pct + '%' }}</span>
                          <span class="dv-br" v-if="b.reset">{{ b.reset }}</span>
                        </span>
                      </span>
                      <span v-else>{{ a.quota.text }}</span>
                      <span class="dv-old" v-if="a.quota.fiveNote">{{ a.quota.fiveNote }}</span>
                    </span>
                    <!-- 設備列：一台一列。左邊設備名（本機加「這台」），原因寫在設備名下方；右邊的鈕固定靠右、同一欄、同尺寸。
                         使用中＝深灰不能按；可切換＝「切換」；切換中＝淡色不能按；不能切換＝虛線淡色不能按＋原因。讀這筆額度的那台，設備名左邊有一條藍色粗線 -->
                    <span class="dv-devs" v-if="devRows(v.key, a).length" role="group" :aria-label="DEVICE_BUTTON_TEXT.group + ' ' + a.account">
                      <template v-for="b in devRows(v.key, a)" :key="b.node">
                      <span :class="['dv-devrow', { read: (a.quota.readNodes || []).includes(b.node) }]">
                        <span class="dv-devname"><span class="dv-devn">{{ b.label }}<small class="dv-devself" v-if="b.self">{{ DEVICE_ROW_TEXT.self }}</small></span><small class="dv-devwhy" v-if="b.reason" :id="'dv-why-' + v.key + '-' + a.account + '-' + b.node">{{ b.reason }}</small></span>
                        <asn-button fixed class="dv-devbtn" :state="b.state === 'switch' ? '' : b.state" :disabled="b.state !== 'switch' || busyNow" :aria-describedby="b.reason ? 'dv-why-' + v.key + '-' + a.account + '-' + b.node : null" @click="pressDev(v.key, a, b)">{{ DEVICE_ROW_TEXT[b.state] }}</asn-button>
                      </span>
                      <span :class="['dv-devres', rowResult(v.key, a, b.node).phase]" role="status" v-if="rowResult(v.key, a, b.node)">{{ rowResult(v.key, a, b.node).text }}</span>
                      </template>
                    </span>
                    <span class="dv-share" v-if="st.quotaReaders">
                      <asn-button :disabled="st.quotaReaders.busy" @click="act('quota-share', { vendor: v.key, account: a.account, shared: a.shared })">{{ !a.shared ? QUOTA_TEXT.share : st.quotaReaders.confirm === 'again\\n' + shareKey(v.key, a.account) ? QUOTA_TEXT.shareConfirmAgain : QUOTA_TEXT.shareAgain }}</asn-button>
                      <asn-button state="danger" v-if="a.shared" :disabled="st.quotaReaders.busy" @click="act('quota-unshare', { vendor: v.key, account: a.account })">{{ st.quotaReaders.confirm === 'revoke\\n' + shareKey(v.key, a.account) ? QUOTA_TEXT.shareConfirmRevoke : QUOTA_TEXT.shareRevoke }}</asn-button>
                      <small class="acct-warn" v-if="st.quotaReaders.confirm === 'again\\n' + shareKey(v.key, a.account)">{{ QUOTA_TEXT.shareAgainWarn }}</small>
                      <small class="acct-warn" v-if="st.quotaReaders.confirm === 'revoke\\n' + shareKey(v.key, a.account)">{{ QUOTA_TEXT.shareRevokeWarn }}</small>
                    </span>
                    <div class="dv-code" role="status" v-if="st.quotaReaders && st.quotaReaders.code && st.quotaReaders.code.key === shareKey(v.key, a.account)">
                      <b>{{ QUOTA_TEXT.codeTitle }}</b>
                      <code>{{ st.quotaReaders.code.value }}</code>
                      <small>{{ QUOTA_TEXT.codeOnce }}</small>
                      <span class="dv-ibtns">
                        <asn-button level="text" @click="act('quota-copy')">{{ st.quotaReaders.copied ? QUOTA_TEXT.copied : QUOTA_TEXT.copy }}</asn-button>
                        <asn-button level="text" @click="act('quota-close')">{{ QUOTA_TEXT.close }}</asn-button>
                      </span>
                    </div>
                  </li>
                </ul>
              </div>
              <small role="status" v-if="st.quotaReaders && st.quotaReaders.msg">{{ st.quotaReaders.msg }}</small>
            </section>
          <small class="dv-none" v-else>{{ ROSTER_TEXT.noList }}</small>
        </div>
      </template>
      <template v-if="cat === 'devices'">
        <div class="dv-set">
          <template v-if="!curDev">
            <small v-if="!devs.length">{{ DEVICE_TEXT.empty }}</small>
            <ul class="dv-list" aria-label="設備" v-else>
              <li v-for="d in devs" :key="d.key" :data-dev="d.key" :class="['dv-row', { hid: d.hidden, off: !d.online, dragging: dragKey === d.key, 'drop-before': overKey === d.key && !overAfter, 'drop-after': overKey === d.key && overAfter }]" :draggable="!d.self" @dragstart="dragStart(d.key, $event)" @dragover="dragOver(d.key, $event)" @drop="drop(d.key, $event)" @dragend="clearDrag">
                <span class="dv-row-go"><span class="dv-name">{{ d.label }}</span><span class="dv-tag kind" v-if="(d.kindLabel || d.kind) !== '電腦'">{{ d.kindLabel || d.kind }}</span><span :class="['dv-tag', d.online ? 'on' : 'off']">{{ d.onlineText }}</span><span class="dv-tag me" v-if="d.self">這台</span><span class="dv-tag hid" v-if="d.hidden">{{ DEVICE_TEXT.hiddenTag }}</span><span class="dv-tag warn noreport" v-if="d.noReport" :title="DEVICE_TEXT.noReportTip" :aria-label="DEVICE_TEXT.noReportTip">{{ DEVICE_TEXT.noReportTag }}</span><fp-mark v-if="d.phone && !d.self" :kind="deskFpMark(joined.byNode[d.key], joined.byNode[d.key] && shortFp(joined.byNode[d.key].fingerprint)).kind" :label="deskFpMark(joined.byNode[d.key], joined.byNode[d.key] && shortFp(joined.byNode[d.key].fingerprint)).label"></fp-mark></span>
                <span class="dv-row-move" v-if="!d.self" role="group" aria-label="設備順序">
                  <asn-button :disabled="!flags[d.key].up" :aria-label="'上移 ' + d.label" @click.stop="act('device-move', { node: d.key, dir: -1 })">{{ DEVICE_TEXT.moveUp }}</asn-button>
                  <asn-button :disabled="!flags[d.key].down" :aria-label="'下移 ' + d.label" @click.stop="act('device-move', { node: d.key, dir: 1 })">{{ DEVICE_TEXT.moveDown }}</asn-button>
                </span>
                <span class="dv-row-move dv-row-act" role="group" aria-label="設備內容">
                  <asn-button :aria-label="'查看 ' + d.label + ' 的帳號'" @click.stop="open(d.key)">帳號</asn-button>
                  <asn-button :aria-label="'查看 ' + d.label + ' 的詳情'" @click.stop="openInfo(d.key)">詳情</asn-button>
                </span>
              </li>
            </ul>
            <details class="dv-old-rec" v-if="oldPeers.length">
              <summary>舊設備紀錄（{{ oldPeers.length }}）</summary>
              <div class="pair-row" v-for="p in oldPeers" :key="p.id">
                <p><b>{{ p.label }}</b> <span v-if="p.firstSeen">{{ KNOWN.firstSeen(p.firstSeen) }}</span></p>
                <code class="pair-fp" :aria-label="KNOWN.fingerprint">{{ groupFp(p.fingerprint) }}</code>
                <span class="pair-btns"><asn-button state="danger" :disabled="st.known.busy" @click="forget.ask(p)">忘記</asn-button></span>
              </div>
            </details>
          </template>
          <section class="dv-dev" v-else :aria-label="curDev.identity.title">
            <div class="dv-dev-h">
              <asn-button class="dv-back" :aria-label="DEVICE_TEXT.back" :title="DEVICE_TEXT.back" @click="backToList">{{ DEVICE_TEXT.backMark }}</asn-button>
              <h3 class="dv-name">{{ curDev.identity.title }}</h3>
              <span class="dv-tag kind" v-if="(curDev.kindLabel || curDev.kind) !== '電腦'">{{ curDev.kindLabel || curDev.kind }}</span>
              <span :class="['dv-tag', curDev.online ? 'on' : 'off']">{{ curDev.onlineText }}</span>
              <span class="dv-tag me" v-if="curDev.self">這台</span>
              <span class="dv-tag off" v-if="curDev.hidden">{{ DEVICE_TEXT.hiddenTag }}</span>
            </div>
            <div class="dv-tabs" role="group" aria-label="這台設備的內容">
              <asn-button class="dv-tasks" v-if="curDev.self && st.taskMgr" :aria-pressed="view === 'tasks'" @click="setView('tasks')">{{ TM.entry }}</asn-button>
              <asn-button :aria-pressed="view === 'info'" @click="setView('info')">詳情</asn-button>
              <asn-button v-if="curDev.self && st.known && st.known.ownFp" :aria-pressed="view === 'qr'" @click="setView('qr')">QR Code</asn-button>
              <asn-button v-if="hasAcct" :aria-pressed="view === 'acct'" @click="setView('acct')">帳號</asn-button>
            </div>
            <div class="tm" v-if="view === 'tasks' && st.taskMgr">
              <div class="tm-bar">
                <b class="tm-sum">這台電腦上 ASN 管的程式共 {{ st.taskMgr.total }} 個</b>
                <span class="tm-tag dup" v-if="st.taskMgr.dupCount">{{ st.taskMgr.dupCount }} 組名字重複</span>
                <span class="tm-auto">{{ TM.auto }}</span>
              </div>
              <p class="tm-warn" v-if="st.taskMgr.dupBanner" role="alert">{{ st.taskMgr.dupBanner }}</p>
              <p class="tm-err" v-if="st.taskMgr.error" role="alert">{{ st.taskMgr.error }}</p>
              <small v-if="!st.taskMgr.loaded && !st.taskMgr.error">{{ TM.refreshing }}</small>
              <small v-if="st.taskMgr.empty">{{ TM.empty }}</small>
              <div class="tm-scroll" v-if="st.taskMgr.rows.length">
                <table class="tm-table">
                  <thead><tr><th v-for="c in TM_COLUMNS" :key="c" scope="col">{{ c }}</th></tr></thead>
                  <tbody>
                    <tr v-for="r in st.taskMgr.rows" :key="r.key" :class="{ dup: r.dup, view: r.viewOnly }" :data-kind="r.kind">
                      <td class="tm-name"><b>{{ r.name }}</b><span class="tm-tag dup" v-if="r.dup">{{ TM.dupTag }}</span><small class="tm-dupnote" v-if="r.dupNote">{{ r.dupNote }}</small><small class="tm-where"><span class="tm-tag native" v-if="r.native">{{ r.source }}</span><template v-else>{{ r.source }}</template></small></td>
                      <td>{{ r.engine }}</td><td>{{ r.pid }}</td><td>{{ r.memory }}</td><td>{{ r.uptime }}</td><td>{{ r.status }}</td><td class="cmp">{{ r.cmpText }}<template v-if="r.cmpTag"> <span class="tm-tag" :class="r.cmpState === 'handing' ? 'cmp-go' : 'cmp-warn'">{{ r.cmpTag }}</span></template></td><td><span class="tm-tag native" v-if="r.native">{{ r.source }}</span><template v-else>{{ r.source }}</template></td>
                      <td class="tm-act">
                        <asn-button state="danger" class="tm-stop" v-if="!r.viewOnly && !r.handing" :disabled="!r.canStop || st.taskMgr.busy" :title="r.why" :aria-label="TM.stop + ' ' + r.name" @click="act('tm-ask', r.key)">{{ TM.stop }}</asn-button>
                        <small class="tm-viewonly" v-else-if="r.showViewOnly" :title="r.why">{{ TM.viewOnly }}</small>
                        <small class="tm-why" v-if="!r.viewOnly && !r.canStop && r.why">{{ r.why }}</small>
                        <asn-button class="tm-handover" v-if="r.canHandover" :disabled="st.taskMgr.busy" :title="TM.handoverTip" :aria-label="TM.handover + ' ' + r.name" @click="act('tm-handover', r.name)">{{ TM.handover }}</asn-button>
                        <asn-button class="tm-view-btn" v-if="r.canView" :disabled="st.taskMgr.busy" :title="TM.viewTip" :aria-label="TM.view + ' ' + r.name" @click="act('tm-view', r.name)">{{ TM.view }}</asn-button>
                        <asn-button class="tm-adopt" v-if="r.canAdopt" :disabled="st.taskMgr.busy" :title="TM.adoptTip" :aria-label="TM.adopt + ' ' + r.name" @click="act('tm-adopt', r.key)">{{ TM.adopt }}</asn-button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p class="tm-line" v-if="st.taskMgr.note" role="status">{{ st.taskMgr.note }}</p>
              <details class="tm-known" v-if="st.taskMgr.known.length">
                <summary>認得但目前沒在跑（{{ st.taskMgr.known.length }}）</summary>
                <ul>
                  <li v-for="k in st.taskMgr.known" :key="k.name"><span class="tm-kname">{{ k.name }}</span><small>{{ k.engine }}</small><asn-button v-if="k.canWake" :disabled="st.taskMgr.busy" @click="act('tm-wake', k.name)">{{ TM.wake }}</asn-button><small v-else-if="k.why">{{ k.why }}</small></li>
                </ul>
                <small>重開機後會自動接回的名字；要接回請按「喚醒」，不在這裡停止。</small>
              </details>
              <p class="tm-line" v-if="st.taskMgr.wakeNote" role="status">{{ st.taskMgr.wakeNote }}</p>
              <small class="tm-hint" v-for="h in st.taskMgr.hints" :key="h">{{ h }}</small>
              <asn-dialog v-if="st.taskMgr.confirm" :title="st.taskMgr.confirm.title" @close="act('tm-cancel')">
                <div class="tm-facts"><p v-for="l in st.taskMgr.confirm.lines" :key="l">{{ l }}</p></div>
                <p class="launch-notice-body" v-for="n in st.taskMgr.confirm.notes" :key="n">{{ n }}</p>
                <p class="partner-err" v-if="st.taskMgr.confirm.result" role="alert">{{ st.taskMgr.confirm.result }}</p>
                <asn-actions class="partner-actions">
                  <asn-button :disabled="st.taskMgr.confirm.busy" @click="act('tm-cancel')">{{ TM.cancel }}</asn-button>
                  <asn-button state="danger" class="tm-confirm" :disabled="st.taskMgr.confirm.busy" @click="act('tm-confirm')">{{ st.taskMgr.confirm.busy ? TM.stopping : st.taskMgr.confirm.ok }}</asn-button>
                </asn-actions>
              </asn-dialog>
            </div>
            <div class="dv-cards" v-else-if="view === 'qr' && curDev.self && st.known && st.known.ownFp">
              <div class="set-card">
                <h3 class="set-h">QR Code</h3>
                <div class="dv-qr">
                  <fp-qr-canvas v-if="st.known.qr" :qr="st.known.qr"></fp-qr-canvas>
                  <div><p class="dv-qr-fp">{{ KNOWN.ownFp(st.known.ownFp) }}</p><small>{{ QR_TEXT.note }}</small></div>
                </div>
                <p class="pair-warn" v-if="st.known.error" role="alert">{{ st.known.error }}</p>
              </div>
            </div>
            <div class="dv-cards" v-else-if="view === 'info'">
              <div class="set-card">
                <h3 class="set-h">{{ IDENTITY_TEXT.title }}</h3>
                <small class="pair-warn" v-if="st.known && st.known.renameError" role="alert">{{ st.known.renameError }}</small>
                <device-identity :identity="curDev.identity" :note="curDev.noReport ? curDev.stateLine : ''"></device-identity>
              </div>
              <div class="set-card" v-if="deviceFp">
                <h3 class="set-h">連線安全</h3>
                <dl class="dv-kv">
                  <dt>{{ KNOWN.fingerprint }}</dt>
                  <dd><code class="pair-fp" :aria-label="KNOWN.fingerprint">{{ deviceFp }}</code></dd>
                  <template v-if="curKnown && curKnown.firstSeen"><dt>第一次連線</dt><dd>{{ curKnown.firstSeen }}</dd></template>
                </dl>
              </div>
              <div class="set-card" v-if="curKnown && (curDev.phone || curKnown.loginOk)">
                <h3 class="set-h">信任</h3>
                <template v-if="curDev.phone || curKnown.loginOk">
                  <label class="chk"><input type="checkbox" :checked="curKnown.loginOk" :disabled="st.known.busy" @change="act('known-login-ok', { node: curKnown.id, on: $event.target.checked }); $event.target.checked = curKnown.loginOk" :aria-label="KNOWN.loginOk" /><span>{{ KNOWN.loginOk }}</span></label>
                  <small v-if="curKnown.loginOk" class="pair-warn">{{ KNOWN.loginOkWarn }}</small>
                </template>
              </div>
              <div class="set-card dvid-actions">
                <h3 class="set-h">{{ ACTION_TEXT.title }}</h3>
                <form class="dv-rename" v-if="renaming" @submit.prevent="renameSave">
                  <input type="text" :maxlength="NAME_MAX" autocomplete="off" v-model="renameText" aria-label="這台設備的名字" />
                  <small>所有設備都會顯示這個名字</small>
                  <small class="pair-warn" v-if="renameErr" role="alert">{{ renameErr }}</small>
                  <asn-actions class="dv-card-act"><asn-button @click="renameCancel">取消</asn-button><asn-button level="primary" type="submit" :disabled="!!deviceNameError(renameText) || (st.known && st.known.busy)">儲存</asn-button></asn-actions>
                </form>
                <div class="dv-card-act" v-else>
                  <asn-button @click="renameStart">{{ ACTION_TEXT.rename }}</asn-button>
                  <template v-if="!curDev.self">
                    <asn-button v-if="canShowBackRow(curDev) && !askRemove" @click="act('device-show', curDev.key)">{{ DEVICE_TEXT.showBack }}</asn-button>
                    <asn-button state="danger" v-if="!askRemove" :disabled="!canRemoveRow(curDev)" @click="askRemove = true">{{ DEVICE_TEXT.remove }}</asn-button>
                  </template>
                  <asn-button state="danger" v-if="curKnown" :disabled="st.known.busy" @click="forget.ask(curKnown)">{{ KNOWN.forget }}</asn-button>
                </div>
                <small class="dvid-why" v-if="!curDev.self && !canRemoveRow(curDev)">{{ ACTION_TEXT.removeOnline }}</small>
                <asn-confirm v-if="askRemove" danger :text="DEVICE_TEXT.confirmRemove(curDev.identity.title)" :yes="DEVICE_TEXT.removeYes" :no="DEVICE_TEXT.cancel" @yes="removeNow" @no="askRemove = false"></asn-confirm>
                <small v-if="curKnown">{{ KNOWN.forgetNote }}</small>
                <p class="pair-warn" v-if="st.known && st.known.error" role="alert">{{ st.known.error }}</p>
              </div>
            </div>
            <div :class="['dv-body', { off: !curDev.online }]" v-else>
              <div class="dv-empty" v-if="!curVendors.length"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h13v9H3zM1 18h17M19 8h3v11h-3z"></path></svg><span>{{ curDev.empty || '這台設備還沒有回報任何廠商' }}</span></div>
              <ul class="dv-vendors" v-else>
                <li :class="['dv-vendor', 'v-' + v.key]" v-for="v in curVendors" :key="v.key">
                  <header class="dv-vh"><span class="dv-vicon" aria-hidden="true" v-html="vendorIcon(v.iconKey || v.key)"></span><b>{{ v.label }}</b><small class="dv-via" v-if="v.via">經 {{ v.via }}</small><small :class="['dv-state', 'st-' + v.state]" v-if="v.stateText">{{ v.stateText }}</small></header>
                  <div class="dv-vb">
                    <template v-if="curDev.self && v.key === 'claude'">
                      <ul class="dv-accts" v-if="st.accounts.list.length">
                        <li :class="['dv-acct', { cur: a.current }]" v-for="a in st.accounts.list" :key="a.email">
                          <span class="dv-mail">{{ a.email }}</span>
                          <span class="dv-side">
                            <span class="dv-plan" v-if="a.plan">{{ planLabel(a.plan) }}</span>
                            <span class="dv-cur" v-if="a.current">使用中</span>
                            <span class="dv-incomplete" v-if="isIncomplete(a)">{{ INCOMPLETE_LABEL }}</span>
                            <asn-button @click="act('acct-switch', a.email)" :disabled="st.accounts.busy || a.current || isIncomplete(a)" :title="isIncomplete(a) ? INCOMPLETE_REASON : null">切換</asn-button>
                            <asn-button state="danger" @click="act('acct-remove', a.email)" :disabled="st.accounts.busy">{{ st.accounts.confirmDel === a.email ? '確認刪除' : '刪除' }}</asn-button>
                          </span>
                          <small class="dv-why acct-warn" v-if="isIncomplete(a) && !a.current">{{ INCOMPLETE_REASON }}</small>
                          <small class="dv-why dv-usable" v-if="usableAt(a)">{{ usableAt(a) }}</small>
                          <span class="dv-quota" :class="{ stale: a.quota.stale, out: a.quota.exhausted }" v-if="a.quota">
                            <span class="dv-bars" v-if="a.quota.bars && a.quota.bars.length">
                              <span class="dv-bar" v-for="b in a.quota.bars" :key="b.key" :class="{ done: b.expired }">
                                <span class="dv-bl">{{ b.label }}</span>
                                <span class="dv-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="b.pct" :aria-label="b.label + '剩餘額度'"><span class="dv-fill" :class="{ low: b.low }" :style="{ width: (b.expired ? 0 : b.pct) + '%' }"></span></span>
                                <span class="dv-bp">{{ b.expired ? '' : '剩 ' + b.pct + '%' }}</span>
                                <span class="dv-br" v-if="b.reset">{{ b.reset }}</span>
                              </span>
                            </span>
                            <span v-else>{{ a.quota.text }}</span>
                            <span v-if="a.quota.meta">（{{ a.quota.meta }}）</span>
                          </span>
                        </li>
                      </ul>
                      <div class="dv-none" v-else>還沒有加入過帳號。</div>
                      <small v-if="st.accounts.current && !st.accounts.current.saved" class="acct-warn">目前登入的 {{ st.accounts.current.email }} 還沒加入帳號庫，ASN 會在一分鐘內自動加入，加入後才能切換到別的帳號。</small>
                      <small v-else-if="st.accounts.currentErr" class="acct-warn" role="status">{{ st.accounts.currentErr }}。請確認 Claude 是否還登入著，或稍後再看。</small>
                      <small v-else-if="!st.accounts.current">這台電腦目前沒有 Claude 登入。</small>
                      <small v-if="st.accounts.autoNote" role="status">{{ st.accounts.autoNote }}</small>
                      <small role="status">{{ st.accounts.msg }}</small>
                      <small v-if="modLine(st.accounts.mod)" role="status">{{ modLine(st.accounts.mod) }}</small>
                      <label class="chk"><input type="checkbox" :checked="st.accounts.allowSwitch" @change="act('acct-allow-switch', $event.target.checked)" /><span>允許切換帳號</span></label>
                      <small>讓手機或別台設備替這台切換帳號。</small>
                      <div class="dv-install" v-if="AGENT_INSTALL_UI && st.install && ((v.action && v.action.kind === 'local') || st.install.stage === 'running' || st.install.stage === 'done')">
                        <template v-if="st.install.stage === 'idle'">
                          <asn-button level="primary" :disabled="st.install.button.disabled" @click="act('install-ask')">{{ INSTALL_TEXT.button }}</asn-button>
                          <small class="acct-warn" v-if="st.install.button.hint">{{ st.install.button.hint }}</small>
                          <small v-if="st.install.msg" role="status">{{ st.install.msg }}</small>
                        </template>
                        <div class="dv-confirm" role="alertdialog" :aria-label="INSTALL_TEXT.confirmTitle" v-else-if="st.install.stage === 'confirm'">
                          <b>{{ INSTALL_TEXT.confirmTitle }}</b>
                          <p>{{ st.install.plan }}</p>
                          <asn-actions class="dv-ibtns">
                            <asn-button @click="act('install-no')">{{ INSTALL_TEXT.confirmNo }}</asn-button>
                            <asn-button level="primary" @click="act('install-yes')">{{ INSTALL_TEXT.confirmYes }}</asn-button>
                          </asn-actions>
                        </div>
                        <div class="dv-prog" role="status" aria-live="polite" v-else>
                          <b :class="['dv-ptitle', st.install.kind]">{{ st.install.title }}</b>
                          <p v-for="(l, i) in st.install.lines" :key="i" :class="{ note: i > 0 }">{{ l }}</p>
                          <small v-if="st.install.stage === 'running'">{{ INSTALL_TEXT.progressNote }}</small>
                          <span class="dv-ibtns">
                            <asn-button v-if="st.install.stage === 'running'" :disabled="!st.install.canCancel" @click="act('install-cancel')">{{ INSTALL_TEXT.cancel }}</asn-button>
                            <asn-button v-if="st.install.stage === 'done' && st.install.terminal" @click="act('install-terminal')">{{ INSTALL_TEXT.openTerminal }}</asn-button>
                            <asn-button v-if="st.install.stage === 'done'" @click="act('install-close')">{{ INSTALL_TEXT.close }}</asn-button>
                          </span>
                        </div>
                      </div>
                      <label class="chk" v-if="AGENT_INSTALL_UI && st.install"><input type="checkbox" :checked="st.install.remoteAllow" @change="act('install-allow', $event.target.checked)" /><span>{{ INSTALL_TEXT.allowRemote }}</span></label>
                      <small v-if="AGENT_INSTALL_UI && st.install">{{ INSTALL_TEXT.allowRemoteNote }}</small>
                    </template>
                    <template v-else>
                      <ul class="dv-accts" v-if="v.accounts.length">
                        <li :class="['dv-acct', { cur: a.current }]" v-for="a in v.accounts" :key="a.email">
                          <span class="dv-mail">{{ a.email }}</span>
                          <span class="dv-side">
                            <span class="dv-plan" v-if="a.plan">{{ planLabel(a.plan) }}</span>
                            <span class="dv-incomplete" v-if="!a.current && a.incomplete">{{ INCOMPLETE_LABEL }}</span>
                            <span class="dv-cur" v-if="a.current">使用中</span>
                            <asn-button v-else-if="(v.key === 'claude' || v.key === 'grok') && !curDev.self && (v.switchable || v.switchHint)" :disabled="!v.switchable || a.incomplete" :title="a.incomplete ? INCOMPLETE_REASON : null" @click="act('device-switch', { node: curDev.key, email: a.email, vendor: v.key })">切換</asn-button>
                            <asn-button v-else-if="v.key === 'grok' && curDev.self && v.accounts.length > 1" :disabled="st.accounts.busy" @click="act('grok-switch', a.email)">切換</asn-button>
                          </span>
                          <small class="dv-why acct-warn" v-if="a.incomplete && !a.current">{{ INCOMPLETE_REASON }}</small>
                          <span class="dv-quota" :class="{ stale: a.quota.stale, out: a.quota.exhausted }" v-if="a.quota">
                            <span class="dv-bars" v-if="a.quota.bars && a.quota.bars.length">
                              <span class="dv-bar" v-for="b in a.quota.bars" :key="b.key" :class="{ done: b.expired }">
                                <span class="dv-bl">{{ b.label }}</span>
                                <span class="dv-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="b.pct" :aria-label="b.label + '剩餘額度'"><span class="dv-fill" :class="{ low: b.low }" :style="{ width: (b.expired ? 0 : b.pct) + '%' }"></span></span>
                                <span class="dv-bp">{{ b.expired ? '' : '剩 ' + b.pct + '%' }}</span>
                                <span class="dv-br" v-if="b.reset">{{ b.reset }}</span>
                              </span>
                            </span>
                            <span v-else>{{ a.quota.text }}</span>
                            <span class="dv-old" v-if="a.quota.fiveNote">{{ a.quota.fiveNote }}</span>
                            <span v-if="a.quota.meta">（{{ a.quota.meta }}）</span>
                          </span>
                          <span class="dv-quota stale" v-else-if="v.key === 'codex' || v.key === 'grok'">{{ NO_QUOTA_TEXT }}</span>
                        </li>
                      </ul>
                      <div class="dv-none" v-else><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v4M12 16h.01"></path></svg>{{ v.note || '目前未回報任何帳號' }}</div>
                      <small v-if="v.switchHint">{{ v.switchHint }}</small>
                    </template>
                    <div class="dv-install dv-relogin" v-if="v.key === 'claude' && st.relogin && ((v.relogin && v.relogin.kind) || (st.relogin.target === curDev.key && st.relogin.stage !== 'idle'))">
                      <template v-if="st.relogin.target !== curDev.key || st.relogin.stage === 'idle'">
                        <asn-button state="relogin" @click="act('relogin-ask', { node: curDev.key, kind: v.relogin.kind })">{{ DESK_RELOGIN_TEXT.button }}</asn-button>
                      </template>
                      <div class="dv-confirm" role="alertdialog" :aria-label="st.relogin.kind === 'local' ? DESK_RELOGIN_TEXT.localTitle : DESK_RELOGIN_TEXT.remoteTitle(curDev.label)" v-else-if="st.relogin.stage === 'confirm'">
                        <b>{{ st.relogin.kind === 'local' ? DESK_RELOGIN_TEXT.localTitle : DESK_RELOGIN_TEXT.remoteTitle(curDev.label) }}</b>
                        <p>{{ st.relogin.kind === 'local' ? DESK_RELOGIN_TEXT.localBody : DESK_RELOGIN_TEXT.remoteBody }}</p>
                        <small v-if="st.relogin.kind !== 'local'">{{ DESK_RELOGIN_TEXT.remoteNeed }}</small>
                        <asn-actions class="dv-ibtns">
                          <asn-button @click="act('relogin-no')">{{ DESK_RELOGIN_TEXT.no }}</asn-button>
                          <asn-button level="primary" @click="act('relogin-yes')">{{ st.relogin.kind === 'local' ? DESK_RELOGIN_TEXT.localYes : DESK_RELOGIN_TEXT.remoteYes }}</asn-button>
                        </asn-actions>
                      </div>
                      <div class="dv-prog" :role="st.relogin.stage === 'done' && !st.relogin.ok ? 'alert' : 'status'" aria-live="polite" v-else>
                        <p v-if="st.relogin.lead">{{ st.relogin.lead }}</p>
                        <p>{{ st.relogin.text }}</p>
                        <p class="note" v-if="st.relogin.note">{{ st.relogin.note }}</p>
                        <span class="dv-ibtns" v-if="st.relogin.stage === 'done'">
                          <asn-button @click="act('relogin-close')">{{ DESK_RELOGIN_TEXT.close }}</asn-button>
                        </span>
                      </div>
                    </div>
                  </div>
                </li>
              </ul>
            </div>
          </section>
        </div>
      </template>
      <template v-if="catKey === 'look'">
        <!-- 外觀（0.2.18）：復古 Aero／現代，0.2.22 起加 LINE 風格（三選一），兩套是同一份畫面，只換樣式與圖示；切換馬上生效、不用重開 -->
        <fieldset class="skin-pick" aria-label="外觀">
          <legend>外觀</legend>
          <label v-for="k in SKINS" :key="k" class="skin-opt" :class="{ on: (st.skin || 'aero') === k }">
            <span class="skin-mini" :class="'skin-mini-' + k" aria-hidden="true"><i></i><b></b></span>
            <span class="chk"><input type="radio" name="skin" :value="k" :checked="(st.skin || 'aero') === k" @change="act('skin', k)" /><span>{{ SKIN_LABEL[k] }}</span></span>
          </label>
        </fieldset>
        <label>視窗外框
          <select class="set-sel" :value="st.frame" @change="act('frame', $event.target.value)" aria-label="視窗外框"><option v-for="f in FRAMES" :key="f" :value="f">{{ FRAME_LABEL[f] }}</option></select>
        </label>
        <label>視窗模式
          <select class="set-sel" :value="st.mode" @change="act('mode', $event.target.value)" aria-label="視窗模式"><option v-for="m in MODES" :key="m" :value="m">{{ MODE_LABEL[m] }}</option></select>
        </label>
        <label v-if="lookShows(st.skin, 'dpMode')">頭像模式
          <select class="set-sel" :value="st.dpMode" @change="act('dpMode', $event.target.value)" aria-label="頭像模式"><option v-for="m in DP_MODES" :key="m" :value="m">{{ DP_LABEL[m] }}</option></select>
        </label>
        <label v-if="lookShows(st.skin, 'toolbar')">工具列位置
          <select class="set-sel" :value="st.toolbar" @change="act('toolbar', $event.target.value)" aria-label="工具列位置"><option v-for="b in TOOLBARS" :key="b" :value="b">{{ TOOLBAR_LABEL[b] }}</option></select>
        </label>
        <label v-if="lookShows(st.skin, 'bubble')">文字底色
          <select class="set-sel" :value="st.bubble" @change="act('bubble', $event.target.value)" aria-label="文字底色"><option v-for="b in BUBBLES" :key="b" :value="b">{{ BUBBLE_LABEL[b] }}</option></select>
        </label>
        <label v-if="lookShows(st.skin, 'tabDim')">分頁依
          <select class="set-sel" :value="st.tabDim" @change="act('tabDim', $event.target.value)" aria-label="分頁依"><option v-for="d in DIMS" :key="d.key" :value="d.key">{{ d.label }}</option></select>
        </label>
        <label>分組依
          <select class="set-sel" :value="st.groupDim" @change="act('groupDim', $event.target.value)" aria-label="分組依"><option v-for="d in groupOptions(st.tabDim)" :key="d.key" :value="d.key">{{ d.label }}</option></select>
        </label>
        <label class="chk"><input type="checkbox" :checked="st.ghRefs === true" @change="act('gh-refs', $event.target.checked)" :aria-label="GH_REFS_LABEL" /><span>{{ GH_REFS_LABEL }}</span></label>
        <small class="set-note">{{ GH_REFS_NOTE }}</small>
      </template>
      <template v-if="catKey === 'window'">
        <label>關閉視窗時
          <select class="set-sel" :value="st.closeTo" @change="act('closeTo', $event.target.value)" aria-label="關閉視窗時"><option v-for="c in CLOSE_CHOICES" :key="c" :value="c">{{ CLOSE_LABEL[c] }}</option></select>
        </label>
        <small v-if="!st.trayOk">這台電腦建不起系統匣圖示，關閉視窗一律結束程式。</small>
        <label class="chk" v-if="st.autostart.supported"><input type="checkbox" :checked="st.autostart.on" :disabled="st.autostart.busy || (!!st.autostart.blocked && !st.autostart.on)" @change="act('autostart', $event.target.checked)" aria-label="登入時自動啟動 ASN" /><span>登入時自動啟動 ASN</span></label>
        <small v-if="st.autostart.supported && st.autostart.blocked" class="autostart-blocked">{{ st.autostart.blocked }}</small>
        <template v-if="st.guard && st.guard.supported">
          <label class="chk"><input type="checkbox" :checked="st.guard.on" :disabled="st.guard.busy || (!!st.guard.blocked && !st.guard.on)" @change="act('guard', $event.target.checked)" aria-label="ASN 意外關閉時自動重新開啟" /><span>ASN 意外關閉時自動重新開啟</span></label>
          <small>只在 ASN 意外關閉時重開，你自己按結束不會重開。</small>
          <small v-if="st.guard.blocked" class="autostart-blocked">{{ st.guard.blocked }}</small>
          <small v-if="st.guard.paused" class="guard-paused" role="status">{{ st.guard.paused }} <asn-button :disabled="st.guard.busy" @click="act('guard-resume')">恢復自動重開</asn-button></small>
        </template>
        <section class="set-card" aria-label="收發信功能" v-if="st.bridge">
          <label class="chk"><input type="checkbox" :checked="st.bridge.remoteLaunch" :disabled="st.bridge.busy" @change="act('bridge-launch', $event.target.checked)" aria-label="允許我的其他設備替這台開新視窗" /><span>允許我的其他設備替這台開新視窗</span></label>
          <small>新裝的電腦預設打開：你自己的其他設備（手機、別台電腦）可以替這台開新視窗。</small>
          <label class="chk"><input type="checkbox" :checked="st.bridge.autoResume" :disabled="st.bridge.busy" @change="act('bridge-auto-resume', $event.target.checked)" aria-label="電腦重開後自動接回夥伴" /><span>電腦重開後自動接回夥伴</span></label>
          <small>重開前還開著、由 ASN 開的夥伴，登入 Windows 後會接回原本的對話。權限和原本相同，收到信就會繼續工作，也會用到額度。關掉就要自己按「喚醒」。</small>
          <label class="chk chk-num"><input type="checkbox" :checked="st.bridge.compactHandoff" :disabled="st.bridge.busy" @change="act('bridge-compact', $event.target.checked)" aria-label="壓縮自動交接" /><span>壓縮</span><input class="set-input num" type="number" min="2" max="10" :value="st.bridge.compactN" :disabled="st.bridge.busy" @change="act('bridge-compact-n', Number($event.target.value))" aria-label="壓縮幾次" /><span>次自動交接</span></label>
          <small>Claude 視窗壓縮到這個次數時，額度夠就自動交給新視窗。取消勾選就只寄信提醒，不會自動交接。</small>
          <template v-if="st.bridge.termServerSupported">
            <label class="chk"><input type="checkbox" :checked="st.bridge.termServer" :disabled="st.bridge.busy || st.bridge.termServerLocked" @change="act('bridge-term-server', $event.target.checked)" aria-label="夥伴共用同一個終端服務" /><span>夥伴共用同一個終端服務</span></label>
            <small>{{ termServerNote(st.bridge) }}</small>
            <small v-if="termServerWhyLine(st.bridge)" class="term-server-why" role="note">{{ termServerWhyLine(st.bridge) }}</small>
            <template v-if="termFetchLine(st.bridge).text">
              <small role="status">{{ termFetchLine(st.bridge).text }}</small>
              <span class="pair-btns" v-if="termFetchLine(st.bridge).canRetry"><asn-button level="text" :disabled="st.bridge.busy" @click="act('bridge-term-fetch-retry')">重試</asn-button></span>
            </template>
          </template>
          <small v-else-if="st.bridge.termServerMissing">{{ TERM_SERVER_MISSING_NOTE }}</small>
          <small v-if="keyProtectionNote(st.bridge.keyProtection)" role="note">{{ keyProtectionNote(st.bridge.keyProtection) }}</small>
          <label class="chk"><input type="checkbox" :checked="st.bridge.screenWatch" :disabled="st.bridge.busy" @change="act('bridge-screen-watch', $event.target.checked)" aria-label="夥伴卡住時跳提示" /><span>夥伴卡住時跳提示</span></label>
          <small>ASN 會定時看夥伴視窗的畫面，停在要你回答的地方時，在這台電腦跳提示；權限詢問可以直接按允許或拒絕。其他提示在別的設備只看得到「等你回答：權限」這類固定字。目前只支援 Windows 上由 ASN 開的 Claude 夥伴。</small>
          <label class="chk"><input type="checkbox" :checked="st.bridge.permPhone" :disabled="st.bridge.busy" @change="act('bridge-perm-phone', $event.target.checked)" aria-label="權限框傳到手機" /><span>權限框傳到手機</span></label>
          <small>手機開著 ASN 時會跳出權限框，可以直接在手機上回答。權限框的內容和選項會經過 ASN 的伺服器、只傳給你登入的設備，回答或過期後就清掉；裡面可能有指令或路徑。關掉就只在這台電腦上問你。</small>
          <label class="chk"><input type="checkbox" :checked="st.bridge.mobileView" :disabled="st.bridge.busy" @change="act('bridge-mobile-view', $event.target.checked)" aria-label="允許移動設備查看終端" /><span>允許移動設備查看終端</span></label>
          <small>關掉後，手機就不能看這台電腦上夥伴的終端。</small>
          <label class="chk"><input type="checkbox" :checked="st.bridge.remoteInput" :disabled="st.bridge.busy" @change="act('bridge-remote-input', $event.target.checked)" aria-label="允許遠端在這台打字" /><span>允許遠端在這台打字</span></label>
          <small>你登入的其他設備可以直接在這台電腦的夥伴視窗打字，不會再跳出確認；紅條會顯示誰在打字，你隨時可以按「結束」。關掉後，別台就不能在這台打字，看畫面不受影響。</small>
          <label>沒指定收件人的信交給
            <input class="set-sel" type="text" maxlength="100" :value="st.bridge.unaddressedTo" :disabled="st.bridge.busy" placeholder="留空＝交給我本人" @change="act('bridge-unaddressed', $event.target.value)" aria-label="沒指定收件人的信交給哪個視窗" />
          </label>
          <small>寄來的信沒有指定收件視窗時，預設交給你本人，在對話裡標示「沒有指定收件人」。指定的視窗不在線時也會交給你本人。</small>
          <small v-if="st.bridge.running">這台的收發信功能目前由 ASN 負責。</small>
          <small v-else-if="st.bridge.legacy">這台的收發信功能目前由舊版收發信小程式負責。</small>
          <template v-if="st.bridge.legacy && st.bridge.takeoverAllowed">
            <asn-button v-if="!st.bridge.confirm" :disabled="st.bridge.busy" @click="act('bridge-takeover')">改由 ASN 負責</asn-button>
            <asn-confirm v-else text="要停掉舊版收發信小程式，改由 ASN 負責嗎？" yes="確定" no="取消" :busy="!!st.bridge.busy" @yes="act('bridge-takeover-yes')" @no="act('bridge-takeover-no')"></asn-confirm>
          </template>
          <small v-if="st.bridge.error">{{ st.bridge.error }}</small>
        </section>
      </template>
      <template v-if="catKey === 'update'">
        <section class="set-card upd-card" aria-label="更新">
          <label class="chk"><input type="checkbox" :checked="st.autoCheck" @change="act('autoCheck', $event.target.checked)" aria-label="自動檢查更新" /><span>自動檢查更新</span></label>
          <div class="upd-row">
            <asn-button @click="act('check-update')" :disabled="st.upd.checking || st.upd.installing">立即檢查</asn-button>
            <div class="upd-status" :class="'tone-' + st.upd.status.tone" role="status">
              <b>{{ st.upd.status.head }}</b>
              <small v-for="(l, i) in st.upd.status.lines" :key="i">{{ l }}</small>
            </div>
          </div>
        </section>
        <section class="chlog" aria-label="版本更新記錄">
          <b>版本更新記錄</b>
          <p v-if="st.logNote" class="chlog-none" role="status">{{ st.logNote }}<asn-button level="text" v-if="st.logRetry" @click="act('releases-retry')">重試</asn-button></p>
          <article v-for="e in (st.log || [])" :key="e.version" class="chlog-item" :class="e.tag">
            <header><span class="chlog-ver">{{ e.version }}</span><span v-if="e.tag === 'current'" class="chlog-tag">目前版本</span><span v-else-if="e.tag === 'update'" class="chlog-tag upd">可更新</span><time v-if="e.date">{{ e.date }}</time></header>
            <ul><li v-for="(l, i) in e.lines" :key="i">{{ l }}</li></ul>
          </article>
        </section>
      </template>
      <template v-if="catKey === 'launch'">
        <div class="launch-set">
          <div class="sec-head">
            <h3 class="sec-h">已安裝的工具</h3>
            <asn-button :disabled="st.launch.checking" @click="act('launch-recheck')">{{ st.launch.checking ? '正在檢查…' : '重新檢查' }}</asn-button>
          </div>
          <ul class="launch-tools">
            <li v-for="t in st.launch.tools" :key="t.id" :class="{ off: !t.installed }">
              <span class="launch-name">{{ t.label }}</span>
              <template v-if="t.installed">
                <span class="launch-ver">{{ t.version || '已安裝' }}</span>
                <span class="launch-latest" :class="'k-' + t.view.latest.kind">{{ t.view.latest.text }}</span>
                <span class="launch-login" :class="'k-' + t.view.login.kind">{{ t.view.login.text }}</span>
              </template>
              <span class="launch-hint" v-else>{{ t.installHint }}</span>
              <template v-if="t.install">
                <asn-button level="primary" class="launch-act" v-if="t.install.showButton" @click="act('launch-install-ask', t.install.liveKind)">{{ t.install.label }}</asn-button>
                <!-- 共用元件（#2105）：原位確認（取消在左、同意在右）與狀態行（進行中／成功／失敗） -->
                <asn-confirm class="launch-install-note" v-if="t.install.confirm" :text="t.install.confirm.text" :yes="t.install.confirm.yes" :no="t.install.confirm.no" @yes="act('launch-install-yes')" @no="act('launch-install-no')"></asn-confirm>
                <asn-status class="launch-install-note" v-if="t.install.running" kind="busy" :text="t.install.running"></asn-status>
                <asn-status class="launch-install-note" v-if="t.install.result" :kind="t.install.result.ok ? 'ok' : 'fail'" :text="t.install.result.text"></asn-status>
              </template>
            </li>
          </ul>
          <h3 class="sec-h">外掛與互通</h3>
          <section class="set-card" aria-label="Claude 外掛" v-if="modLine(st.accounts && st.accounts.mod)">
            <b>Claude 外掛</b>
            <small role="status">{{ modLine(st.accounts && st.accounts.mod) }}</small>
          </section>
          <section class="set-card" aria-label="pi 與 ASN 互通" v-if="st.piSetup">
            <b>{{ st.piSetup.title }}</b>
            <small v-for="(l, i) in st.piSetup.lines" :key="i">{{ l }}</small>
            <small v-if="st.piSetup.docUrl"><a :href="st.piSetup.docUrl" target="_blank" rel="noopener">{{ st.piSetup.docLabel }}</a></small>
            <small v-if="st.piSetup.consent">{{ st.piSetup.consent }}</small>
            <div class="upd-row">
              <asn-button level="primary" v-if="st.piSetup.showAsk" :disabled="st.piSetup.busy" @click="act('pi-setup-ask')">{{ st.piSetup.askLabel }}</asn-button>
              <asn-button v-if="st.piSetup.showCancel" :disabled="st.piSetup.busy" @click="act('pi-setup-cancel')">{{ st.piSetup.cancelLabel }}</asn-button>
              <asn-button level="primary" v-if="st.piSetup.showAgree" :disabled="st.piSetup.busy" @click="act('pi-setup-install')">{{ st.piSetup.agreeLabel }}</asn-button>
              <asn-button v-if="st.piSetup.showReinstall" :disabled="st.piSetup.busy" @click="act('pi-setup-install')">{{ st.piSetup.reinstallLabel }}</asn-button>
              <asn-button v-if="st.piSetup.showRemove" :disabled="st.piSetup.busy" @click="act('pi-setup-remove')">{{ st.piSetup.removeLabel }}</asn-button>
              <asn-button v-if="st.piSetup.showLogin" @click="act('pi-login')">{{ st.piSetup.loginLabel }}</asn-button>
            </div>
            <small v-if="st.piSetup.msg" role="status">{{ st.piSetup.msg }}</small>
          </section>
          <h3 class="sec-h">安全限制</h3>
          <section class="launch-cwds" aria-label="可以開新夥伴的資料夾">
            <b class="launch-cwds-h">可以開新夥伴的資料夾</b>
            <ul class="launch-cwd-list" v-if="st.launch.cwdList.length">
              <li v-for="p in st.launch.cwdList" :key="p"><span class="launch-cwd-path">{{ p }}</span><asn-button :aria-label="'移除 ' + p" @click="act('launch-cwd-remove', p)">移除</asn-button></li>
            </ul>
            <small class="set-note" v-else>還沒有加入資料夾，按「加入資料夾…」選一個。</small>
            <div class="launch-cwd-add"><asn-button @click="act('launch-cwd-add')">＋ 加入資料夾…</asn-button></div>
            <ul class="launch-cwd-list suggest" v-if="st.launch.cwdSuggest.length">
              <li v-for="p in st.launch.cwdSuggest" :key="p"><span class="launch-cwd-path">建議：{{ p }}</span><asn-button :aria-label="'加入 ' + p" @click="act('launch-cwd-suggest', p)">加入</asn-button></li>
            </ul>
            <small class="acct-warn" v-if="st.launch.cwdMsg" role="alert">{{ st.launch.cwdMsg }}</small>
          </section>
          <small class="acct-warn" v-if="st.launch.msg" role="alert">{{ st.launch.msg }}</small>
          <label class="launch-max">別的設備一小時最多替這台開
            <input class="set-input" type="number" min="1" max="20" :value="st.launch.maxPerHour" @change="act('launch-max', Number($event.target.value))">
            個新夥伴
          </label>
          <small class="set-note" id="set-note-launch-max">{{ LAUNCH_MAX_NOTE }}</small>
          <details class="set-adv" v-if="st.askpass">
            <summary>進階</summary>
            <section class="set-card" aria-label="密碼小幫手">
              <small>git 或 ssh 要密碼時由 ASN 跳窗請你輸入，密碼不會經過 AI。想用的話，在終端機執行下面這行（只對之後開的視窗生效；ASN 不會自動改你的設定）：</small>
              <code class="set-code">{{ st.askpass.example }}</code>
              <asn-button level="text" @click="act('askpass-copy')">{{ st.askpass.copied ? '已複製' : '複製路徑' }}</asn-button>
            </section>
          </details>
        </div>
      </template>
      <template v-if="catKey === 'usage'">
        <div class="usage-set">
          <div class="upd-row">
            <asn-button @click="act('usage-refresh')" :disabled="st.usage.loading">重新整理</asn-button>
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
        <p class="about-intro">{{ about.intro }}</p>
        <small class="ver-line">版本 {{ st.version }}</small>
        <small class="about-device" v-if="about.deviceLine">{{ about.deviceLine }}</small>
        <section class="set-card about-links" aria-label="連結">
          <div class="upd-row">
            <template v-for="l in about.items" :key="l.key">
              <asn-button :class="'about-' + l.key" v-if="l.kind === 'link'" @click="act('open-link', l.url)">{{ l.label }}</asn-button>
              <asn-button :class="'about-' + l.key" v-else-if="l.kind === 'update'" @click="act('open-update')">{{ l.label }}</asn-button>
              <asn-button :class="'about-' + l.key" v-else @click="act('open-guide')">{{ l.label }}</asn-button>
            </template>
          </div>
        </section>
        <section class="set-card" aria-label="記錄">
          <b>記錄</b>
          <small>出問題時可以看這份記錄</small>
          <div class="upd-row">
            <asn-button @click="act('open-ui-log')">檢視記錄</asn-button>
          </div>
          <small v-if="st.uiLogMsg" role="status">{{ st.uiLogMsg }}</small>
        </section>
        <small class="about-maker">{{ about.maker }}</small>
      </template>
      <asn-dialog v-if="forgetBox" :title="KNOWN.forgetTitle" initial-focus=".forget-cancel" @close="forget.no">
        <p class="launch-notice-body">{{ forgetBox.text }}</p>
        <asn-actions class="partner-actions">
          <asn-button class="forget-cancel" @click="forget.no">{{ KNOWN.forgetCancel }}</asn-button>
          <asn-button state="danger" @click="forget.yes">{{ KNOWN.forgetYes }}</asn-button>
        </asn-actions>
      </asn-dialog>
    </div>`,
}
