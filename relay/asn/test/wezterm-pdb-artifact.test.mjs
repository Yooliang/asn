// #1896 ③ 自建 WezTerm 每次建置都把 PDB 存成 artifact（同一次建置產生，之後的崩潰傾印能直接符號化）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const W = fs.readFileSync(new URL('../../../.github/workflows/wezterm-build.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// 取一個 job 的整段（到下一個同層 job 為止）
const job = name => {
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, 'm').exec(W)
  assert.ok(m, `前提：workflow 有 ${name} 這個 job`)
  return m[1]
}
// 取一個步驟（從 "- name: X" 到下一個 "- name:" 或 "- uses:"）
const step = (src, title) => {
  const i = src.indexOf(`- name: ${title}`)
  assert.ok(i >= 0, `前提：有「${title}」這一步`)
  const rest = src.slice(i + 1)
  const j = rest.search(/\n {6}- (name|uses):/)
  return src.slice(i, j < 0 ? undefined : i + 1 + j)
}

test('#1896 ③ Windows 建置帶行號 PDB：export 在 cargo build 之前、同一個 run 區塊', () => {
  const b = step(job('build-windows'), '建置（需要 Strawberry Perl 給 openssl-sys）')
  const ex = b.indexOf('export CARGO_PROFILE_RELEASE_DEBUG=line-tables-only')
  const cb = b.indexOf('cargo build --locked --release -p wezterm -p wezterm-gui -p wezterm-mux-server')
  assert.ok(ex >= 0, '要設 CARGO_PROFILE_RELEASE_DEBUG=line-tables-only')
  assert.ok(cb > ex, 'export 要在 cargo build 之前')
})

test('#1896 ③ 收集 PDB：三支 exe 都要有對應的 PDB，且 exe 裡記著那個 PDB 名稱；附 exe／PDB 的 SHA-256', () => {
  const s = step(job('build-windows'), '收集 PDB（與打包的 exe 同一次建置）')
  assert.match(s, /for e in wezterm wezterm-gui wezterm-mux-server; do/)
  assert.match(s, /\[ -s "\$pdb" \] \|\| \{ echo "::error::/, '缺 PDB 或是空的要失敗')
  assert.match(s, /grep -qa "\$\{e\/\/-\/_\}\.pdb" "\$rel\/\$e\.exe" \|\| \{ echo "::error::/, 'exe 對不上 PDB 要失敗')
  assert.match(s, /EXE-SHA256SUMS\.txt/)
  assert.match(s, /PDB-SHA256SUMS\.txt/)
})

test('#1896 ③ 上傳 PDB：找不到就失敗、保留 90 天，名稱不會被發佈的 wezterm-* 撿進 release', () => {
  const j = job('build-windows')
  const s = step(j, '上傳 PDB')
  assert.match(s, /uses: actions\/upload-artifact@[0-9a-f]{40}/, 'action 要釘 SHA')
  assert.match(s, /if-no-files-found: error/)
  assert.match(s, /retention-days: 90/)
  const name = /name: (pdb-windows-\S+)/.exec(s)?.[1]
  assert.ok(name, '要有 artifact 名稱')
  assert.ok(!name.startsWith('wezterm-'), `PDB 的 artifact 名稱不能以 wezterm- 開頭（發佈用 pattern wezterm-* 會撿進 release）：${name}`)
  for (const p of [...W.matchAll(/pattern: '([^']+)'/g)].map(m => m[1])) {
    const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
    assert.ok(!re.test(name.replace(/\$\{\{[^}]*\}\}/g, 'x')), `下載 pattern ${p} 不能撿到 PDB artifact`)
  }
  // 收集要在上傳之前
  assert.ok(j.indexOf('- name: 收集 PDB') < j.indexOf('- name: 上傳 PDB'))
})
