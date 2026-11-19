// 設定頁測試用：把手寫的設備列補上 buildDeviceTree 一定會帶的 named／identity（#1829）。
import { deviceIdentity } from '../../ui/lib/device-identity.mjs'

export const withIdentity = d => ({
  named: true,
  ...d,
  identity: d.identity ?? deviceIdentity({ node: d.key, label: d.label, named: d.named !== false, platform: d.platform ?? '', phone: d.kind === '手機', cloud: d.cloud === true, online: d.online === true, version: d.version ?? '', reported: d.cloud ? '' : String(d.reportedText ?? '').replace(/^(帳號)?最後回報：/, '') }),
})
