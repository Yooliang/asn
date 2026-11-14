// 外觀（0.2.18）：「復古 Aero」「現代」二選一；0.2.22 起多第三種「LINE」（三選一）。兩套共用同一份畫面結構（同一個元件、同一組按鈕順序），只換樣式表與圖示；切換不用重開。
// 套用的方式：<html data-skin="modern">，現代風格的規則都寫在 modern.css 的 :root[data-skin="modern"] 底下；復古 Aero 就是原本的 style.css。
// 每個視窗（名單、對話、設定、提示…）各自開，所以選擇另外記在 localStorage（同一個程式的視窗共用），skin-boot.js 在畫面出來之前就先套上，不會閃一下；
// 別的視窗改了，storage 事件會通知這個視窗跟著換。正式的設定仍存在設定檔（電腦 me 存檔、手機 mobilePrefs）。
export const SKINS = ['aero', 'modern', 'line']
export const SKIN_LABEL = { aero: '復古 Aero（原本的樣子）', modern: '現代', line: 'LINE 風格' }
export const SKIN_SHORT = { aero: '復古 Aero', modern: '現代', line: 'LINE 風格' }   // 設定分類的一行摘要用
export const DEFAULT_SKIN = 'aero'   // 舊使用者升級後維持原本的樣子，要換自己到「設定 → 外觀」選
export const SKIN_KEY = 'asnSkin'
export const normalizeSkin = v => (SKINS.includes(v) ? v : DEFAULT_SKIN)

const store = () => { try { return globalThis.localStorage ?? null } catch { return null } }

/** 套用到這個視窗並記下來（讓其他視窗與下次開啟一開始就是這一套） */
export function applySkin(v, { doc = globalThis.document, storage = store() } = {}) {
  const s = normalizeSkin(v)
  if (doc?.documentElement) doc.documentElement.dataset.skin = s
  try { if (storage && storage.getItem(SKIN_KEY) !== s) storage.setItem(SKIN_KEY, s) } catch {}
  return s
}

/** 視窗開啟時：讀記下來的那一套，並在別的視窗改了時跟著換；回傳目前這一套 */
export function initSkin({ doc = globalThis.document, storage = store(), win = globalThis.window } = {}) {
  let cur = DEFAULT_SKIN
  try { cur = normalizeSkin(storage?.getItem(SKIN_KEY)) } catch {}
  if (doc?.documentElement) doc.documentElement.dataset.skin = cur
  win?.addEventListener?.('storage', e => { if (e?.key === SKIN_KEY && doc?.documentElement) doc.documentElement.dataset.skin = normalizeSkin(e.newValue) })
  return cur
}

/**
 * 依外觀算「實際生效」的頭像模式與文字底色（只在讀的時候用，絕不寫回存檔）：
 * LINE 外觀固定「頭像在泡泡旁（inline）、底色自動（auto）」，其他外觀照使用者自己的值。
 * 純函式：不改輸入；使用者切回復古 Aero／現代時，自己原本的設定完好如初。
 */
export const effectiveLook = (skin, look) => (skin === 'line' ? { ...look, dpMode: 'inline', bubble: 'auto' } : { ...look })
