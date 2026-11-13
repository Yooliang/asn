// 頁籤、群組列、廣告輪播的純邏輯。
import { groupsUnread } from '../ui/lib/tabs.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { AD_CONTACT_URL, ADS, AD_MS, AD_PAGE_MS, adImageSrc, adPageUrl, pickAds, DEVICE_TAB_MAX, FIXED_TABS, TOP_TABS, topOf, adClickable, goAd, normalizeTab, openAdWith, prevAd, adUrls, deviceItems, deviceTabs, groupHeading, groupRows, moreUnread, nextAd, shortOf, statusNote } from '../ui/lib/tabs.mjs'

const F = (node, device, nick, status = 'online', unread = 0) => ({ id: `${node}/${nick}`, node, device, nick, status, unread })

test('statusNote：線上不加，其餘灰字', () => {
  assert.equal(statusNote('online'), '')
  assert.equal(statusNote('busy'), '(忙碌)')
  assert.equal(statusNote('offline'), '(離線)')
  assert.equal(statusNote('away'), '(暫離)')
})

test('groupHeading：設備名 (線上數/總數)', () => {
  assert.equal(groupHeading({ label: '家用機', items: [{ status: 'online' }, { status: 'busy' }, { status: 'offline' }] }), '家用機 (2/3)')
  assert.equal(groupHeading({ label: 'x', items: [] }), 'x (0/0)')
})

test('deviceTabs：本機第一、其餘照名單順序、名單消失但有紀錄的排最後', () => {
  const friends = [F('W', '工作機', 'a'), F('H', '家用機', 'b'), F('A', '牧陽', 'c'), F('OLD', '舊機', 'd', 'offline')]
  const t = deviceTabs(friends, { selfNode: 'H', nodeOrder: ['W', 'H', 'A'] })
  assert.deepEqual(t.all.map(x => x.key), ['H', 'W', 'A', 'OLD'])
  assert.deepEqual(t.visible, t.all)
  assert.deepEqual(t.more, [])
  assert.deepEqual(t.all.map(x => x.short), ['家', '工', '牧', '舊'])
  assert.equal(t.all[3].online, 0)
})

test('deviceTabs：本機沒有任何好友也有頁籤；標題用自己的視窗名，沒給就「未命名設備」，絕不顯示節點代號', () => {
  assert.deepEqual(deviceTabs([], { selfNode: 'H', nodeOrder: [] }).all.map(x => [x.key, x.label, x.total]), [['H', '未命名設備', 0]])
  assert.deepEqual(deviceTabs([], { selfNode: 'H', selfName: 'H-ASN', nodeOrder: [] }).all.map(x => [x.key, x.label, x.total]), [['H', 'H-ASN', 0]])
})

test('deviceTabs：超過 6 個時第 6 個起收進「更多」，本機不會被收進去', () => {
  assert.equal(DEVICE_TAB_MAX, 6)
  const nodes = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8']
  const friends = nodes.map(n => F(n, `設備${n}`, `x-${n}`))
  // 本機在名單最後也要排第一
  const t = deviceTabs(friends, { selfNode: 'n8', nodeOrder: nodes })
  assert.equal(t.all.length, 8)
  assert.deepEqual(t.visible.map(x => x.key), ['n8', 'n1', 'n2', 'n3', 'n4'])
  assert.deepEqual(t.more.map(x => x.key), ['n5', 'n6', 'n7'])
  // 剛好 6 個不收
  const six = deviceTabs(friends.slice(0, 6), { selfNode: 'n1', nodeOrder: nodes })
  assert.equal(six.visible.length, 6)
  assert.equal(six.more.length, 0)
})

test('deviceTabs：未讀彙總到各設備頁籤與「更多」', () => {
  const nodes = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']
  const friends = nodes.flatMap(n => [F(n, n, `${n}-a`, 'online', n === 'n6' ? 2 : 0), F(n, n, `${n}-b`, 'offline', n === 'n6' ? 1 : n === 'n2' ? 4 : 0)])
  const t = deviceTabs(friends, { selfNode: 'n1', nodeOrder: nodes })
  assert.equal(t.all.find(x => x.key === 'n2').unread, 4)
  assert.equal(t.all.find(x => x.key === 'n6').unread, 3)
  assert.equal(t.all.find(x => x.key === 'n6').online, 1)
  assert.equal(t.all.find(x => x.key === 'n6').total, 2)
  assert.deepEqual(t.more.map(x => x.key), ['n6', 'n7'])
  assert.equal(moreUnread(t.more), 3)
  assert.equal(moreUnread([]), 0)
})

test('deviceItems：只取該設備、線上忙碌在前離線在後、可搜尋', () => {
  const fr = [F('H', 'h', 'b', 'offline'), F('H', 'h', 'c', 'busy'), F('H', 'h', 'a'), F('W', 'w', 'z')]
  assert.deepEqual(deviceItems(fr, 'H').map(f => f.nick), ['a', 'c', 'b'])
  assert.deepEqual(deviceItems(fr, 'H', f => f.nick === 'c').map(f => f.nick), ['c'])
  assert.equal(shortOf(''), '?')
  assert.equal(shortOf('abc'), 'A')
})

test('四個大分頁「夥伴／對話／設定／通知」（0.2.18，和手機一樣；#1429 改順序）；固定畫面：對話、通知、使用指引、設定；舊的「群組」換成「對話」；舊版的通知紀錄頁籤（notices）或不認得的頁籤一律忽略', () => {
  assert.deepEqual(TOP_TABS.map(t => t.label), ['夥伴', '對話', '設定', '通知'])
  assert.deepEqual(TOP_TABS.map(t => t.key), ['partners', 'chats', 'settings', 'notice'])
  assert.deepEqual(FIXED_TABS.map(t => t.key), ['chats', 'notice', 'guide', 'settings'])
  assert.equal(normalizeTab('notice'), 'notice'); assert.equal(normalizeTab('chats'), 'chats')
  assert.equal(normalizeTab('groups'), 'chats', '舊的群組頁籤併進對話')
  assert.deepEqual(['chats', 'notice', 'guide', 'settings', 'H', ''].map(topOf), ['chats', 'notice', 'settings', 'settings', 'partners', 'partners'], '使用指引在設定底下；設備頁籤屬於夥伴')
  assert.equal(normalizeTab('guide'), 'guide')
  assert.equal(normalizeTab('notices'), '')
  for (const v of ['', null, undefined, 3, 'zzz']) assert.equal(normalizeTab(v), '', String(v))
  assert.equal(normalizeTab('H', ['H', 'W']), 'H', '名單頁籤的鍵也算合法')
  assert.equal(normalizeTab('notices', ['H']), '')
})

test('守門：通知頁籤與通知紀錄的程式與畫面都拿掉了（右下角提示與未讀數還在）', () => {
  const dir = new URL('../ui/', import.meta.url)
  const html = fs.readFileSync(new URL('list.html', dir), 'utf8'), js = fs.readFileSync(new URL('list.js', dir), 'utf8'), tabs = fs.readFileSync(new URL('lib/tabs.mjs', dir), 'utf8')
  for (const [name, t] of [['list.html', html], ['list.js', js], ['tabs.mjs', tabs]]) assert.ok(!/notices|addNotice|fmtTime|NOTICE_MAX|'notices'/.test(t), `${name} 還有通知紀錄的東西`)
  assert.ok(js.includes("'show_toast'") && js.includes('n.toast'), '右下角提示照舊')
  assert.ok(html.includes('class="unread"') && html.includes('class="red"'), '未讀數與紅點照舊')
})

test('groupRows：成員數、最近動靜在前、壞資料略過', () => {
  const rows = groupRows([
    { id: 'r1', name: '舊群', created_at: '2026-10-01T00:00:00Z', members: [{}, {}], last_body: null },
    { id: 'r2', name: '新群', created_at: '2026-10-01T00:00:00Z', last_at: '2026-10-20T00:00:00Z', members: [{}, {}, {}], last_from_name: '小牧', last_body: '看一下\n這個' },
    { bad: 1 }, null,
  ])
  assert.deepEqual(rows.map(r => [r.id, r.count]), [['r2', 3], ['r1', 2]])
  assert.equal(rows[0].last, '小牧：看一下 這個')
  assert.deepEqual(groupRows(undefined), [])
})

test('大幅廣告輪播：上一則／下一則循環、小圓點跳到指定那則；招租沒網址時按鈕不可點、有網址的才可點', () => {
  assert.equal(prevAd(0), ADS.length - 1)
  assert.equal(prevAd(3), 2)
  assert.equal(nextAd(prevAd(2)), 2)
  assert.equal(prevAd(0, 0), 0)
  assert.equal(goAd(2), 2)
  assert.equal(goAd(99), ADS.length - 1)
  assert.equal(goAd(-5), 0)
  assert.equal(goAd('x'), 0)
  assert.deepEqual(ADS.map(a => [a.key, adClickable(a)]), [['cloud-agent', false], ['privacy', true], ['policy', true], ['rent', false]])
  assert.equal(adClickable(undefined), false)
  // 大幅廣告與底部小廣告用同一份資料、同一個點擊函式；招租沒網址就不呼叫 open
  const opened = []
  for (const a of ADS) openAdWith(a, u => opened.push(u))
  assert.deepEqual(opened, adUrls())
})

test('廣告輪播：循環一圈回到起點；連結只有官網與正見的網址；文案不含英文品牌', () => {
  let i = 0
  const seq = []
  for (let k = 0; k < ADS.length; k++) { seq.push(i); i = nextAd(i) }
  assert.deepEqual(seq, ADS.map((_, k) => k))
  assert.equal(i, 0)
  assert.deepEqual(adUrls(), ['https://asnmessenger.web.app/privacy', 'https://policy-tw.web.app'])
  for (const a of ADS) assert.ok(!/msn|messenger|microsoft/i.test(JSON.stringify([a.title, a.sub, a.cta, a.badge])), a.key)
  assert.equal(nextAd(0, 0), 0)
})

test('groupInDevice：依活躍度分活躍／閒置／離線（#347，不看忙閒），空組不列；依類型 Claude、Gemini、Grok 在前，沒回報的歸其他排最後', async () => {
  const { groupInDevice, groupHeading } = await import('../ui/lib/tabs.mjs')
  const f = (nick, status, engine) => ({ id: nick, nick, status, engine })
  const items = [f('a', 'online', 'claude'), f('b', 'busy', 'gemini'), f('c', 'away', null), f('d', 'offline', 'claude'), f('e', 'online', 'grok')]
  const st = groupInDevice(items, 'status')
  assert.deepEqual(st.map(g => [g.label, g.items.map(x => x.nick)]), [['閒置', ['a', 'b', 'c', 'e']], ['離線', ['d']]], '沒算過活躍度的：離線歸離線，其餘先當閒置')
  assert.equal(groupHeading(st[0]), '閒置 (4)')
  assert.deepEqual(groupInDevice([{ ...f('x', 'busy', 'claude'), activity: 'active' }], 'status').map(g => g.label), ['活躍'], '忙碌也照活躍度分')
  const en = groupInDevice(items, 'engine')
  assert.deepEqual(en.map(g => [g.label, g.items.map(x => x.nick)]), [['Claude', ['a', 'd']], ['Gemini', ['b']], ['Grok', ['e']], ['其他', ['c']]])
  assert.equal(groupHeading(en[0]), 'Claude (1/2)')
})

test('statusOf：waiting 之類＝暫離', async () => {
  const { statusOf } = await import('../ui/lib/roster.mjs')
  assert.equal(statusOf('waiting'), 'away')
  assert.equal(statusOf('idle'), 'online')
  assert.equal(statusOf('working'), 'busy')
})

test('廣告：打包備用的輪播順序與內容；每則一句標語加一個短按鈕字；沒有希緒、Irori 的宣傳', () => {
  assert.deepEqual(ADS.map(a => a.key), ['cloud-agent', 'privacy', 'policy', 'rent'])
  assert.ok(!ADS.some(a => /android/i.test(JSON.stringify(a))))
  for (const a of ADS) {
    assert.ok(a.title && a.sub && !/\n/.test(a.sub) && a.sub.length <= 24, `${a.key} 標語要一句`)
    assert.ok(a.cta.length <= 3, `${a.key} 按鈕字要短`)
  }
  assert.equal(ADS[1].url, 'https://asnmessenger.web.app/privacy')
  assert.equal(ADS[2].url, 'https://policy-tw.web.app')
  let i = 0; const seq = []
  for (let k = 0; k < ADS.length * 2; k++) { seq.push(ADS[i].key); i = nextAd(i) }
  assert.deepEqual(seq, ['cloud-agent', 'privacy', 'policy', 'rent', 'cloud-agent', 'privacy', 'policy', 'rent'])
  assert.ok(AD_MS >= 3000)
})

const siteAds = () => JSON.parse(fs.readFileSync(new URL('../../../site/public/ads.json', import.meta.url), 'utf8'))

test('守門：打包備用 ADS 與官網 site/public/ads.json 的 key 集合一致、不含「希緒」「Irori」', () => {
  const online = siteAds()
  assert.equal(online.version, 1)
  assert.deepEqual(online.ads.map(a => a.key), ADS.map(a => a.key))
  for (const [name, text] of [['官網 ads.json', JSON.stringify(online)], ['打包 ADS', JSON.stringify(ADS)]]) {
    assert.ok(!/希緒|irori/i.test(text), `${name} 不該有希緒或 Irori`)
  }
  // 官網與備用的網址也一致，且全都是 https
  for (const a of online.ads) {
    const b = ADS.find(x => x.key === a.key)
    assert.equal(a.url, b.url, a.key)
    assert.ok(a.url === '' || a.url.startsWith('https://'), a.key)
  }
})

test('守門：Rust 端的網域允許清單只有官網與正見，沒有 Irori；廣告網址的主機都在清單內', () => {
  const rs = fs.readFileSync(new URL('../src-tauri/src/ads.rs', import.meta.url), 'utf8')
  const hosts = [...(/ALLOWED_HOSTS: \[&str; \d+\] = \[([^\]]*)\]/.exec(rs)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map(m => m[1])
  assert.deepEqual(hosts, ['asnmessenger.web.app', 'policy-tw.web.app'])
  for (const u of [...adUrls(), ...siteAds().ads.map(a => a.url).filter(Boolean)]) assert.ok(hosts.includes(new URL(u).hostname), `${u} 不在允許清單`)
  const lib = fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  assert.ok(lib.includes('ads::url_allowed(&url)'), 'open_url 要走網域允許清單')
  assert.ok(!/OPEN_ALLOW/.test(lib))
})

test('廣告網頁／圖片的前端檢查：只認官網 /ads/ 底下的 https 網址與 png／webp data URI', () => {
  assert.equal(adPageUrl({ page: 'https://asnmessenger.web.app/ads/policy.html' }), 'https://asnmessenger.web.app/ads/policy.html')
  for (const bad of ['http://asnmessenger.web.app/ads/x.html', 'https://evil.example/ads/x.html', 'https://asnmessenger.web.app/other/x.html', 'https://asnmessenger.web.app.evil.example/ads/x.html', 'https://asnmessenger.web.app/ads/x.html" onload="x', 'javascript:alert(1)', '', undefined, 5]) {
    assert.equal(adPageUrl({ page: bad }), '', String(bad))
  }
  assert.equal(adPageUrl(undefined), '')
  assert.equal(adImageSrc({ smallImage: 'data:image/png;base64,iVBORw0KGgo=' }), 'data:image/png;base64,iVBORw0KGgo=')
  assert.equal(adImageSrc({ smallImage: 'data:image/webp;base64,UklGRg==' }), 'data:image/webp;base64,UklGRg==')
  for (const bad of ['https://asnmessenger.web.app/ads/x.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PGI+', 'data:image/png;base64,AA" onerror="x', '', undefined]) {
    assert.equal(adImageSrc({ smallImage: bad }), '', String(bad))
  }
})

test('線上抓不到（回空、不是陣列）就用打包備用；有內容才採用', () => {
  assert.equal(pickAds([]), ADS)
  assert.equal(pickAds(undefined), ADS)
  assert.equal(pickAds('x'), ADS)
  assert.equal(pickAds([], null), null)
  const remote = [{ key: 'a', title: 't', sub: 's' }]
  assert.equal(pickAds(remote), remote)
})

test('守門：廣告大頁的 iframe 一律 sandbox（空＝全部關）、不送 referrer、不開權限；畫面模板與 CSP 的網域只有官網', () => {
  const html = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  const frames = html.match(/<iframe\b[^>]*>/g) ?? []
  assert.equal(frames.length, 1, '整個畫面只有大幅廣告那一個 iframe')
  const f = frames[0]
  assert.match(f, /\ssandbox=""/, 'sandbox 必須是空值（不給 allow-*）')
  assert.ok(!/allow-/.test(f), '不給任何 allow-* ')
  assert.match(f, /referrerpolicy="no-referrer"/)
  assert.match(f, /\sallow=""/, '不開任何權限')
  assert.match(f, /:src="pageSrc\(a\)"/, 'src 只來自檢查過的 pageSrc')
  assert.ok(!/allow-same-origin|allow-top-navigation|allow-forms|allow-popups/.test(html))
  const css = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8')
  assert.match(css, /\.hero-page\{[^}]*pointer-events:none/, 'iframe 不接收滑鼠，頁面裡的連結點不到')
  const conf = JSON.parse(fs.readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  const csp = conf.app.security.csp
  const frameSrc = /(?:^|;)\s*frame-src ([^;]*)/.exec(csp)?.[1].trim().split(/\s+/)
  assert.deepEqual(frameSrc, ['https://asnmessenger.web.app'], 'frame-src 只放官網')
  assert.ok(!/frame-src[^;]*\*/.test(csp))
  assert.match(csp, /img-src 'self' data:(;|$)/, 'img-src 不放寬')
  assert.match(csp, /connect-src ipc: http:\/\/ipc\.localhost(;|$)/, '前端不能 fetch')
})

test('守門：大頁載入失敗或逾時、--shot 模式、沒有圖片時都退回樣板；線上內容不進 v-html', () => {
  const js = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  const html = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  assert.match(js, /const pageSrc = a => \(info\.shot \|\| pageFail\[a\.key\] \? '' : adPageUrl\(a\)\)/, '--shot 或失敗＝不給網址＝樣板')
  assert.match(js, /setTimeout\(\(\) => \{ if \(!pageLoaded\[a\.key\]\) pageFail\[a\.key\] = true \}, AD_PAGE_MS\)/, '逾時＝失敗')
  assert.ok(AD_PAGE_MS <= 5000)
  assert.match(html, /@error="pageBroken\(a\)"/)
  assert.match(html, /<template v-else>\s*<span class="ad-new"/, '小輪播沒圖就退回樣板')
  assert.ok(html.includes('<div class="hero-tx" v-if="!pageSrc(a)">'), '大幅輪播沒網頁就退回樣板')
  assert.ok(!/v-html="[^"]*\b(?:a\.(?:title|sub|cta|badge|url|page|smallImage)|ads|adImageSrc|pageSrc)\b/.test(html), '廣告的內容不進 v-html')
  assert.match(js, /if \(info\.shot\) return\s*\r?\n\s*try \{\s*\r?\n\s*const next = pickAds\(await invoke\('ads_fetch'\)/, '--shot 不抓線上廣告')
})

test('守門：官網 /ads/** 的標頭只放行 ASN 的 WebView 來源；其他路徑仍禁止被嵌入；範例大頁不引用外部資源', () => {
  const fb = JSON.parse(fs.readFileSync(new URL('../../../site/firebase.json', import.meta.url), 'utf8'))
  const rules = fb.hosting.headers
  const base = rules.findIndex(r => r.source === '**')
  const ads = rules.findIndex(r => r.source === 'ads/**')
  assert.ok(base >= 0 && ads > base, 'ads/** 的規則要排在 ** 之後才會蓋過去')
  const h = k => Object.fromEntries(rules[ads].headers.map(x => [x.key, x.value]))[k]
  const fa = /frame-ancestors ([^;]*)/.exec(h('Content-Security-Policy'))[1].trim().split(/\s+/)
  assert.deepEqual(fa, ['http://tauri.localhost', 'tauri://localhost'])
  assert.match(h('Content-Security-Policy'), /script-src 'none'/)
  assert.match(h('Content-Security-Policy'), /default-src 'none'/)
  assert.match(JSON.stringify(rules[base]), /X-Frame-Options.{3,12}DENY/)
  assert.match(JSON.stringify(rules[base]), /frame-ancestors 'none'/)
  const ads_json = rules.find(r => r.source === 'ads.json')
  assert.match(JSON.stringify(ads_json), /max-age=300/)
  const dir = new URL('../../../site/public/ads/', import.meta.url)
  const pages = fs.readdirSync(dir).filter(f => f.endsWith('.html'))
  assert.ok(pages.length > 0)
  for (const p of pages) {
    const t = fs.readFileSync(new URL(p, dir), 'utf8')
    assert.ok(!/<script|<a\s|<link|<iframe|<form|<img[^>]+src="(?!data:)|@import|url\((?!["']?data:)|https?:\/\//i.test(t), `${p} 不能有腳本、連結、外部資源`)
  }
  // ads.json 裡的 page 都要真的有檔案
  for (const a of siteAds().ads.filter(x => x.page)) assert.ok(fs.existsSync(new URL('.' + a.page.replace('/ads/', '/'), dir)), a.page)
})

test('廣告位招租：聯絡網址還沒給（空字串）時照常輪播，但點下去不呼叫 open_url、不開任何網址', () => {
  assert.equal(AD_CONTACT_URL, '')
  const rent = ADS.find(a => a.key === 'rent')
  assert.equal(rent.title, '廣告位招租')
  assert.equal(rent.cta, '洽詢')
  assert.equal(rent.url, '')
  const opened = []
  assert.equal(openAdWith(rent, u => opened.push(u)), false)
  assert.deepEqual(opened, [])
  assert.equal(openAdWith(ADS.find(a => a.key === 'policy'), u => opened.push(u)), true)
  assert.deepEqual(opened, ['https://policy-tw.web.app'])
  assert.equal(openAdWith(undefined, u => opened.push(u)), false)
  // 有填聯絡網址時（之後）就會開；這裡只驗機制
  assert.equal(openAdWith({ url: 'https://example.invalid/' }, u => opened.push(u)), true)
})

test('守門：廣告不用任何 AdSense／外部廣告程式碼；點廣告一律走 openAdWith；招租沒網址時按鈕是停用的', () => {
  const dir = new URL('../ui/', import.meta.url)
  for (const f of ['list.html', 'list.js', 'toast.html', 'chat.html', 'lib/tabs.mjs']) {
    const t = fs.readFileSync(new URL(f, dir), 'utf8')
    assert.ok(!/adsbygoogle|googlesyndication|pagead|doubleclick|adservice/i.test(t), `${f} 不該有外部廣告程式碼`)
  }
  const js = fs.readFileSync(new URL('list.js', dir), 'utf8')
  assert.ok(js.includes("openAdWith(a, url => void invoke('open_url', { url }))"))
  assert.ok(!js.includes("if (a.url) void invoke('open_url'"))
  const html = fs.readFileSync(new URL('list.html', dir), 'utf8')
  assert.equal(html.split(':disabled="!a.url"').length - 1, 3, '底部小廣告、「開始」頁大幅廣告（樣板與網頁版各一顆）的按鈕，沒網址時都要停用')
  assert.equal(html.split('@click="openAd(a)"').length - 1, 3, '各處點廣告都走 openAd')
  assert.ok(!/open_url/.test(html), '畫面模板不直接呼叫 open_url')
  assert.ok(!/<script[^>]+src="https?:/.test(html), '不載入外部腳本')
})

test('群組的未讀：所有群組未讀加總；沒有未讀、壞資料都是 0；「對話」分頁的紅點算進去', () => {
  assert.equal(groupsUnread([{ unread: 2 }, { unread: 0 }, { unread: 3 }]), 5)
  assert.equal(groupsUnread([{ unread: 0 }, {}]), 0)
  assert.equal(groupsUnread([null, { unread: 'x' }]), 0)
  assert.equal(groupsUnread(null), 0)
  const html = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  const js = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  // #1429：聊天的紅點掛在「夥伴」（和設備頁籤的未讀一起），「對話」分頁不掛紅點
  assert.match(html, /<span class="red" v-if="t\.key === 'partners' && \(chatsUnreadN \|\| partnersUnread\)"><\/span>/)
  assert.doesNotMatch(html, /t\.key === 'chats' && chatsUnreadN/, '對話分頁不再掛紅點')
  assert.match(js, /const chatsUnreadN = computed\(\(\) => chatRowsUnread\(chatAll\.value\)\)/, '夥伴分頁的聊天紅點和對話清單用同一份（群組的未讀也在裡面）')
  assert.match(js, /const partnersUnread = computed\(\(\) => dev\.value\.all\.some\(d => d\.unread\)\)/, '任一台設備有未讀，夥伴分頁也亮紅點')
  assert.match(js, /FIXED_TABS, TOP_TABS, top, goTop, chatRows, chatQuery, chatsUnreadN, partnersUnread,/, '要交給畫面')
})

test('電腦版「對話」分頁（0.2.18）：活動中的對話＋所有群組（很久沒動靜的排最後，原本的群組頁籤併進來）；搜尋和名單同一套比對；夥伴分頁回到剛才的設備頁籤', () => {
  const js = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const html = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.match(js, /chatListRows\(\{ friends: activeFriends\(friendsAct\.value\)\.filter\(f => !isNoticeFriend\(f\) && !isMergedAway\(f\)\), logOf: id => core\.viewOf\(id\) \?\? \[\], rooms: roomRows\.value/, '不含已封存、通知、已併進通知的舊列；群組全部列出（chatListRows）')
  assert.match(js, /filterChatRows\(chatAll\.value, normalizeSearchQuery\(chatQuery\.value\), \(f, q\) => friendMatchesQuery\(f, q, plain\)\)/)
  assert.match(js, /function goTop\(key\) \{[\s\S]*?keys\.includes\(lastDevTab\) \? lastDevTab : keys\[0\]/, '點夥伴回到上次看的設備頁籤')
  // 畫面：上方四個分頁；左邊直排只有設備頁籤（只在夥伴裡）；設定最後一列是使用指引，指引上方有「‹ 設定」
  assert.match(html, /<nav class="top-tabs" role="tablist" aria-label="大分頁">\s*<button v-for="t in TOP_TABS"/)
  assert.match(html, /<nav class="rail" role="tablist" aria-label="設備頁籤" v-if="isDevice">/)
  assert.doesNotMatch(html, /v-for="t in FIXED_TABS"|rail-gap|rtab-groups|tab === 'groups'/, '左邊不再有通知、群組、指引、齒輪')
  assert.match(html, /<div class="list chat-list" v-else-if="tab === 'chats'">[\s\S]*?groupFlow\.openCreate\(\)[\s\S]*?groupFlow\.openJoin\(\)[\s\S]*?v-for="x in chatRows"/)
  assert.match(html, /<button class="pane-back guide-back" type="button" @click="tab = 'settings'">‹ 設定<\/button>/)
  assert.match(html, /class="buddy guide-item guide-entry" type="button" @click="tab = 'guide'"/)
})

test('電腦版設定的「使用指引」列和手機用同一組字（GUIDE_ENTRY_LABEL／GUIDE_ENTRY_SUB）；指引裡不再提左邊的群組頁籤，設定分類叫「提醒與聲音」', async () => {
  const html = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  assert.match(html, /<span class="b-nick">\{\{ GUIDE_ENTRY_LABEL \}\}<\/span><\/span><span class="b-psm">\{\{ GUIDE_ENTRY_SUB \}\}<\/span>/)
  const { GUIDE_ENTRY_LABEL, GUIDE_ENTRY_SUB } = await import('../ui/lib/mobile-guides.mjs')
  assert.equal(GUIDE_ENTRY_LABEL, '使用指引'); assert.doesNotMatch(GUIDE_ENTRY_SUB, /電腦版|手機/, '兩邊共用，不寫是哪一邊')
  const { GUIDES } = await import('../ui/lib/guides.mjs')
  const all = JSON.stringify(GUIDES)
  assert.doesNotMatch(all, /左邊的「群組」|「群組」頁籤/, '群組頁籤已併進對話分頁')
  assert.match(all, /上方的「對話」分頁，最上面有「建立群組」「加入群組」/)
  assert.doesNotMatch(all, /「設定」頁可調通知/, '設定分類叫「提醒與聲音」')
})
