// 官網各頁共用版面（頁首選單＋Logo、頁尾連結、網站圖示）的守門測試：node --test --test-force-exit --test-timeout=120000 tests/site_layout.test.mjs
// 共用內容只在 site/make-layout.mjs 寫一份；改了選單或 Logo 要重跑 node site/make-layout.mjs。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NAV, BRAND, PAGES, applyLayout, renderHeader, renderHead, markers } from '../site/make-layout.mjs'
import { UPDATE_BASE, INSTALLER_HREF_RE, installerUrl, patchDownloadLink } from '../relay/asn/scripts/release-lib.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pub = p => path.join(root, 'site/public', p)
const read = p => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')   // Windows 工作樹是 CRLF，統一成 LF 再比對
const section = (html, name) => {
  const { start, end } = markers(name)
  const a = html.indexOf(start), b = html.indexOf(end)
  assert.ok(a >= 0 && b > a, `找不到 layout:${name} 區段`)
  return html.slice(a + start.length, b)
}
const files = Object.keys(PAGES)
const pageHtml = f => read(`site/public/${f}`)

// 頁面載入的外部資源（CSP 的 default-src 'self' 會擋）：任何標籤的 src="http(s)://"、非 <a> 標籤（<link> 等）的 href="http(s)://"。
// <a href> 是使用者點了才走的連結，不是頁面載入的資源，CSP 不管；但官網目前唯一允許的外部連結是首頁下載按鈕的安裝檔
// （發版腳本 relay/asn/scripts/release.mjs 用 patchDownloadLink 改寫成 installerUrl(版本)），其他外部連結照樣擋，要加請先改這裡。
const externalRefs = html => [...html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*?\s(src|href)="(https?:\/\/[^"]*)"/gi)]
  .map(m => ({ tag: m[1].toLowerCase(), attr: m[2].toLowerCase(), url: m[3] }))
const isInstallerLink = r => r.tag === 'a' && r.attr === 'href' && r.url.startsWith(UPDATE_BASE)
  && new RegExp(INSTALLER_HREF_RE.source).test(`href="${r.url}"`)
const disallowedExternal = html => externalRefs(html).filter(r => !isInstallerLink(r))

test('各頁的共用區段與 make-layout.mjs 產生的一致（改了選單要重跑 node site/make-layout.mjs）', () => {
  for (const f of files) {
    const html = pageHtml(f)
    assert.equal(applyLayout(html, PAGES[f]), html, `${f} 與共用版面不一致`)
  }
})

test('選單固定順序、每頁一樣：只差目前頁的 aria-current', () => {
  assert.deepEqual(NAV.map(n => n.label), ['首頁', '功能', '畫面', '下載', '藍圖', '開發日誌', '隱私權政策', '服務條款'])
  const strip = h => h.replace(/ aria-current="page"/g, '')
  const headers = files.filter(f => PAGES[f].parts.includes('header')).map(f => strip(section(pageHtml(f), 'header')))
  assert.ok(headers.length >= 6)
  for (const h of headers) assert.equal(h, headers[0])
  assert.equal(strip(renderHeader(null)), strip(renderHeader('home')))
})

test('站內錨點用完整連結（/#features），任何頁都不用只有 # 的選單連結', () => {
  for (const f of files.filter(f => PAGES[f].parts.includes('header'))) {
    const nav = /<nav[\s\S]*?<\/nav>/.exec(section(pageHtml(f), 'header'))[0]
    for (const m of nav.matchAll(/href="([^"]*)"/g)) assert.ok(m[1].startsWith('/'), `${f} 選單連結 ${m[1]} 不是完整站內連結`)
  }
  // 首頁錨點對應的 id 真的存在
  const home = pageHtml('index.html')
  for (const n of NAV.filter(n => n.href.startsWith('/#'))) assert.ok(home.includes(`id="${n.href.slice(2)}"`), `首頁缺 #${n.href.slice(2)}`)
})

test('目前頁高亮：恰好一個 aria-current="page"，且指到自己（沒有對應項目的頁面不高亮）', () => {
  const expectHref = { home: '/', roadmap: '/roadmap', log: '/log', privacy: '/privacy', terms: '/terms' }
  for (const f of files.filter(f => PAGES[f].parts.includes('header'))) {
    const nav = /<nav[\s\S]*?<\/nav>/.exec(section(pageHtml(f), 'header'))[0]
    const cur = [...nav.matchAll(/<a href="([^"]*)" aria-current="page">/g)].map(m => m[1])
    const c = PAGES[f].current
    if (c) assert.deepEqual(cur, [expectHref[c]], f)
    else assert.deepEqual(cur, [], f)
  }
  assert.ok(files.includes('index.html') && files.includes('privacy.html') && files.includes('terms.html') && files.includes('roadmap.html') && files.includes('log.html'))
})

test('Logo 是圖檔（有 alt），來源是 App 的 ui/img/logo.svg，圖檔都在', () => {
  assert.match(renderHeader('home'), new RegExp(`<img class="brand-logo" src="${BRAND.logo}" alt="[^"]+"`))
  assert.ok(BRAND.alt.length > 0)
  for (const f of ['img/logo.svg', 'img/favicon-32.png', 'img/apple-touch-icon.png', 'favicon.ico']) assert.ok(fs.existsSync(pub(f)), `缺 ${f}`)
  assert.equal(fs.readFileSync(pub('img/logo.svg'), 'utf8').replace(/width="\d+" height="\d+"/, 'width="100%" height="100%"').replace(/\r\n/g, '\n'),
    read('relay/asn/ui/img/logo.svg'), 'logo.svg 要和 App 的 relay/asn/ui/img/logo.svg 一樣（除了預設尺寸）')
  const png = f => fs.readFileSync(pub(f))
  assert.equal(png('img/apple-touch-icon.png').readUInt32BE(16), 180)
  assert.equal(png('img/favicon-32.png').readUInt32BE(16), 32)
  assert.ok(!/brand-mark/.test(read('site/public/style.css')), '舊的 CSS 方塊 Logo 要拿掉')
})

test('每頁都有 favicon 與 apple-touch-icon 連結，連結指到存在的檔案', () => {
  assert.match(renderHead(), /rel="apple-touch-icon" href="\/img\/apple-touch-icon\.png"/)
  for (const f of files) {
    const head = section(pageHtml(f), 'head')
    assert.ok(head.includes('rel="icon"') && head.includes('rel="apple-touch-icon"'), f)
    for (const m of head.matchAll(/href="(\/[^"]+)"/g)) assert.ok(fs.existsSync(pub(m[1].slice(1))), `${f}: ${m[1]} 不存在`)
  }
})

test('符合網站的內容安全政策：套用共用版面的頁面沒有行內樣式、行內腳本、外部資源（/i/、/link/、藍圖與開發日誌有自己的外部腳本檔）', () => {
  for (const f of files) {
    const html = pageHtml(f)
    assert.ok(!/<style/i.test(html), `${f} 有行內 <style>`)
    assert.ok(!/\sstyle=/i.test(html), `${f} 有 style=`)
    assert.ok(!/\son[a-z]+=/i.test(html), `${f} 有行內事件`)
    assert.ok(!/<script(?![^>]*\ssrc=)/i.test(html), `${f} 有行內腳本`)
    assert.deepEqual(disallowedExternal(html), [], `${f} 有外部資源`)
  }
  for (const f of ['index.html', 'privacy.html', 'terms.html', 'skill/index.html']) assert.ok(!/<script/i.test(pageHtml(f)), `${f} 不該有腳本`)
})

test('外部資源檢查：發版腳本改寫後的首頁仍符合；外部腳本、樣式表、圖片與其他外部連結照樣擋', () => {
  const index = pageHtml('index.html')
  assert.ok((index.match(INSTALLER_HREF_RE) ?? []).length >= 1, '首頁要有下載按鈕的安裝檔連結（發版腳本靠它改版本）')
  const released = patchDownloadLink(index, installerUrl('9.9.9'))
  assert.notEqual(released, index)
  assert.ok(released.includes(installerUrl('9.9.9')))
  assert.deepEqual(disallowedExternal(released), [])
  for (const bad of [
    '<script src="https://cdn.example.com/a.js"></script>',
    '<link rel="stylesheet" href="https://fonts.example.com/a.css">',
    '<img src="https://img.example.com/a.png" alt="">',
    '<a href="https://other.example.com/update/ASN_0.1.1_x64-setup.exe">x</a>',
    `<a href="${UPDATE_BASE}other.zip">x</a>`,
  ]) assert.equal(disallowedExternal(bad).length, 1, bad)
})

test('頁尾連結各頁一致，用語不出現舊名詞', () => {
  const foot = files.filter(f => PAGES[f].parts.includes('footer')).map(f => section(pageHtml(f), 'footer'))
  assert.equal(foot.length, 5)
  for (const h of foot) assert.equal(h, foot[0])
  for (const f of files) assert.ok(!pageHtml(f).includes('收發室'), f)
  assert.ok(!read('site/make-layout.mjs').split('\n').some(l => l.includes('收發室') && !l.startsWith('//')))
})

test('套用函式：缺標記區段就報錯，不悄悄略過', () => {
  assert.throws(() => applyLayout('<html></html>', PAGES['index.html']))
})

test('所有子頁盤點：有自己 <header> 的頁面都在共用清單裡', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
  for (const abs of walk(pub('')).filter(p => p.endsWith('.html'))) {
    const rel = path.relative(pub(''), abs).split(path.sep).join('/')
    if (/<header[\s>]/.test(fs.readFileSync(abs, 'utf8'))) assert.ok(PAGES[rel]?.parts.includes('header'), `${rel} 有自己的 <header>，請改用共用版面`)
  }
})
