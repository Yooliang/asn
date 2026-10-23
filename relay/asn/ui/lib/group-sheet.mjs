// 群組的對話框畫面（建立群組、邀請別人、加入群組、成員與設定）與「待主持人確認」卡片。電腦版與手機版共用。
// 只顯示、只呼叫 flow（lib/group-flow.mjs）的方法；不碰網路與 Tauri。畫面上不出現任何節點代號、成員鍵或 x: 代號。
import { INVITE_NOTE, PRIVACY_NOTE, SEED_MAX, GROUP_NAME_MAX } from './groups.mjs'

const { computed } = Vue
const TITLE = { create: '建立群組', invite: '邀請別人加入', join: '加入群組', manage: '成員與設定' }

export const GroupSheet = {
  name: 'GroupSheet',
  props: { flow: { type: Object, required: true } },
  setup(props) {
    const s = props.flow.state
    const title = computed(() => (s.view === 'manage' && s.roomName ? `${s.roomName}：成員與設定` : TITLE[s.view] ?? ''))
    const fmtTime = t => (t ? new Date(t).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')
    const onSeed = ev => props.flow.setSeed(ev.target.value)
    return { s, title, fmtTime, onSeed, INVITE_NOTE, PRIVACY_NOTE, SEED_MAX, GROUP_NAME_MAX }
  },
  template: `
<div class="gs-back" v-if="s.view" @click.self="flow.close()" @keydown.esc="flow.close()">
  <section class="gs-panel" role="dialog" aria-modal="true" :aria-label="title">
    <header class="gs-head"><h2 class="gs-title">{{ title }}</h2><button class="gs-x" type="button" aria-label="關閉" @click="flow.close()">✕</button></header>
    <div class="gs-body">

      <template v-if="s.view === 'create'">
        <label class="gs-field">群組名稱
          <input class="gs-input" v-model="s.name" :maxlength="GROUP_NAME_MAX" autocomplete="off" spellcheck="false" placeholder="例如：財務小組" @keydown.enter.prevent="flow.submitCreate()">
        </label>
        <fieldset class="gs-fs" v-if="s.choices.length">
          <legend>要帶進群組的我的夥伴（可以不選）</legend>
          <label class="gs-pick" v-for="c in s.choices" :key="c.key">
            <input type="checkbox" :checked="s.picks.includes(c.key)" @change="flow.togglePick(c.key)">
            <span class="gs-pick-name">{{ c.label }}</span><small class="gs-sub" v-if="c.device">{{ c.device }}</small><small class="gs-sub off" v-if="c.status === 'offline'">離線</small>
          </label>
        </fieldset>
        <p class="gs-note" v-else>名單上還沒有你的夥伴，先建立空群組也可以，之後再邀請別人或帶夥伴進來。</p>
        <p class="gs-note">{{ PRIVACY_NOTE }}</p>
      </template>

      <template v-else-if="s.view === 'invite'">
        <template v-if="s.step === 'confirm'">
          <p class="gs-lead">{{ s.lead }}</p>
          <label class="gs-field gs-seed" v-if="s.target && s.target.type === 'friend'">複製最近幾則（0 到 {{ SEED_MAX }}）
            <input class="gs-input gs-num" type="number" inputmode="numeric" min="0" :max="SEED_MAX" :value="s.seed" aria-label="複製最近幾則" @input="onSeed">
          </label>
          <ol class="gs-seedlist" v-if="s.preview.length" aria-label="對方會看到的內容">
            <li v-for="(m, i) in s.preview" :key="i"><b>{{ m.who }}</b><span>{{ m.text }}</span></li>
          </ol>
          <p class="gs-note" v-else-if="s.target && s.target.type === 'friend' && s.seed > 0">這段對話在這台裝置上沒有可預覽的內容（實際複製的是雲端上最近的紀錄）。</p>
          <p class="gs-note">{{ PRIVACY_NOTE }}</p>
        </template>
        <template v-else-if="s.step === 'link' && s.link">
          <p class="gs-lead">把這個連結傳給要邀請的人：</p>
          <input class="gs-input gs-link" readonly :value="s.link.link" aria-label="邀請連結" @focus="$event.target.select()">
          <p class="gs-note"><b>{{ INVITE_NOTE }}</b>用掉就失效。<template v-if="s.link.expiresAt">到期：{{ fmtTime(s.link.expiresAt) }}。</template>也可以直接傳邀請碼：<code class="gs-code">{{ s.link.code }}</code></p>
        </template>
        <p class="gs-lead" v-else-if="s.step === 'revoked'">邀請已撤銷，這個連結不能再用了。</p>
      </template>

      <template v-else-if="s.view === 'join'">
        <template v-if="s.step === 'input'">
          <label class="gs-field">邀請連結或邀請碼
            <input class="gs-input" v-model="s.input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="貼上 https://asnmessenger.web.app/i/… 或 asn://invite/…" @keydown.enter.prevent="flow.lookup()">
          </label>
        </template>
        <template v-else-if="s.step === 'preview' && s.join">
          <p class="gs-lead">{{ s.join.lead }}</p>
          <p class="gs-note" v-if="s.join.expiresAt">邀請到期：{{ fmtTime(s.join.expiresAt) }}</p>
          <p class="gs-note">{{ PRIVACY_NOTE }}</p>
        </template>
      </template>

      <template v-else-if="s.view === 'manage'">
        <p class="gs-note" v-if="s.external">這個群組有外部成員（別的帳號），暫時不能傳附件。</p>
        <h3 class="gs-h">真人</h3>
        <ul class="gs-members">
          <li v-for="m in s.members.filter(x => x.kind === 'human')" :key="m.ref"><span class="gs-av human" aria-hidden="true">{{ m.label.slice(0, 1) }}</span><span class="gs-name">{{ m.label }}</span><small class="gs-badge" v-if="m.host">主持人</small><small class="gs-badge" v-if="m.mine">你</small></li>
        </ul>
        <h3 class="gs-h">AI 夥伴</h3>
        <ul class="gs-members">
          <li v-for="m in s.members.filter(x => x.kind === 'ai')" :key="m.ref">
            <span class="gs-av ai" aria-hidden="true">{{ m.label.slice(0, 1) }}</span><span class="gs-name">{{ m.label }}</span>
            <template v-if="m.mine">
              <label class="gs-allow"><input type="checkbox" :checked="m.allowOthers" :disabled="s.busy" @change="flow.setAllow(m.ref, $event.target.checked)">接受別人點名</label>
              <button class="gs-btn small" type="button" :disabled="s.busy" @click="flow.removeAi(m.ref)">移出</button>
            </template>
          </li>
          <li class="gs-empty" v-if="!s.members.some(x => x.kind === 'ai')">還沒有 AI 夥伴。</li>
        </ul>
        <template v-if="s.addable.length">
          <h3 class="gs-h">帶我的夥伴進來</h3>
          <ul class="gs-members">
            <li v-for="a in s.addable" :key="a.key"><span class="gs-av ai" aria-hidden="true">{{ a.label.slice(0, 1) }}</span><span class="gs-name">{{ a.label }}</span><button class="gs-btn small" type="button" :disabled="s.busy" @click="flow.addAi(a.key)">帶進來</button></li>
          </ul>
        </template>
        <p class="gs-note">{{ PRIVACY_NOTE }}</p>
        <p class="gs-warn" v-if="s.leaving">確定要退出這個群組嗎？你和你帶進來的夥伴都會一起退出。</p>
      </template>

      <p class="gs-err" v-if="s.error" role="alert">{{ s.error }}</p>
      <p class="gs-note" v-if="s.note" role="status">{{ s.note }}</p>
    </div>

    <footer class="gs-foot">
      <template v-if="s.view === 'create'">
        <button class="gs-btn" type="button" @click="flow.close()">取消</button>
        <button class="gs-btn primary" type="button" :disabled="s.busy || !!flow.createProblem()" @click="flow.submitCreate()">{{ s.busy ? '建立中…' : '建立' }}</button>
      </template>
      <template v-else-if="s.view === 'invite'">
        <template v-if="s.step === 'confirm'">
          <button class="gs-btn" type="button" @click="flow.close()">取消</button>
          <button class="gs-btn primary" type="button" :disabled="s.busy" @click="flow.confirmInvite()">{{ s.busy ? '產生中…' : '確認，產生邀請連結' }}</button>
        </template>
        <template v-else-if="s.step === 'link'">
          <button class="gs-btn danger" type="button" :disabled="s.busy" @click="flow.revokeInvite()">撤銷這個邀請</button>
          <button class="gs-btn primary" type="button" @click="flow.copyLink()">{{ s.copied ? '已複製' : '複製' }}</button>
        </template>
        <button class="gs-btn primary" type="button" v-else @click="flow.close()">完成</button>
      </template>
      <template v-else-if="s.view === 'join'">
        <button class="gs-btn" type="button" @click="flow.close()">取消</button>
        <button class="gs-btn primary" type="button" v-if="s.step === 'input'" :disabled="s.busy || !s.input.trim()" @click="flow.lookup()">{{ s.busy ? '查詢中…' : '查看邀請' }}</button>
        <button class="gs-btn primary" type="button" v-else :disabled="s.busy" @click="flow.acceptInvite()">{{ s.busy ? '加入中…' : '加入群組' }}</button>
      </template>
      <template v-else-if="s.view === 'manage'">
        <template v-if="s.leaving">
          <button class="gs-btn" type="button" @click="flow.cancelLeave()">先不要</button>
          <button class="gs-btn danger" type="button" :disabled="s.busy" @click="flow.leave()">退出群組</button>
        </template>
        <template v-else>
          <button class="gs-btn danger" type="button" @click="flow.askLeave()">退出群組</button>
          <button class="gs-btn primary" type="button" @click="flow.close()">完成</button>
        </template>
      </template>
    </footer>
  </section>
</div>`,
}

// 群組裡 AI 發出的「待主持人確認」請求：主持人看到卡片和「同意」「拒絕」，其他人只看到狀態
export const ConfirmCards = {
  name: 'ConfirmCards',
  props: { cards: { type: Array, default: () => [] }, busy: { type: Boolean, default: false } },
  emits: ['decide'],
  template: `
<div class="gc-list" v-if="cards.length" aria-label="待主持人確認的請求">
  <article class="gc-card" v-for="c in cards" :key="c.id" :class="'is-' + c.status">
    <div class="gc-top"><b class="gc-kind">{{ c.kindLabel }}</b><span class="gc-st">{{ c.statusText }}</span></div>
    <p class="gc-sum">{{ c.summary }}</p>
    <div class="gc-who">請求的夥伴：{{ c.requester }}</div>
    <div class="gc-act" v-if="c.canDecide">
      <button class="gs-btn" type="button" :disabled="busy" @click="$emit('decide', c.id, false)">拒絕</button>
      <button class="gs-btn primary" type="button" :disabled="busy" @click="$emit('decide', c.id, true)">同意</button>
    </div>
    <div class="gc-wait" v-else-if="c.status === 'pending'">要由主持人確認，確認前這位夥伴不會執行。</div>
  </article>
</div>`,
}