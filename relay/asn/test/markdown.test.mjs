// 訊息內文 Markdown（issue #169）：XSS 淨化、各元素輸出、程式碼不換表情、震動與系統提示不走 Markdown、連結由外層攔下。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MD_TAGS, handleLinkClick, renderMarkdown as md, sanitize } from '../ui/lib/markdown.mjs'

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')

// 輸出裡每個標籤都必須在白名單內、屬性也是
function assertSafe(html, label) {
  for (const m of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)) {
    assert.ok(MD_TAGS[m[1].toLowerCase()], `${label}：出現白名單外的標籤 <${m[1]}>：${html}`)
    for (const a of m[2].matchAll(/\s([a-zA-Z-]+)=/g)) assert.ok(MD_TAGS[m[1].toLowerCase()].includes(a[1]), `${label}：出現白名單外的屬性 ${a[1]}：${html}`)
  }
  assert.ok(!/href="\s*(javascript|data|vbscript|file):/i.test(html), `${label}：危險連結`)
}

const XSS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<iframe src="https://evil.example"></iframe>',
  '<svg onload=alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  '[x](javascript:alert(1))',
  '[x](JaVaScRiPt:alert(1))',
  '[x](java\nscript:alert(1))',
  '[x](data:text/html;base64,PHNjcmlwdD4=)',
  '[x](vbscript:msgbox(1))',
  '[x](file:///C:/Windows/system32/calc.exe)',
  '[x](//evil.example/a)',
  '[x](&#106;avascript:alert(1))',
  '[x](&#x6A;avascript&colon;alert(1))',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '&#60;script&#62;alert(1)&#60;/script&#62;',
  '![img](https://evil.example/track.png)',
  '![img](x" onerror="alert(1))',
  '[x](https://a.com" onmouseover="alert(1))',
  '[x](https://a.com/"onclick=alert(1)//)',
  '<https://a.com" onclick="x>',
  '<style>*{display:none}</style>',
  '<div style="x" onclick="y">',
  '`<script>`  <b onclick=1>x</b>',
  '```\n<script>alert(1)</script>\n```',
  '| <img src=x onerror=1> | b |\n|-|-|\n| <script> | `x` |',
  '# <script>alert(1)</script>',
  '> <iframe>',
  '- <img src=x onerror=1>',
  '**<script>**</script>',
  '<a href="https://ok.com" onclick="x">y</a>',
  'x\u0000<script>',
]
test('XSS 樣本全部被淨化：沒有白名單外的標籤／屬性、沒有危險連結', () => {
  for (const s of XSS) {
    const h = md(s)
    assertSafe(h, s)
    assert.ok(!/<script|<iframe|<img|<svg|<style/i.test(h), `${s} → ${h}`)
  }
  // 尖括號被當文字顯示
  assert.equal(md('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
  assert.ok(md('&#60;script&#62;').includes('&amp;#60;'), '實體不會被還原')
  assert.ok(!md('![i](https://evil.example/t.png)').includes('<img'), '圖片不支援')
})

test('sanitize：違規輸出整段退回（null）', () => {
  for (const bad of ['<script>x</script>', '<p onclick="x">a</p>', '<a href="javascript:1" rel="noopener noreferrer nofollow">a</a>', '<img src="x">', '<p>a</p><', '<span class="evil">a</span>', '<a href="https://a.com" target="_blank">a</a>', '<p style="x">a</p>']) {
    assert.equal(sanitize(bad), null, bad)
  }
  assert.equal(sanitize('<p>ok <strong>x</strong></p>'), '<p>ok <strong>x</strong></p>')
})

test('行內元素：粗體、斜體、刪除線、行內程式碼、連結、自動連結、換行', () => {
  assert.equal(md('**粗** *斜* __粗2__ _斜2_ ~~刪~~'), '<p><strong>粗</strong> <em>斜</em> <strong>粗2</strong> <em>斜2</em> <del>刪</del></p>')
  assert.equal(md('***全***'), '<p><strong><em>全</em></strong></p>')
  assert.equal(md('用 `npm test` 跑'), '<p>用 <code>npm test</code> 跑</p>')
  assert.equal(md('[官網](https://example.com/a?x=1&y=2)'), '<p><a href="https://example.com/a?x=1&amp;y=2" rel="noopener noreferrer nofollow">官網</a></p>')
  assert.equal(md('看 https://example.com/a。'), '<p>看 <a href="https://example.com/a" rel="noopener noreferrer nofollow">https://example.com/a</a>。</p>')
  assert.ok(md('<https://a.com/x>').includes('href="https://a.com/x"'))
  assert.ok(md('寄到 [我](mailto:a@b.co)').includes('href="mailto:a@b.co"'))
  assert.equal(md('第一行\n第二行'), '<p>第一行<br>第二行</p>', '單一換行也換行')
  assert.equal(md('snake_case_name 與 2 * 3 * 4'), '<p>snake_case_name 與 2 * 3 * 4</p>', '字中底線與算式星號不算強調')
  assert.equal(md('\\*不是斜體\\*'), '<p>*不是斜體*</p>')
})

test('區塊元素：標題、清單（含巢狀）、引用、分隔線、表格、段落', () => {
  assert.equal(md('# 一\n## 二\n###### 六'), '<h1>一</h1><h2>二</h2><h6>六</h6>')
  assert.equal(md('- a\n- b\n  - c\n- d'), '<ul><li>a</li><li>b<ul><li>c</li></ul></li><li>d</li></ul>')
  assert.equal(md('1. 甲\n2. 乙'), '<ol><li>甲</li><li>乙</li></ol>')
  assert.equal(md('> 引\n> 用'), '<blockquote><p>引<br>用</p></blockquote>')
  assert.equal(md('上\n\n---\n\n下'), '<p>上</p><hr><p>下</p>')
  assert.equal(md('一段\n\n二段'), '<p>一段</p><p>二段</p>')
  const t = md('| 名稱 | 數量 |\n|:--|--:|\n| 蘋果 | 3 |\n| `a\\|b` | 4 |')
  assert.ok(t.startsWith('<div class="md-tablewrap"><table><thead><tr><th class="al-l">名稱</th><th class="al-r">數量</th></tr></thead><tbody>'), t)
  assert.ok(t.includes('<td class="al-l">蘋果</td><td class="al-r">3</td>'), t)
  assert.equal((t.match(/<tr>/g) || []).length, 3)
})

test('程式碼區塊：等寬容器、保留縮排、跳脫、不換表情、沒收尾也安全', () => {
  const h = md('```js\nif (a) {\n    x(":)", (Y))\n}\n```\n後面 :)')
  assert.ok(h.startsWith('<pre class="md-code"><code>if (a) {\n    x(&quot;:)&quot;, (Y))\n}</code></pre>'), h)
  assert.ok(!h.slice(0, h.indexOf('</pre>')).includes('class="emo"'), '程式碼區塊內不換表情')
  assert.ok(h.endsWith('<p>後面 <span class="emo" title=":)">🙂</span></p>'), '區塊外照常換表情')
  assert.ok(!md('`:) (Y)`').includes('emo'), '行內程式碼不換表情')
  assert.equal(md('```\n沒收尾 <b>'), '<pre class="md-code"><code>沒收尾 &lt;b&gt;</code></pre>')
  assert.ok(md('~~~\na\n~~~').includes('<pre'))
})

test('表情符號照舊：一般文字、清單、標題、粗體裡都換；與跳脫並行', () => {
  assert.ok(md('嗨 :) (Y)').includes('<span class="emo" title=":)">🙂</span>'))
  assert.ok(md('**好 (L)**').includes('❤️'))
  assert.ok(md('- :D').includes('😄'))
  assert.ok(md('a & b < c').includes('a &amp; b &lt; c'))
})

test('效能與快取：同內容回同一份、長文不卡、超長退回純文字', () => {
  const a = md('# 快取\n- x'), b = md('# 快取\n- x')
  assert.equal(a, b)
  const big = Array.from({ length: 800 }, (_, i) => `## 段 ${i}\n- 項 **${i}** [連結](https://example.com/${i}) \`c\`\n| a | b |\n|-|-|\n| ${i} | x |\n`).join('\n')
  const t0 = Date.now(); const h = md(big); const dt = Date.now() - t0
  assert.ok(dt < 1500, `長訊息渲染 ${dt}ms 太慢`)
  assertSafe(h, 'big')
  assert.ok(!md('*'.repeat(70000)).includes('<em>'), '超長不做 Markdown')
  // 病態輸入不會卡住（巢狀、未成對）
  const t1 = Date.now()
  md('*'.repeat(3000) + 'a'); md('['.repeat(2000)); md('> '.repeat(500) + 'x'); md('- '.repeat(500) + 'x'); md('`'.repeat(3000)); md('_a '.repeat(2000))
  assert.ok(Date.now() - t1 < 3000, '病態輸入太慢')
})

test('連結點擊：攔下預設導覽、只把 http(s)／mailto 交給系統瀏覽器', () => {
  const mk = href => ({ target: { closest: sel => (sel === 'a[href]' && href != null ? { getAttribute: () => href } : null) }, prevented: false, preventDefault() { this.prevented = true } })
  const opened = []
  const open = u => opened.push(u)
  const ev = mk('https://a.com/x'); assert.equal(handleLinkClick(ev, open), true); assert.ok(ev.prevented); assert.deepEqual(opened, ['https://a.com/x'])
  const ev2 = mk('javascript:alert(1)'); assert.equal(handleLinkClick(ev2, open), true); assert.ok(ev2.prevented); assert.equal(opened.length, 1, '危險協定不開')
  const ev3 = mk(null); assert.equal(handleLinkClick(ev3, open), false); assert.ok(!ev3.prevented)
})

test('守門：對話區只有一般訊息內文走 Markdown；震動、系統提示、照片、檔案不走', () => {
  const pane = fs.readFileSync(path.join(UI, 'lib', 'chatpane.mjs'), 'utf8')
  // 系統提示（含震動）用文字插值，不用 v-html
  assert.match(pane, /<div v-if="m\.k === 'sys'" class="sys"[^>]*>\{\{ m\.text \}\}<\/div>/)
  // 內文走 renderMarkdown；模板只有這一處
  assert.equal((pane.match(/v-html="renderMarkdown\(/g) || []).length, 1)
  assert.match(pane, /v-if="shownBody(m).text" v-html="renderMarkdown(shownBody(m).text)" @click="onBodyClick"/)   // 對方回信先拿掉結束通話記號（call-end.mjs）再走 Markdown
  // 照片、檔案區塊沒有 v-html
  const at = pane.indexOf('<div class="photos"')
  assert.ok(at > 0 && !/v-html/.test(pane.slice(at, at + 1500)))
  // 震動訊息在記錄層就是 sys，內文不會進 m-body
  const core = fs.readFileSync(path.join(UI, 'lib', 'core.mjs'), 'utf8')
  assert.ok(/k: 'sys', nudge: true/.test(core))
})

test('守門：Markdown 模組不碰網路、不用 innerHTML／eval、不支援圖片標籤', () => {
  const src = fs.readFileSync(path.join(UI, 'lib', 'markdown.mjs'), 'utf8')
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /\bfetch\(|XMLHttpRequest|innerHTML|\beval\(|new Function|<img/)
  assert.ok(!('img' in MD_TAGS) && !('script' in MD_TAGS) && !('iframe' in MD_TAGS) && !('style' in MD_TAGS))
})

test('守門：樣式（電腦＋手機）有 Markdown 區塊；程式碼與表格可橫捲', () => {
  const css = fs.readFileSync(path.join(UI, 'style.css'), 'utf8')
  assert.match(css, /pre\.md-code\{[^}]*overflow-x:auto/)
  assert.match(css, /\.md-tablewrap\{[^}]*overflow-x:auto/)
  assert.match(fs.readFileSync(path.join(UI, 'mobile.css'), 'utf8'), /\.m-chat \.msg \.m-body\.md-on/)
})
