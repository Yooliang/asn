// 冒煙探測「電腦版看終端檢查」（probe.dtermTab）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
import { dtermTabProbeSource } from '../smoke-desk-term.mjs'

export default {
  key: 'dtermTab',
  kind: '電腦版看終端檢查',
  source: probe => dtermTabProbeSource(probe.dtermTab),
}
