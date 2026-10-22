// 安卓「自行安裝版」發版（release-android.mjs）用到的純邏輯：APK 檔名、網址、android.json、versionCode。不碰檔案系統、不碰金鑰。
import { UPDATE_BASE, changelogFirstSection } from './release-lib.mjs'

export const ANDROID_JSON = 'android.json'
export const androidApkName = version => `ASN_${version}_android.apk`
export const androidApkUrl = version => `${UPDATE_BASE}${encodeURIComponent(androidApkName(version))}`

// 與 Tauri 的 Android versionCode 同一套算法（也與 src-tauri/src/android_update.rs 的 version_code_of 一致）：主 × 1,000,000 ＋ 次 × 1,000 ＋ 修訂
export function versionCodeOf(version) {
  const m = /^(\d{1,4})\.(\d{1,3})\.(\d{1,3})$/.exec(String(version))
  if (!m) throw new Error(`版本號格式不對：${version}`)
  return Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3])
}

// 更新說明：參數優先，其次 CHANGELOG 最新一段，都沒有給預設句
export const androidNotes = ({ arg, changelog, version }) => String(arg ?? '').trim() || changelogFirstSection(changelog) || `ASN ${version} 更新`

// App 端（android_update.rs 的 parse_manifest）會嚴格檢查這份：sha256 要 64 位小寫十六進位、版本碼要與版本號一致
export function buildAndroidJson({ version, notes, sha256, bytes }) {
  if (!/^[0-9a-f]{64}$/.test(String(sha256))) throw new Error('sha256 格式不對（要 64 位小寫十六進位）')
  if (!Number.isInteger(bytes) || bytes <= 0) throw new Error('APK 大小不對')
  return { version, versionCode: versionCodeOf(version), url: androidApkUrl(version), sha256, notes: String(notes ?? '').trim(), bytes }
}

export const parseAndroidArgs = argv => {
  const o = { notes: '', dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--notes') { o.notes = argv[++i] ?? ''; if (!o.notes) throw new Error('--notes 後面要接說明文字') }
    else if (a.startsWith('--notes=')) o.notes = a.slice(8)
    else throw new Error(`不認得的參數：${a}`)
  }
  return o
}
