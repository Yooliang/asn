// 設定聊天窗的內容：某一類設定的表單。整合模式的右邊分頁與分離模式的設定視窗共用同一個元件。
// 元件只顯示「狀態快照」（st）並用 act 事件下指令；狀態與所有動作都在名單視窗的樞紐（list.js）——
// 金鑰、存檔、Rust 指令都不經過這裡，分離視窗也因此不持有任何設定狀態。
// 這個檔在 node 也要能載入（測試），所以 Vue 只在元件 setup 裡才取用。
import { TEXT as KNOWN, groupFp } from './known-peers.mjs'
import { FpQrCanvas, QR_TEXT } from './fp-qr.mjs'
import { AUTO_CHOICES, AUTO_LABEL, STT_LANGS, STT_LANG_LABEL, STT_MODELS, STT_MODEL_LABEL } from './voice-prefs.mjs'
import { BUBBLES, BUBBLE_LABEL, DP_LABEL, DP_MODES, MODES, MODE_LABEL, TOOLBARS, TOOLBAR_LABEL } from './merge.mjs'
import { CLOSE_CHOICES, CLOSE_LABEL, FRAMES, FRAME_LABEL, NOTIFY_ITEMS } from './prefs.mjs'
import { DIMS, groupOptions } from './dims.mjs'
import { LoginPanel, LogoutPanel } from './login-panel.mjs'
import { CloudInvitePanel } from './cloud-invite.mjs'
import { accountLine, INCOMPLETE_LABEL, INCOMPLETE_REASON, loginIncomplete } from './claude-accounts.mjs'
import { catByKey, normalizeCatKey } from './settings-cats.mjs'
import { vendorIconSvg } from './vendor-icons.mjs'
import { USAGE_NOTE } from './usage.mjs'
import { NO_QUOTA_TEXT, planLabel, quotaBars, quotaView } from './account-quota.mjs'
import { DEVICE_TEXT, canRemoveRow, dropAfter, moveFlags, removedRows, visibleRows } from './device-order.mjs'
import { DEVICE_BUTTON_TEXT, ROSTER_TEXT, deviceBlockReason, deviceButtons, usedOnText } from './account-roster.mjs'
import { INSTALL_TEXT } from './agent-install.mjs'
import { QUOTA_TEXT, shareKey, vendorSections } from './quota-readers.mjs'
import { AGENT_INSTALL_UI } from './device-state.mjs'
import { TERM_SERVER_MISSING_NOTE, termServerWhyLine, keyProtectionNote, termFetchLine, termServerNote } from './term-server-setting.mjs'

// 元件會送出的指令（樞紐的 applySetting 要每個都接得住；測試對照這份清單）
export const SETTING_OPS = [
  'quota-source', 'quota-refresh', 'quota-mm-add', 'quota-mm-remove', 'quota-share', 'quota-unshare', 'quota-copy', 'quota-close',
  'notify', 'now-playing', 'frame', 'mode', 'dpMode', 'toolbar', 'bubble', 'tabDim', 'groupDim',
  'voice-save', 'voice-install', 'acct-switch', 'acct-remove', 'acct-allow-switch', 'install-ask', 'install-yes', 'install-no', 'install-cancel', 'install-terminal', 'install-close', 'install-allow', 'grok-switch', 'device-switch', 'device-move', 'device-reorder', 'device-show', 'device-remove',
  'closeTo', 'autostart', 'guard', 'guard-resume', 'bridge-launch', 'bridge-auto-resume', 'known-forget', 'known-rename', 'known-qr', 'known-input-no-ask', 'known-login-ok', 'bridge-term-server', 'bridge-term-fetch-retry', 'bridge-screen-watch', 'bridge-perm-phone', 'bridge-mobile-view', 'bridge-unaddressed', 'bridge-takeover', 'bridge-takeover-yes', 'bridge-takeover-no', 'askpass-copy', 'autoCheck', 'check-update', 'releases-retry', 'usage-refresh', 'launch-max', 'launch-cwd', 'pi-setup-ask', 'pi-setup-install', 'pi-setup-cancel', 'pi-setup-remove', 'quota-hook-ask', 'quota-hook-connect', 'quota-hook-cancel', 'quota-hook-disconnect', 'avatar-remove', 'pi-login', 'open-ui-log',
]

export const SettingsPanel = {
  components: { LoginPanel, LogoutPanel, CloudInvitePanel, FpQrCanvas },
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
    // 帳號卡片的設備按鈕：使用中的按了不做事；其他的就是原本的「切換到那台」（同一個指令、確認框照舊）
    const selfKey = computed(() => allDevs.value.find(d => d.self)?.key ?? '')
    const devName = node => allDevs.value.find(d => d.key === node)?.label ?? ''
    // 切不過去的（不是使用中、也沒有切換目標）帶上原因，寫在按鈕下方
    const devButtons = (vendor, a) => deviceButtons(a?.usedOn, switchTargets(vendor, a), selfKey.value, devName)
      .map(b => (b.current || b.target ? b : { ...b, reason: deviceBlockReason(allDevs.value, vendor, a?.account, b.node) }))
    const pressDev = b => {
      if (b.current || !b.target) return
      act(b.target.op, b.target.value)
    }
    // MiniMax 的輸入欄只留在元件裡：送出就清空，不進設定頁快照
    // 認得的電腦：改名的輸入（只在這個元件裡，存的時候才交給樞紐）
    const renameNode = ref(''), renameText = ref('')
    const renameStart = p => { renameNode.value = p.node; renameText.value = p.name }
    const renameCancel = () => { renameNode.value = ''; renameText.value = '' }
    const renameSave = () => { const node = renameNode.value; if (!node) return; act('known-rename', { node, name: renameText.value }); renameCancel() }
    const mmEmail = ref('')
    const mmKey = ref('')
    const addMinimax = () => {
      act('quota-mm-add', { email: mmEmail.value, key: mmKey.value })
      mmKey.value = ''
      mmEmail.value = ''
    }
    const pickFile = ev => { const f = ev.target.files?.[0]; ev.target.value = ''; if (f) emit('avatar-file', f) }
    return { KNOWN, QR_TEXT, groupFp, renameNode, renameText, renameStart, renameCancel, renameSave,
      QUOTA_TEXT, shareKey, vendorSections, mmEmail, mmKey, addMinimax, devButtons, pressDev, DEVICE_BUTTON_TEXT,
      fileEl, act, pickFile, USAGE_NOTE, accountLine, groupOptions, termServerNote, termFetchLine, TERM_SERVER_MISSING_NOTE, termServerWhyLine, keyProtectionNote,
      cat, catIcon, ROSTER_TEXT, usedOnText, INSTALL_TEXT, AGENT_INSTALL_UI, switchTargets, devs, removedDevs, flags, curDev, curVendors, askRemove, removedOpen, open, backToList, onRow, removeNow, dragKey, overKey, overAfter, clearDrag, dragStart, dragOver, drop, DEVICE_TEXT, canRemoveRow, vendorIcon: vendorIconSvg, qv: a => quotaView(a), qb: a => quotaBars(a, { hookOn: props.st.quotaHook ? props.st.quotaHook.state === 'on' : null }), NO_QUOTA_TEXT, planLabel, isIncomplete: loginIncomplete, INCOMPLETE_LABEL, INCOMPLETE_REASON,
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
          <small v-else>念出訊息時，那則訊息的文字會經 ASN 送到語音代理合成（微軟 Edge 的非公開介面，僅個人用）。語音輸入則完全在這台電腦上辨識。</small>
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
      <template v-if="cat === 'cloud'">
        <cloud-invite-panel></cloud-invite-panel>
      </template>
      <template v-if="cat === 'accounts'">
        <div class="dv-set dv-acctpage">
          <section class="dv-my" v-if="st.myAccounts || st.quotaReaders || st.quotaHook" :aria-label="st.myAccounts ? st.myAccounts.title : QUOTA_TEXT.title">
              <h3 class="dv-my-h" v-if="st.myAccounts">{{ st.myAccounts.title }}</h3>
              <small v-if="st.myAccounts && st.myAccounts.empty">{{ st.myAccounts.empty }}</small>
              <small v-if="st.quotaReaders">{{ QUOTA_TEXT.note }}</small>
              <div class="dv-my-v" v-for="v in vendorSections(st.myAccounts, st.quotaReaders, st.quotaHook)" :key="v.key" :data-vendor="v.key">
                <header class="dv-vh"><span class="dv-vicon" aria-hidden="true" v-html="vendorIcon(v.key)"></span><b>{{ v.label }}</b>
                  <!-- 額度開關（原本在「額度來源」大段與啟動設定的「額度回報」，行為不變、只換位置）：只管這台電腦 -->
                  <span class="dv-vtog" v-if="st.quotaReaders && v.key === 'grok'">
                    <label class="chk"><input type="checkbox" :checked="st.quotaReaders.grok" :disabled="st.quotaReaders.busy" @change="act('quota-source', { source: 'grok', on: $event.target.checked })" /><span>{{ QUOTA_TEXT.grok }}</span></label>
                  </span>
                  <span class="dv-vtog" v-if="v.key === 'claude' && (st.quotaHook || (st.quotaReaders && st.quotaReaders.extraDirs.length))">
                    <label class="chk" v-if="st.quotaHook"><input type="checkbox" :checked="st.quotaHook.toggleOn" :disabled="st.quotaHook.toggleDisabled" @change="$event.target.checked ? act('quota-hook-ask') : act('quota-hook-disconnect'); $event.target.checked = st.quotaHook.toggleOn" /><span>{{ st.quotaHook.toggle }}</span></label>
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
                <div class="dv-vq" v-if="v.key === 'claude' && st.quotaHook">
                  <small>{{ st.quotaHook.short }}{{ QUOTA_TEXT.thisPc }}</small>
                  <small v-if="st.quotaHook.current">目前的狀態列指令：<code>{{ st.quotaHook.current }}</code></small>
                  <small v-if="st.quotaHook.consent">{{ st.quotaHook.consent }}</small>
                  <span class="dv-ibtns" v-if="st.quotaHook.showAgree || st.quotaHook.showCancel || st.quotaHook.showReconnect">
                    <button class="aero-btn" type="button" v-if="st.quotaHook.showReconnect" :disabled="st.quotaHook.busy" @click="act('quota-hook-ask')">{{ st.quotaHook.askLabel }}</button>
                    <button class="aero-btn" type="button" v-if="st.quotaHook.showAgree" :disabled="st.quotaHook.busy" @click="act('quota-hook-connect')">{{ st.quotaHook.agreeLabel }}</button>
                    <button class="aero-btn" type="button" v-if="st.quotaHook.showCancel" :disabled="st.quotaHook.busy" @click="act('quota-hook-cancel')">{{ st.quotaHook.cancelLabel }}</button>
                  </span>
                  <small v-if="st.quotaHook.msg" role="status">{{ st.quotaHook.msg }}</small>
                  <details><summary>{{ QUOTA_TEXT.more }}</summary><small v-for="(l, i) in st.quotaHook.lines" :key="i">{{ l }}</small></details>
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
                      <button class="aero-btn" type="button" :disabled="st.quotaReaders.busy" @click="act('quota-refresh', !st.quotaReaders.extraRefresh)">{{ st.quotaReaders.extraRefresh ? QUOTA_TEXT.refreshOff : st.quotaReaders.confirm === 'refresh' ? QUOTA_TEXT.refreshConfirm : QUOTA_TEXT.refreshOn }}</button>
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
                        <span class="dv-side"><button class="aero-btn" type="button" :disabled="st.quotaReaders.busy" @click="act('quota-mm-remove', m.email)">{{ st.quotaReaders.confirm === 'minimax\\n' + m.email ? QUOTA_TEXT.minimaxConfirmRemove : QUOTA_TEXT.minimaxRemove }}</button></span>
                        <small class="dv-why acct-warn" v-if="!m.hasKey">{{ QUOTA_TEXT.minimaxNoKey }}</small>
                        <small class="dv-why acct-warn" v-else-if="m.status">{{ m.status }}</small>
                      </li>
                    </ul>
                    <form class="dv-mm" v-if="st.quotaReaders.minimax.length < 2" @submit.prevent="addMinimax">
                      <input type="email" autocomplete="off" :placeholder="QUOTA_TEXT.minimaxEmail" :aria-label="QUOTA_TEXT.minimaxEmail" v-model="mmEmail" />
                      <input type="password" autocomplete="off" :placeholder="QUOTA_TEXT.minimaxKey" :aria-label="QUOTA_TEXT.minimaxKey" v-model="mmKey" />
                      <button class="aero-btn" type="submit" :disabled="st.quotaReaders.busy">{{ QUOTA_TEXT.minimaxAdd }}</button>
                    </form>
                  </template>
                </div>
                <ul class="dv-accts">
                  <li :class="['dv-acct', { cur: a.current }]" v-for="a in v.accounts" :key="a.account">
                    <span class="dv-mail">{{ a.account }}</span>
                    <span class="dv-side">
                      <span class="dv-plan" v-if="a.plan">{{ planLabel(a.plan) }}</span>
                      <span class="dv-cur" v-if="a.current">使用中</span>
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
                      <span class="dv-old" v-if="a.quota.oldText">{{ a.quota.oldText }}</span>
                      <span v-if="a.quota.meta">（{{ a.quota.meta }}）</span>
                    </span>
                    <!-- 設備按鈕：用過這個帳號的每台一顆。使用中＝黃色底、aria-pressed，按鈕上只寫設備名，按了不做事；其他的按了改用那台（原本的切換流程） -->
                    <span class="dv-devs" v-if="devButtons(v.key, a).length" role="group" :aria-label="DEVICE_BUTTON_TEXT.group + ' ' + a.account">
                      <span class="dv-devb" v-for="b in devButtons(v.key, a)" :key="b.node"><button type="button" :class="['aero-btn', 'dv-devbtn', { on: b.current }]" :aria-pressed="b.current ? 'true' : 'false'" :disabled="!b.current && (!b.target || (st.accounts && st.accounts.busy))" :aria-describedby="b.reason ? 'dv-why-' + v.key + '-' + a.account + '-' + b.node : null" @click="pressDev(b)">{{ b.label }}</button><small class="dv-devwhy" v-if="b.reason" :id="'dv-why-' + v.key + '-' + a.account + '-' + b.node">{{ b.reason }}</small></span>
                    </span>
                    <span class="dv-share" v-if="st.quotaReaders">
                      <button class="aero-btn" type="button" :disabled="st.quotaReaders.busy" @click="act('quota-share', { vendor: v.key, account: a.account, shared: a.shared })">{{ !a.shared ? QUOTA_TEXT.share : st.quotaReaders.confirm === 'again\\n' + shareKey(v.key, a.account) ? QUOTA_TEXT.shareConfirmAgain : QUOTA_TEXT.shareAgain }}</button>
                      <button class="aero-btn" type="button" v-if="a.shared" :disabled="st.quotaReaders.busy" @click="act('quota-unshare', { vendor: v.key, account: a.account })">{{ st.quotaReaders.confirm === 'revoke\\n' + shareKey(v.key, a.account) ? QUOTA_TEXT.shareConfirmRevoke : QUOTA_TEXT.shareRevoke }}</button>
                      <small class="acct-warn" v-if="st.quotaReaders.confirm === 'again\\n' + shareKey(v.key, a.account)">{{ QUOTA_TEXT.shareAgainWarn }}</small>
                      <small class="acct-warn" v-if="st.quotaReaders.confirm === 'revoke\\n' + shareKey(v.key, a.account)">{{ QUOTA_TEXT.shareRevokeWarn }}</small>
                    </span>
                    <div class="dv-code" role="status" v-if="st.quotaReaders && st.quotaReaders.code && st.quotaReaders.code.key === shareKey(v.key, a.account)">
                      <b>{{ QUOTA_TEXT.codeTitle }}</b>
                      <code>{{ st.quotaReaders.code.value }}</code>
                      <small>{{ QUOTA_TEXT.codeOnce }}</small>
                      <span class="dv-ibtns">
                        <button class="aero-btn" type="button" @click="act('quota-copy')">{{ st.quotaReaders.copied ? QUOTA_TEXT.copied : QUOTA_TEXT.copy }}</button>
                        <button class="aero-btn" type="button" @click="act('quota-close')">{{ QUOTA_TEXT.close }}</button>
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
              <li v-for="d in devs" :key="d.key" :data-dev="d.key" :class="['dv-row', { hid: d.hidden, off: !d.online, dragging: dragKey === d.key, 'drop-before': overKey === d.key && !overAfter, 'drop-after': overKey === d.key && overAfter }]" :draggable="!d.self" @click="onRow(d.key, $event)" @dragstart="dragStart(d.key, $event)" @dragover="dragOver(d.key, $event)" @drop="drop(d.key, $event)" @dragend="clearDrag">
                <button class="dv-row-go" type="button" :aria-label="'查看 ' + d.label + ' 的帳號'"><span class="dv-name">{{ d.label }}</span><span class="dv-tag kind" v-if="(d.kindLabel || d.kind) !== '電腦'">{{ d.kindLabel || d.kind }}</span><span :class="['dv-tag', d.online ? 'on' : 'off']">{{ d.onlineText }}</span><span class="dv-tag me" v-if="d.self">這台</span><span class="dv-tag hid" v-if="d.hidden">{{ DEVICE_TEXT.hiddenTag }}</span><small class="dv-line" v-if="d.stateLine">{{ d.stateLine }}</small></button>
                <span class="dv-row-move" v-if="!d.self" role="group" aria-label="設備順序">
                  <button class="aero-btn" type="button" :disabled="!flags[d.key].up" :aria-label="'上移 ' + d.label" @click.stop="act('device-move', { node: d.key, dir: -1 })">{{ DEVICE_TEXT.moveUp }}</button>
                  <button class="aero-btn" type="button" :disabled="!flags[d.key].down" :aria-label="'下移 ' + d.label" @click.stop="act('device-move', { node: d.key, dir: 1 })">{{ DEVICE_TEXT.moveDown }}</button>
                </span>
                <span class="dv-chev" aria-hidden="true">&rsaquo;</span>
              </li>
            </ul>
          </template>
          <section class="dv-dev" v-else :aria-label="curDev.label">
            <div class="dv-dev-h">
              <button class="aero-btn dv-back" type="button" @click="backToList">{{ DEVICE_TEXT.back }}</button>
              <h3 class="dv-name">{{ curDev.label }}</h3>
              <span class="dv-tag kind" v-if="(curDev.kindLabel || curDev.kind) !== '電腦'">{{ curDev.kindLabel || curDev.kind }}</span>
              <span :class="['dv-tag', curDev.online ? 'on' : 'off']">{{ curDev.onlineText }}</span>
              <span class="dv-tag me" v-if="curDev.self">這台</span>
              <span class="dv-tag off" v-if="curDev.hidden">{{ DEVICE_TEXT.hiddenTag }}</span>
            </div>
            <div class="dv-hid-act" v-if="canRemoveRow(curDev)">
              <template v-if="!askRemove">
                <button class="aero-btn" type="button" v-if="curDev.hidden" @click="act('device-show', curDev.key)">{{ DEVICE_TEXT.showBack }}</button>
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
                            <button class="aero-btn" type="button" @click="act('acct-switch', a.email)" :disabled="st.accounts.busy || a.current || isIncomplete(a)" :title="isIncomplete(a) ? INCOMPLETE_REASON : null">切換</button>
                            <button class="aero-btn" type="button" @click="act('acct-remove', a.email)" :disabled="st.accounts.busy">{{ st.accounts.confirmDel === a.email ? '確認刪除' : '刪除' }}</button>
                          </span>
                          <small class="dv-why acct-warn" v-if="isIncomplete(a) && !a.current">{{ INCOMPLETE_REASON }}</small>
                          <span class="dv-quota" :class="{ stale: qb(a).stale, out: qv(a).exhausted }">
                            <span class="dv-bars" v-if="qb(a).bars.length">
                              <span class="dv-bar" v-for="b in qb(a).bars" :key="b.key" :class="{ done: b.expired }">
                                <span class="dv-bl">{{ b.label }}</span>
                                <span class="dv-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="b.pct" :aria-label="b.label + '剩餘額度'"><span class="dv-fill" :class="{ low: b.low }" :style="{ width: (b.expired ? 0 : b.pct) + '%' }"></span></span>
                                <span class="dv-bp">{{ b.expired ? '' : '剩 ' + b.pct + '%' }}</span>
                                <span class="dv-br" v-if="b.reset">{{ b.reset }}</span>
                              </span>
                            </span>
                            <span v-else>{{ qb(a).note }}</span>
                            <span v-if="qb(a).reset">・{{ qb(a).reset }}</span>
                            <span v-if="qb(a).meta">（{{ qb(a).meta }}）</span>
                          </span>
                        </li>
                      </ul>
                      <div class="dv-none" v-else>還沒有加入過帳號。</div>
                      <small v-if="st.accounts.current && !st.accounts.current.saved" class="acct-warn">目前登入的 {{ st.accounts.current.email }} 還沒加入帳號庫，ASN 會在一分鐘內自動加入，加入後才能切換到別的帳號。</small>
                      <small v-else-if="!st.accounts.current">這台電腦目前沒有 Claude 登入。</small>
                      <small v-if="st.accounts.autoNote" role="status">{{ st.accounts.autoNote }}</small>
                      <small role="status">{{ st.accounts.msg }}</small>
                      <small v-if="st.accounts.mod" role="status">{{ st.accounts.mod }}</small>
                      <label class="chk"><input type="checkbox" :checked="st.accounts.allowSwitch" @change="act('acct-allow-switch', $event.target.checked)" /><span>允許切換帳號</span></label>
                      <small>讓手機或別台設備替這台切換帳號。</small>
                      <div class="dv-install" v-if="AGENT_INSTALL_UI && st.install && ((v.action && v.action.kind === 'local') || st.install.stage === 'running' || st.install.stage === 'done')">
                        <template v-if="st.install.stage === 'idle'">
                          <button class="aero-btn" type="button" :disabled="st.install.button.disabled" @click="act('install-ask')">{{ INSTALL_TEXT.button }}</button>
                          <small class="acct-warn" v-if="st.install.button.hint">{{ st.install.button.hint }}</small>
                          <small v-if="st.install.msg" role="status">{{ st.install.msg }}</small>
                        </template>
                        <div class="dv-confirm" role="alertdialog" :aria-label="INSTALL_TEXT.confirmTitle" v-else-if="st.install.stage === 'confirm'">
                          <b>{{ INSTALL_TEXT.confirmTitle }}</b>
                          <p>{{ st.install.plan }}</p>
                          <span class="dv-ibtns">
                            <button class="aero-btn" type="button" @click="act('install-yes')">{{ INSTALL_TEXT.confirmYes }}</button>
                            <button class="aero-btn" type="button" @click="act('install-no')">{{ INSTALL_TEXT.confirmNo }}</button>
                          </span>
                        </div>
                        <div class="dv-prog" role="status" aria-live="polite" v-else>
                          <b :class="['dv-ptitle', st.install.kind]">{{ st.install.title }}</b>
                          <p v-for="(l, i) in st.install.lines" :key="i" :class="{ note: i > 0 }">{{ l }}</p>
                          <small v-if="st.install.stage === 'running'">{{ INSTALL_TEXT.progressNote }}</small>
                          <span class="dv-ibtns">
                            <button class="aero-btn" type="button" v-if="st.install.stage === 'running'" :disabled="!st.install.canCancel" @click="act('install-cancel')">{{ INSTALL_TEXT.cancel }}</button>
                            <button class="aero-btn" type="button" v-if="st.install.stage === 'done' && st.install.terminal" @click="act('install-terminal')">{{ INSTALL_TEXT.openTerminal }}</button>
                            <button class="aero-btn" type="button" v-if="st.install.stage === 'done'" @click="act('install-close')">{{ INSTALL_TEXT.close }}</button>
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
                            <button class="aero-btn" type="button" v-else-if="(v.key === 'claude' || v.key === 'grok') && !curDev.self && (v.switchable || v.switchHint)" :disabled="!v.switchable || a.incomplete" :title="a.incomplete ? INCOMPLETE_REASON : null" @click="act('device-switch', { node: curDev.key, email: a.email, vendor: v.key })">切換</button>
                            <button class="aero-btn" type="button" v-else-if="v.key === 'grok' && curDev.self && v.accounts.length > 1" :disabled="st.accounts.busy" @click="act('grok-switch', a.email)">切換</button>
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
                            <span v-if="a.quota.resetLine">・{{ a.quota.resetLine }}</span>
                            <span class="dv-old" v-if="a.quota.oldText">{{ a.quota.oldText }}</span>
                            <span v-if="a.quota.meta">（{{ a.quota.meta }}）</span>
                          </span>
                          <span class="dv-quota stale" v-else-if="v.key === 'codex' || v.key === 'grok'">{{ NO_QUOTA_TEXT }}</span>
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
        <template v-if="st.guard && st.guard.supported">
          <label class="chk"><input type="checkbox" :checked="st.guard.on" :disabled="st.guard.busy || (!!st.guard.blocked && !st.guard.on)" @change="act('guard', $event.target.checked)" aria-label="ASN 意外關閉時自動重新開啟" /><span>ASN 意外關閉時自動重新開啟</span></label>
          <small>只在 ASN 意外關閉時重開，你自己按結束不會重開。</small>
          <small v-if="st.guard.blocked" class="autostart-blocked">{{ st.guard.blocked }}</small>
          <small v-if="st.guard.paused" class="guard-paused" role="status">{{ st.guard.paused }} <button class="aero-btn" type="button" :disabled="st.guard.busy" @click="act('guard-resume')">恢復自動重開</button></small>
        </template>
        <section class="set-card" aria-label="認得的電腦" v-if="st.known">
          <h3 class="set-h">{{ KNOWN.title }}</h3>
          <small>{{ KNOWN.lead }}</small>
          <p v-if="st.known.ownFp"><b>{{ KNOWN.ownFp(st.known.ownFp) }}</b> <button class="aero-btn" type="button" :disabled="st.known.busy" @click="act('known-qr', !st.known.qr)">{{ st.known.qr ? QR_TEXT.hide : QR_TEXT.show }}</button></p>
          <div class="fp-qr-box" v-if="st.known.ownFp && st.known.qr">
            <fp-qr-canvas :qr="st.known.qr"></fp-qr-canvas>
            <small>{{ QR_TEXT.note }}</small>
          </div>
          <small v-if="!st.known.peers.length">{{ KNOWN.none }}</small>
          <div class="pair-row" v-for="p in st.known.peers" :key="p.node">
            <p><b>{{ p.label }}</b> <span v-if="p.firstSeen">{{ KNOWN.firstSeen(p.firstSeen) }}</span></p>
            <code class="pair-fp" :aria-label="KNOWN.fingerprint">{{ groupFp(p.fingerprint) }}</code>
            <label class="chk"><input type="checkbox" :checked="p.inputNoAsk" :disabled="st.known.busy" @change="act('known-input-no-ask', { node: p.node, on: $event.target.checked })" :aria-label="KNOWN.inputNoAsk" /><span>{{ KNOWN.inputNoAsk }}</span></label>
            <small v-if="p.inputNoAsk && p.inputConfirmed" class="pair-warn">{{ KNOWN.inputNoAskWarn }}</small>
            <small v-if="p.inputNoAsk && !p.inputConfirmed">{{ KNOWN.inputFirstAsk }}</small>
            <label class="chk"><input type="checkbox" :checked="p.loginOk" :disabled="st.known.busy" @change="act('known-login-ok', { node: p.node, on: $event.target.checked })" :aria-label="KNOWN.loginOk" /><span>{{ KNOWN.loginOk }}</span></label>
            <small v-if="p.loginOk" class="pair-warn">{{ KNOWN.loginOkWarn }}</small>
            <form class="pair-rename" v-if="renameNode === p.node" @submit.prevent="renameSave">
              <input type="text" maxlength="32" autocomplete="off" v-model="renameText" :aria-label="KNOWN.renameLabel" />
              <small>{{ KNOWN.renameHint }}</small>
              <span class="pair-btns"><button class="aero-btn" type="submit" :disabled="st.known.busy">{{ KNOWN.renameSave }}</button><button class="aero-btn" type="button" @click="renameCancel">{{ KNOWN.renameCancel }}</button></span>
            </form>
            <span class="pair-btns"><button class="aero-btn" type="button" :disabled="st.known.busy" @click="renameStart(p)">{{ KNOWN.rename }}</button><button class="aero-btn" type="button" :disabled="st.known.busy" @click="act('known-forget', p.node)">{{ KNOWN.forget }}</button></span>
          </div>
          <small v-if="st.known.peers.length">{{ KNOWN.forgetNote }}</small>
          <p class="pair-warn" v-if="st.known.error" role="alert">{{ st.known.error }}</p>
        </section>
        <section class="set-card" aria-label="收發信功能" v-if="st.bridge">
          <label class="chk"><input type="checkbox" :checked="st.bridge.remoteLaunch" :disabled="st.bridge.busy" @change="act('bridge-launch', $event.target.checked)" aria-label="允許我的其他設備替這台開新視窗" /><span>允許我的其他設備替這台開新視窗</span></label>
          <label class="chk"><input type="checkbox" :checked="st.bridge.autoResume" :disabled="st.bridge.busy" @change="act('bridge-auto-resume', $event.target.checked)" aria-label="電腦重開後自動接回夥伴" /><span>電腦重開後自動接回夥伴</span></label>
          <small>重開前還開著、由 ASN 開的夥伴，登入 Windows 後會接回原本的對話。權限和原本相同，收到信就會繼續工作，也會用到額度。關掉就要自己按「喚醒」。</small>
          <template v-if="st.bridge.termServerSupported">
            <label class="chk"><input type="checkbox" :checked="st.bridge.termServer" :disabled="st.bridge.busy || st.bridge.termServerLocked" @change="act('bridge-term-server', $event.target.checked)" aria-label="夥伴共用同一個終端服務" /><span>夥伴共用同一個終端服務</span></label>
            <small>{{ termServerNote(st.bridge) }}</small>
            <small v-if="termServerWhyLine(st.bridge)" class="term-server-why" role="note">{{ termServerWhyLine(st.bridge) }}</small>
            <template v-if="termFetchLine(st.bridge).text">
              <small role="status">{{ termFetchLine(st.bridge).text }}</small>
              <span class="pair-btns" v-if="termFetchLine(st.bridge).canRetry"><button class="aero-btn" type="button" :disabled="st.bridge.busy" @click="act('bridge-term-fetch-retry')">重試</button></span>
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
          <label>沒指定收件人的信交給
            <input class="set-sel" type="text" maxlength="100" :value="st.bridge.unaddressedTo" :disabled="st.bridge.busy" placeholder="留空＝交給我本人" @change="act('bridge-unaddressed', $event.target.value)" aria-label="沒指定收件人的信交給哪個視窗" />
          </label>
          <small>寄來的信沒有指定收件視窗時，預設交給你本人，在對話裡標示「沒有指定收件人」。指定的視窗不在線時也會交給你本人。</small>
          <small v-if="st.bridge.running">這台的收發信功能目前由 ASN 負責。</small>
          <small v-else-if="st.bridge.legacy">這台的收發信功能目前由舊版收發信小程式負責。</small>
          <template v-if="st.bridge.legacy && st.bridge.takeoverAllowed">
            <button v-if="!st.bridge.confirm" class="aero-btn" type="button" :disabled="st.bridge.busy" @click="act('bridge-takeover')">改由 ASN 負責</button>
            <div v-else class="upd-row">
              <small>要停掉舊版收發信小程式，改由 ASN 負責嗎？</small>
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
          <p v-if="st.logNote" class="chlog-none" role="status">{{ st.logNote }}<button v-if="st.logRetry" class="aero-btn" type="button" @click="act('releases-retry')">重試</button></p>
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
            <small v-if="st.piSetup.docUrl"><a :href="st.piSetup.docUrl" target="_blank" rel="noopener">{{ st.piSetup.docLabel }}</a></small>
            <small v-if="st.piSetup.consent">{{ st.piSetup.consent }}</small>
            <div class="upd-row">
              <button class="aero-btn" type="button" v-if="st.piSetup.showAsk" :disabled="st.piSetup.busy" @click="act('pi-setup-ask')">{{ st.piSetup.askLabel }}</button>
              <button class="aero-btn" type="button" v-if="st.piSetup.showAgree" :disabled="st.piSetup.busy" @click="act('pi-setup-install')">{{ st.piSetup.agreeLabel }}</button>
              <button class="aero-btn" type="button" v-if="st.piSetup.showCancel" :disabled="st.piSetup.busy" @click="act('pi-setup-cancel')">{{ st.piSetup.cancelLabel }}</button>
              <button class="aero-btn" type="button" v-if="st.piSetup.showReinstall" :disabled="st.piSetup.busy" @click="act('pi-setup-install')">{{ st.piSetup.reinstallLabel }}</button>
              <button class="aero-btn" type="button" v-if="st.piSetup.showRemove" :disabled="st.piSetup.busy" @click="act('pi-setup-remove')">{{ st.piSetup.removeLabel }}</button>
              <button class="aero-btn" type="button" v-if="st.piSetup.showLogin" @click="act('pi-login')">{{ st.piSetup.loginLabel }}</button>
            </div>
            <small v-if="st.piSetup.msg" role="status">{{ st.piSetup.msg }}</small>
          </section>
          <section class="set-card" aria-label="Claude 外掛" v-if="st.claudeModAuto !== null && st.claudeModAuto !== undefined">
            <b>Claude 外掛</b>
            <label class="chk"><input type="checkbox" checked disabled /><span>自動安裝或更新 Claude 外掛</span></label>
            <small>ASN 必要元件，會自動安裝和更新。</small>
            <small v-if="st.accounts && st.accounts.mod" role="status">{{ st.accounts.mod }}</small>
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
        <section class="set-card" aria-label="記錄">
          <b>記錄</b>
          <small>出問題時可以看這份記錄</small>
          <div class="upd-row">
            <button class="aero-btn" type="button" @click="act('open-ui-log')">檢視記錄</button>
          </div>
          <small v-if="st.uiLogMsg" role="status">{{ st.uiLogMsg }}</small>
        </section>
      </template>
    </div>`,
}
