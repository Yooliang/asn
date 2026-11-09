// 官方登入網址主機白名單：五處同一份清單（#933 PR-5b，asn真 定案第 4 點）。
// 唯一來源：supabase/functions/_shared/login_domains.json（suffix＝本身或子網域、exact＝只收本身）。
// 五處：資料表約束、帶網址的 SQL 函式（同一個 migration 裡）、Edge 的 LINK_RE、Rust 的 secret_remote/link.rs（include_str! 讀 JSON）、手機畫面的 secret-ask.mjs。
// 有一處漏改就紅；正反例（login_link_cases.json）由各處自己的測試跑。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const D = JSON.parse(rd('supabase/functions/_shared/login_domains.json'))
const esc = d => d.replace(/\./g, '\\.')
const SQL_RULE = `^https://(([a-z0-9-]+\\.)*(${D.suffix.map(esc).join('|')})|${D.exact.map(esc).join('|')})(:443)?([/?#][\\x21-\\x5b\\x5d-\\x7e]*)?$`
// 最新一支定義登入網址規則的 migration（之後新增網域就是再加一支，這裡自動找最新的）
const latestRuleMigration = () => {
  const dir = new URL('../supabase/migrations/', import.meta.url)
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
  return files.filter(f => /secret_requests_link_ck/.test(fs.readFileSync(new URL(f, dir), 'utf8'))).pop()
}

test('清單本身：兩組都非空、沒有重複、都是小寫主機', () => {
  assert.ok(D.suffix.length >= 3 && D.exact.length >= 2)
  const all = [...D.suffix, ...D.exact]
  assert.equal(new Set(all).size, all.length)
  for (const h of all) assert.match(h, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, h)
})

test('SQL：最新一支規則 migration 的約束與函式，都等於清單產生的規則', () => {
  const f = latestRuleMigration()
  assert.equal(f, '20261111200000_setup_device_login.sql')
  assert.equal(rd(`supabase/migrations/${f}`).split(SQL_RULE).length - 1, 2)
})

test('Edge：LINK_RE 等於清單產生的規則', () => {
  const ts = rd('supabase/functions/_shared/secret_remote.ts')
  const m = ts.match(/export const LINK_RE = \/(.*)\/;/)
  assert.ok(m, '找不到 LINK_RE')
  assert.equal(m[1].replace(/\\\//g, '/'), SQL_RULE)
})

test('Rust：link.rs 編譯時讀這份 JSON，不另外寫主機清單', () => {
  const rs = rd('relay/asn/src-tauri/src/secret_remote/link.rs')
  assert.match(rs, /include_str!\("\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/supabase\/functions\/_shared\/login_domains\.json"\)/)
  const code = rs.slice(0, rs.indexOf('#[cfg(test)]'))
  for (const h of [...D.suffix, ...D.exact]) assert.ok(!code.includes(`"${h}"`), `link.rs 的程式碼不該自己寫 ${h}`)
})

test('手機畫面：secret-ask.mjs 的兩份清單等於 JSON', async () => {
  const m = await import('../relay/asn/ui/lib/secret-ask.mjs')
  assert.deepEqual(m.LOGIN_HOSTS, D.suffix)
  assert.deepEqual(m.LOGIN_EXACT_HOSTS, D.exact)
})
