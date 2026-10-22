// 設定聊天窗的內容：某一類設定的表單。整合模式的右邊分頁與分離模式的設定視窗共用同一個元件。
// 元件只顯示「狀態快照」（st）並用 act 事件下指令；狀態與所有動作都在名單視窗的樞紐（list.js）——
// 金鑰、存檔、Rust 指令都不經過這裡，分離視窗也因此不持有任何設定狀態。
// 這個檔在 node 也要能載入（測試），所以 Vue 只在元件 setup 裡才取用。
import { AUTO_CHOICES, AUTO_LABEL, STT_LANGS, STT_LANG_LABEL, STT_MODELS, STT_MODEL_LABEL } from './voice-prefs.mjs'
import { BUBBLES, BUBBLE_LABEL, DP_LABEL, DP_MODES, MODES, MODE_LABEL, TOOLBARS, TOOLBAR_LABEL } from './merge.mjs'
import { CLOSE_CHOICES, CLOSE_LABEL, FRAMES, FRAME_LABEL, NOTIFY_ITEMS } from './prefs.mjs'
import { DIMS, groupOptions } from './dims.mjs'
import { LoginPanel } from './login-panel.mjs'
import { CloudInvitePanel } from './cloud-invite.mjs'
import { OTHER_VENDORS, VENDOR_UNSUPPORTED, accountLine } from './claude-accounts.mjs'
import { USAGE_NOTE } from './usage.mjs'

// 元件會送出的指令（樞紐的 applySetting 要每個都接得住；測試對照這份清單）
export const SETTING_OPS = [
  'notify', 'now-playing', 'frame', 'mode', 'dpMode', 'toolbar', 'bubble', 'tabDim', 'groupDim',
  'voice-save', 'voice-install', 'acct-switch', 'acct-remove', 'acct-add', 'acct-auto', 'acct-remote-node', 'acct-remote-switch', 'acct-trust',
  'closeTo', 'autostart', 'bridge-enable', 'bridge-launch', 'bridge-unaddressed', 'bridge-takeover', 'bridge-takeover-yes', 'bridge-takeover-no', 'cli-copy', 'askpass-copy', 'autoCheck', 'check-update', 'usage-refresh', 'launch-max', 'launch-cwd', 'avatar-remove',
]

export const SettingsPanel = {
  components: { LoginPanel, CloudInvitePanel },
  props: { st: { type: Object, required: true }, catKey: { type: String, required: true }, meAv: { type: String, default: '' } },
  emits: ['act', 'avatar-file'],
  setup(props, { emit }) {
    const { ref } = globalThis.Vue
    const fileEl = ref(null)
    const act = (op, value) => emit('act', op, value)
    const pickFile = ev => { const f = ev.target.files?.[0]; ev.target.value = ''; if (f) emit('avatar-file', f) }
    return {
      fileEl, act, pickFile, USAGE_NOTE, accountLine, groupOptions, OTHER_VENDORS, VENDOR_UNSUPPORTED,
      AUTO_CHOICES, AUTO_LABEL, STT_LANGS, STT_LANG_LABEL, STT_MODELS, STT_MODEL_LABEL,
      MODES, MODE_LABEL, DP_MODES, DP_LABEL, TOOLBARS, TOOLBAR_LABEL, BUBBLES, BUBBLE_LABEL,
      CLOSE_CHOICES, CLOSE_LABEL, FRAMES, FRAME_LABEL, NOTIFY_ITEMS, DIMS,
    }
  },
  template: `<div class="list settings panel-set">
      <template v-if="catKey === 'me'">
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
      <template v-if="catKey === 'accounts'">
        <div class="acct-set">
          <login-panel></login-panel>
          <cloud-invite-panel></cloud-invite-panel>
          <section class="set-card" aria-label="Claude 帳號">
            <header class="vendor-h"><b>Claude 帳號</b><small>Anthropic</small></header>
            <ul class="acct-list" v-if="st.accounts.list.length">
              <li v-for="a in st.accounts.list" :key="a.email">
                <span class="acct-txt"><span class="acct-name">{{ a.email }}<em v-if="a.current">使用中</em></span><small v-if="a.plan">{{ a.plan }}</small></span>
                <button class="aero-btn" type="button" @click="act('acct-switch', a.email)" :disabled="st.accounts.busy || a.current">切換</button>
                <button class="aero-btn" type="button" @click="act('acct-remove', a.email)" :disabled="st.accounts.busy">{{ st.accounts.confirmDel === a.email ? '確認刪除' : '刪除' }}</button>
              </li>
            </ul>
            <small v-else>還沒有加入過帳號。</small>
            <small v-if="st.accounts.current && !st.accounts.current.saved" class="acct-warn">目前登入的 {{ st.accounts.current.email }} 還沒加入帳號庫，切換到別的帳號前請先加入。</small>
            <small v-else-if="!st.accounts.current">這台電腦目前沒有 Claude 登入。</small>
            <div class="acct-add"><button class="aero-btn" type="button" @click="act('acct-add')" :disabled="st.accounts.busy || !st.accounts.current">加入目前登入的帳號</button></div>
            <label class="chk"><input type="checkbox" :checked="st.accounts.autoAdd" @change="act('acct-auto', $event.target.checked)" /><span>自動加入</span></label>
            <small v-if="st.accounts.autoNote" role="status">{{ st.accounts.autoNote }}</small>
            <small role="status">{{ st.accounts.msg }}</small>
            <small v-if="st.accounts.mod" role="status">{{ st.accounts.mod }}</small>
          </section>
          <section class="set-card" aria-label="OpenAI（Codex）帳號">
            <header class="vendor-h"><b>OpenAI（Codex）帳號</b><small>OpenAI</small></header>
            <div class="acct-txt"><span class="acct-name">{{ st.accounts.codexLine }}</span></div>
            <small>切換尚未支援，目前只顯示現在登入的帳號。</small>
          </section>
          <section class="set-card" aria-label="遠端設備">
            <header class="vendor-h"><b>遠端設備</b><small>切換別台電腦的 Claude 帳號</small></header>
            <label>設備
              <select class="set-sel" :value="st.accounts.remote.node" @change="act('acct-remote-node', $event.target.value)" aria-label="遠端設備">
                <option value="">請選擇…</option>
                <option v-for="d in st.accounts.remote.devices" :key="d.key" :value="d.key">{{ d.label }}</option>
              </select>
            </label>
            <small v-if="!st.accounts.remote.devices.length">目前沒有其他在線的設備（對方要開著 ASN）。</small>
            <ul class="acct-list" v-if="st.accounts.remote.list.length">
              <li v-for="a in st.accounts.remote.list" :key="a.email">
                <span class="acct-txt"><span class="acct-name">{{ a.email }}<em v-if="a.current">使用中</em></span><small v-if="a.plan">{{ a.plan }}</small></span>
                <button class="aero-btn" type="button" @click="act('acct-remote-switch', a.email)" :disabled="st.accounts.remote.busy || a.current">切換</button>
              </li>
            </ul>
            <small role="status">{{ st.accounts.remote.loading ? '讀取中…' : st.accounts.remote.msg }}</small>
            <label class="chk"><input type="checkbox" :checked="st.accounts.trustOwn" @change="act('acct-trust', $event.target.checked)" /><span>信任我自己的設備，別台要求切換這台時不用確認</span></label>
            <small>預設會在這台跳出確認，按了同意才會切換。指令只帶 email，權杖不會經過收發室。</small>
          </section>
          <section class="set-card" v-for="v in OTHER_VENDORS" :key="v.key" :aria-label="v.title">
            <header class="vendor-h"><b>{{ v.title }}</b><small>{{ VENDOR_UNSUPPORTED }}</small></header>
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
        <section class="set-card" aria-label="收發室" v-if="st.bridge">
          <label class="chk"><input type="checkbox" :checked="st.bridge.enabled" :disabled="st.bridge.busy" @change="act('bridge-enable', $event.target.checked)" aria-label="讓 ASN 負責這台的收發室" /><span>讓 ASN 負責這台的收發室</span></label>
          <label class="chk"><input type="checkbox" :checked="st.bridge.remoteLaunch" :disabled="st.bridge.busy" @change="act('bridge-launch', $event.target.checked)" aria-label="允許我的其他設備替這台開新視窗" /><span>允許我的其他設備替這台開新視窗</span></label>
          <label>沒指定收件人的信交給
            <input class="set-sel" type="text" maxlength="100" :value="st.bridge.unaddressedTo" :disabled="st.bridge.busy" placeholder="留空＝交給我本人" @change="act('bridge-unaddressed', $event.target.value)" aria-label="沒指定收件人的信交給哪個視窗" />
          </label>
          <small>寄來的信沒有指定收件視窗時，預設交給你本人，在對話裡顯示為「未指定收件人」。指定的視窗不在線時也會交給你本人。</small>
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
        <section class="set-card" aria-label="寄信指令" v-if="st.cli">
          <small>Claude 視窗用這個命令列寄信、收信、看群組、下載附件，不必另外安裝任何東西：</small>
          <code class="set-code">{{ st.cli.path }}</code>
          <code class="set-code">{{ st.cli.example }}</code>
          <button class="aero-btn" type="button" @click="act('cli-copy')">{{ st.cli.copied ? '已複製' : '複製寄信指令' }}</button>
        </section>
        <section class="set-card" aria-label="密碼小幫手" v-if="st.askpass">
          <small>git 或 ssh 要密碼時由 ASN 跳窗請你輸入，密碼不會經過 AI。想用的話，在終端機執行下面這行（只對之後開的視窗生效；ASN 不會自動改你的設定）：</small>
          <code class="set-code">{{ st.askpass.example }}</code>
          <button class="aero-btn" type="button" @click="act('askpass-copy')">{{ st.askpass.copied ? '已複製' : '複製路徑' }}</button>
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
          <label>每小時開新夥伴上限
            <input class="set-input" type="number" min="1" max="20" :value="st.launch.maxPerHour" @change="act('launch-max', Number($event.target.value))">
          </label>
          <label>工作資料夾白名單（一行一個）
            <textarea class="set-area" rows="4" :value="st.launch.cwdText" @change="act('launch-cwd', $event.target.value)"></textarea>
          </label>
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
