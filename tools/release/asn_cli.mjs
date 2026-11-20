// 發版腳本叫 asn-cli 的接線（#1966）。
// asn-cli 裝在 %LOCALAPPDATA%\ASN\，通常不在 PATH：先照 PATH 找，找不到（ENOENT）再用安裝資料夾那支。
// 失敗時把 error.code 與 stderr 帶回來，log 才看得出是「找不到程式」還是「寄送被拒」。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/** Windows 安裝位置；其他平台或沒有 LOCALAPPDATA 時回 null */
export const installedAsnCli = (env, platform) =>
  platform === 'win32' && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'ASN', 'asn-cli.exe') : null

export function makeAsnCli({ spawn = spawnSync, env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const run = (bin, args) => spawn(bin, args, { encoding: 'utf8' })
  return args => {
    let r = run('asn-cli', args)
    let tried = ['asn-cli（PATH）']
    if (r.error?.code === 'ENOENT') {
      const alt = installedAsnCli(env, platform)
      if (alt && exists(alt)) { r = run(alt, args); tried = [...tried, alt] }
      else if (alt) tried = [...tried, `${alt}（不存在）`]
    }
    if (r.error) {
      const why = r.error.code === 'ENOENT' ? `找不到 asn-cli（試過：${tried.join('、')}）` : `asn-cli 無法執行（${r.error.code ?? r.error.message}）`
      return { status: 1, stdout: r.stdout ?? '', stderr: [why, r.stderr].filter(Boolean).join('\n') }
    }
    return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
  }
}

/** 失敗訊息：結束碼＋stderr 前 300 字（沒有 stderr 就只有結束碼） */
export const asnCliFail = r => {
  const err = String(r?.stderr ?? '').trim()
  return `結束碼 ${r?.status}${err ? `：${err.slice(0, 300)}` : ''}`
}
