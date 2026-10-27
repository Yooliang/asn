// 開新夥伴「經 pi」（#351）：廠牌 → pi 提供者、這家能不能經 pi、有哪些模型、開 pi 時帶什麼參數。純邏輯，node 與瀏覽器都能跑。
// 資料來源是後端 pi_models（pi --list-models 解析）與 pi_providers（pi auth check --json，不帶 --credentials）；清單依這台設定的憑證而變，打開對話框時才查，不寫死。
// pi 1.4.0 沒有 Qwen；Gemini 的訂閱登入已被拿掉，所以不建議經 pi（#748）。

/** 廠牌（目錄 id，或只能經 pi 的廠牌 id）→ pi 的提供者名稱 */
export const VENDOR_PI_PROVIDER = Object.freeze({ claude: 'anthropic', codex: 'openai-codex', grok: 'xai', deepseek: 'deepseek', minimax: 'minimax', aegis: 'aegis' })
/** 只能經 pi 開的廠牌（目錄上沒有自己的 CLI 列）；只有 pi 真的列得到它的模型時才出現在廠牌清單 */
export const PI_ONLY_VENDORS = Object.freeze([{ id: 'deepseek', label: 'DeepSeek' }, { id: 'minimax', label: 'MiniMax' }])

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/   // 提供者與模型名稱只收這些字元，避免把奇怪字串帶進啟動參數

/** 後端 pi_models 的回應 → 乾淨的 [{ provider, model, thinking, images }]；壞資料丟掉 */
export function cleanPiModels(list) {
  const out = [], seen = new Set()
  for (const m of Array.isArray(list) ? list : []) {
    const provider = String(m?.provider ?? '').trim(), model = String(m?.model ?? '').trim()
    if (!SAFE.test(provider) || !SAFE.test(model) || seen.has(`${provider}/${model}`)) continue
    seen.add(`${provider}/${model}`)
    out.push({ provider, model, thinking: m?.thinking === true || m?.thinking === 'yes', images: m?.images === true || m?.images === 'yes' })
  }
  return out
}

/**
 * 某廠牌經 pi 的狀態。providers：後端 pi_providers 的回應 { [provider]: 'ready'|'not_ready'|'provider_not_found' }（沒查到的當未知）。
 * 回 { provider, ok, why, models: [...], defaultModel }
 */
export function piChoiceFor(vendorId, models, providers = {}) {
  const provider = VENDOR_PI_PROVIDER[vendorId] ?? ''
  if (!provider) return { provider: '', ok: false, why: vendorId === 'gemini' ? 'pi 已拿掉 Gemini 訂閱登入，不建議經 pi' : '這一家不能經 pi', models: [], defaultModel: '' }
  const status = providers?.[provider]
  if (status === 'provider_not_found') return { provider, ok: false, why: `這版 pi 沒有 ${provider}`, models: [], defaultModel: '' }
  const mine = cleanPiModels(models).filter(m => m.provider === provider)
  if (status === 'not_ready' || (!mine.length && status !== 'ready')) return { provider, ok: false, why: `pi 還沒登入 ${provider}：先在終端開 pi 打 /login`, models: [], defaultModel: '' }
  if (!mine.length) return { provider, ok: false, why: `pi 沒有列出 ${provider} 的模型`, models: [], defaultModel: '' }
  return { provider, ok: true, why: '', models: mine, defaultModel: mine[0].model }
}

/** 廠牌清單要多出來的「只能經 pi」廠牌：pi 列得到模型的才出現 */
export function piOnlyVendorRows(models, providers = {}) {
  return PI_ONLY_VENDORS.filter(v => piChoiceFor(v.id, models, providers).ok).map(v => ({ ...v, viaPiOnly: true }))
}

/** 按「開啟」時帶給後端的 pi 參數；提供者或模型不在這次查到的清單裡就回 null（不送） */
export function piLaunchArgs(vendorId, model, models, providers = {}) {
  const c = piChoiceFor(vendorId, models, providers)
  if (!c.ok || !c.models.some(m => m.model === model)) return null
  return { provider: c.provider, model }
}
