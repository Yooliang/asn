// supabase/migrations 的版本號（檔名開頭那串數字）不能重複。
// 兩張 PR 各自綠、合起來才撞號時，這條靠「合併後的樹」跑 CI 才抓得到。檔名要含 _sql，CI 的根目錄測試才會跑到（見 asn-linux-build.yml）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const FILE = /^(\d{14})_.+\.sql$/

/** 檔名清單 → { bad：格式不對的檔名, dups：版本號重複的 [版本號, 檔名…] } */
function checkVersions(names) {
  const sql = names.filter(f => f.endsWith('.sql'))
  const byVersion = new Map()
  for (const f of sql) {
    const m = FILE.exec(f)
    if (m) byVersion.set(m[1], [...(byVersion.get(m[1]) ?? []), f])
  }
  return {
    bad: sql.filter(f => !FILE.test(f)),
    dups: [...byVersion].filter(([, files]) => files.length > 1).map(([v, files]) => [v, ...files]),
  }
}

test('檢查本身：認得重複與格式不對，非 .sql 的檔不管', () => {
  assert.deepEqual(checkVersions(['20261102140000_a.sql', '20261102150000_b.sql', 'README.md']), { bad: [], dups: [] })
  assert.deepEqual(checkVersions(['20261102140000_a.sql', '20261102140000_b.sql']).dups, [['20261102140000', '20261102140000_a.sql', '20261102140000_b.sql']])
  assert.deepEqual(checkVersions(['2026_a.sql', '20261102140000.sql']).bad, ['2026_a.sql', '20261102140000.sql'])
})

test('真實的 supabase/migrations：版本號都是 14 碼且不重複', () => {
  const names = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url))
  assert.ok(names.filter(f => f.endsWith('.sql')).length > 0, '讀不到任何 migration')
  assert.deepEqual(checkVersions(names), { bad: [], dups: [] })
})
