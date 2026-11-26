// 替別台電腦開新夥伴時的「型號」下拉（#2355 P4）：手機與電腦版共用這一份判斷，畫面只負責擺。純函式，node 與瀏覽器都能跑。
// 清單來源是那台回報的摘要（launcher.models，經 modelState 整理）；讀取、再問、「再查一次」由 local-models.mjs 的 createModelLoader（where: 'remote'）負責。
import { NONE_TEXT, PENDING_TEXT } from './remote-models.mjs'
import { launchModelChoices } from './model-catalog.mjs'
import { localProfileEngine } from './partner-launch-ui.mjs'

/**
 * 這次要開的那一家，在那台電腦上有沒有型號下拉。回 { show, kind: 'aliases'|'list'|'', vendor, models, note }（同 launchModelChoices）：
 *  - 那一家／開法本來就不能帶型號（asn終端、經 pi、Codex、Grok）：show false、沒有說明
 *  - 沒寫 engine 的自訂設定：show false，說明為什麼（launchModelChoices 的 NO_ENGINE_NOTE）
 *  - 那台沒有回報 launch_model（舊版 ASN，後台會擋成「不支援指定型號」）：show false，寫一句說明，不讓使用者選了才失敗
 *  - Claude：別名；Gemini：kind 'list'，清單要向 loader 要（models 先給空的）
 * row：廠牌卡（launchVendorCards 的一列，id 與 profileId）；run：autoRunFor 決定的開法。
 */
export function remoteLaunchModelChoice(launcher, row, run) {
  const c = launchModelChoices(row?.id, run, { engine: localProfileEngine(row?.profileId, launcher) })
  if (!c.show) return c
  if (launcher?.launch_model !== true) return { show: false, kind: '', vendor: '', models: [], note: NONE_TEXT }
  return c
}

/**
 * choice（remoteLaunchModelChoice 或本機的 launchModelChoices）加上 loader 的讀取結果 → 畫面要的下拉狀態。
 * 回 { ...choice, models, note, canRetry, retryLabel }；kind 不是 'list' 的不看 view。還沒讀到 view 時顯示「正在讀取」。
 */
export function launchModelView(choice, view) {
  if (choice?.kind !== 'list') return { ...choice, canRetry: false, retryLabel: '' }
  return {
    ...choice,
    models: view?.models ?? [],
    note: view?.note ?? PENDING_TEXT,
    canRetry: Boolean(view?.canRetry) && !view?.loading,
    retryLabel: view?.retryLabel || '',
  }
}

/** 使用者選的型號，必須還在目前的清單裡才算數（清單換了、換了廠牌都不能偷帶舊的）；不在就回空字串＝不指定 */
export const pickedModel = (view, picked) => (view?.show && Array.isArray(view.models) && view.models.some(m => m.id === picked) ? picked : '')
