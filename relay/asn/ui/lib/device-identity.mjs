// 設備詳情的「辨認區」（#1829）：讓人一眼認得這是哪一台——名字、建立時間、平台、最後在線時間、代號末 4 碼。
// 電腦、手機、網頁共用這一份：文字、整理資料的規則（名字空白時的線索、時間怎麼寫）、畫面元件都只在這裡。
// 資料都是現有的：名單成員（nodeFacts：建立時間、最後在線）、後台回報的平台、節點代號；建立時間後台沒給就整列不放；最後在線沒有紀錄寫「沒有紀錄」。
import { agoText } from './cloud-invite.mjs'

export const IDENTITY_TEXT = Object.freeze({
  title: '這台是哪一台',
  created: '建立時間',
  platform: '平台',
  seen: '最後在線',
  code: '代號',
  version: 'ASN 版本',
  reported: '帳號最後回報',
  online: '現在在線',
  noRecord: '沒有紀錄',
})

export const PLATFORM_TEXT = Object.freeze({ windows: 'Windows', macos: 'macOS', linux: 'Linux', android: 'Android', ios: 'iOS' })

/** 節點代號末 4 碼（只給辨認用；英數字以外的不算、轉大寫）。不足 4 碼就整串 */
export const nodeTail = node => String(node ?? '').replace(/[^0-9a-z]/gi, '').slice(-4).toUpperCase()

/**
 * 名字空白（或後台給的名字不合格）時的辨認線索：「電腦（X7K2）」「手機（Q9Z8）」。
 * 全畫面（設備列表、頁籤、群組分組、通知寄件者、詳情標題）都從這一個函式來；平台另外在詳情的「平台」那一列。
 * 設備名本身只有 deviceNameOf 一個來源，這裡只在它回空字串時才被用到
 */
export const unnamedClue = ({ phone = false, node = '' } = {}) => {
  const kind = phone ? '手機' : '電腦'
  const tail = nodeTail(node)
  return tail ? `${kind}（${tail}）` : kind
}

const pad = n => String(n).padStart(2, '0')
/** 「2026/11/05 14:32」（本機時區） */
export const dateTimeText = ms => {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 一台設備的辨認資料。
 *   named：後台記的名字合格（不合格或空白＝false，標題改用辨認線索）
 *   createdMs／seenMs：名單成員的建立時間、最後在線（毫秒；沒有＝0）
 *   online：現在是不是在線（本機一律在線）；version：本機的 ASN 版本（只有這台自己知道）
 * 回 { title, named, rows:[{ key, label, value }] }。每一列都有值（沒有資料寫「沒有紀錄」）
 */
export function deviceIdentity({ node = '', label = '', named = false, platform = '', phone = false, online = false, createdMs = 0, seenMs = 0, version = '', reported = '', now = Date.now() } = {}) {
  const T = IDENTITY_TEXT
  const title = named ? label : unnamedClue({ phone, node })
  const pText = PLATFORM_TEXT[String(platform ?? '').toLowerCase()] ?? ''
  const seenAgo = seenMs ? agoText(new Date(seenMs).toISOString(), now) : ''
  const seen = online ? T.online : (seenMs ? `${dateTimeText(seenMs)}${seenAgo ? `（${seenAgo}）` : ''}` : T.noRecord)
  const rows = [
    ...(createdMs ? [{ key: 'created', label: T.created, value: dateTimeText(createdMs) }] : []),   // 後台沒給建立時間就整列不放（#1829 領隊拍板）
    ...(pText ? [{ key: 'platform', label: T.platform, value: pText }] : []),   // 平台拿不到就整列不放（使用者看了做不了什麼）
    { key: 'seen', label: T.seen, value: seen },
    { key: 'code', label: T.code, value: nodeTail(node) || T.noRecord },
  ]
  if (reported) rows.push({ key: 'reported', label: T.reported, value: String(reported) })
  if (version) rows.push({ key: 'version', label: T.version, value: String(version) })
  return { title, named: Boolean(named), rows }
}

/** 畫面元件：<device-identity :identity="curDev.identity" :note="…">（電腦版設定頁、手機設備頁共用；樣式 .dvid 在 style.css） */
export const DeviceIdentity = {
  name: 'DeviceIdentity',
  props: { identity: { type: Object, required: true }, note: { type: String, default: '' } },
  setup(props) {
    const { h } = globalThis.Vue
    return () => h('div', { class: 'dvid', role: 'group', 'aria-label': IDENTITY_TEXT.title }, [
      h('dl', { class: 'dvid-kv' }, (props.identity?.rows ?? []).flatMap(r => [
        h('dt', { key: `${r.key}-t` }, r.label),
        h('dd', { key: `${r.key}-d`, class: ['dvid-v', `dvid-${r.key}`] }, r.value),
      ])),
      props.note ? h('p', { class: 'dvid-note' }, props.note) : null,
    ])
  },
}
