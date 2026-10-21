// 發版腳本（release.mjs）用到的純邏輯，獨立出來好測：latest.json 內容、更新說明、安裝檔名與網址。
// 不碰檔案系統、不碰金鑰。

export const UPDATE_BASE = 'https://asnmessenger.web.app/update/'
export const PLATFORM = 'windows-x86_64'

// 更新說明：參數優先；沒有就取 CHANGELOG 的第一段（第一個「## 」標題底下到下一個標題前）；都沒有給預設句
export const changelogFirstSection = text => {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(l => /^##\s/.test(l))
  if (start < 0) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(l => /^##\s/.test(l))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim()
}
export const pickNotes = ({ arg, changelog, version }) => {
  const a = String(arg ?? '').trim()
  if (a) return a
  const c = changelogFirstSection(changelog)
  return c || `ASN ${version} 更新`
}

export const installerName = version => `ASN_${version}_x64-setup.exe`
export const installerUrl = version => `${UPDATE_BASE}${encodeURIComponent(installerName(version))}`

// 外掛要求的 latest.json（Tauri 2 靜態格式）：version、notes、pub_date（RFC 3339）、platforms.<目標>.{ signature, url }
export const buildLatestJson = ({ version, notes, pubDate, signature }) => {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`版本號格式不對：${version}`)
  const sig = String(signature ?? '').trim()
  if (!sig) throw new Error('簽章是空的（.sig 檔沒有內容）')
  const when = pubDate instanceof Date ? pubDate : new Date(pubDate)
  if (Number.isNaN(when.getTime())) throw new Error('發佈時間格式不對')
  return {
    version,
    notes: String(notes ?? '').trim(),
    pub_date: when.toISOString(),
    platforms: { [PLATFORM]: { signature: sig, url: installerUrl(version) } },
  }
}

// 命令列：--dry-run（不 bump、不寫進官網目錄）、--notes "<說明>"、--no-bump（沿用目前版本但照常寫進官網目錄）
export const parseArgs = argv => {
  const o = { dryRun: false, noBump: false, notes: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--no-bump') o.noBump = true
    else if (a === '--notes') { o.notes = argv[++i] ?? ''; if (!o.notes) throw new Error('--notes 後面要接說明文字') }
    else if (a.startsWith('--notes=')) o.notes = a.slice(8)
    else throw new Error(`不認得的參數：${a}`)
  }
  return o
}
