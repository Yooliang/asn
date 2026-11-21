// #1947 ①：官網 /update/ 底下的網址是已安裝 ASN 寫死讀的，官網改成獨立部署（或任何重構）都一個字不能變。
//   - 電腦版與 Linux 的更新外掛讀 https://asnmessenger.web.app/update/latest.json（tauri.conf.json 的 updater endpoints）
//   - 安裝檔 /update/ASN_<版號>_… 一律 302 轉到 GitHub Release v<版號>（firebase.json 的 redirects）
// 這支只鎖「不能變的東西」；轉址行為的細節另見 tests/site_predeploy.test.mjs。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const firebase = JSON.parse(read('site/firebase.json'))
const tauri = JSON.parse(read('relay/asn/src-tauri/tauri.conf.json'))

// 逐字鎖住：要改得先改這裡，並說明已安裝的舊版怎麼辦
const REDIRECT = {
  regex: '^/update/(?P<file>ASN_(?P<ver>\\d+\\.\\d+\\.\\d+)_(?:x64-setup\\.exe(?:\\.sig)?|android\\.apk|amd64\\.(?:AppImage(?:\\.sig)?|deb)))$',
  destination: 'https://github.com/Yooliang/asn/releases/download/v:ver/:file',
  type: 302,
}
const ENDPOINT = 'https://asnmessenger.web.app/update/latest.json'

test('#1947 firebase.json 的 /update/ 轉址規則逐字不變（regex、目的地、302）', () => {
  const rules = firebase.hosting.redirects
  assert.equal(rules.length, 1, '轉址規則只有這一條')
  assert.deepEqual({ regex: rules[0].regex, destination: rules[0].destination, type: rules[0].type }, REDIRECT)
  assert.equal(firebase.hosting.public, 'public', '網站根目錄不能換（latest.json 的位置靠它）')
})

test('#1947 每一種安裝檔（電腦版、手機、Linux）都轉到 GitHub Release v<版號>；清單檔不轉', () => {
  const [r] = firebase.hosting.redirects
  const re = new RegExp(r.regex.replace(/\(\?P</g, '(?<')) // Firebase 用 RE2 的 (?P<名字>…)，換成 JS 的寫法
  const apply = p => { const m = re.exec(p); return m ? r.destination.replace(/:(file|ver)\b/g, (_, k) => m.groups[k]) : null }
  const v = '0.2.45'
  for (const f of [`ASN_${v}_x64-setup.exe`, `ASN_${v}_x64-setup.exe.sig`, `ASN_${v}_android.apk`, `ASN_${v}_amd64.AppImage`, `ASN_${v}_amd64.AppImage.sig`, `ASN_${v}_amd64.deb`]) {
    assert.equal(apply(`/update/${f}`), `https://github.com/Yooliang/asn/releases/download/v${v}/${f}`, f)
  }
  for (const p of ['/update/latest.json', '/update/android.json']) assert.equal(apply(p), null, `${p} 不能被轉走`)
})

test('#1947 更新外掛讀的網址不變：tauri.conf.json 的 updater endpoints 只有官網 /update/latest.json', () => {
  assert.deepEqual(tauri.plugins.updater.endpoints, [ENDPOINT])
})

test('#1947 latest.json 真的在官網目錄裡、而且不會被部署排除', () => {
  assert.ok(fs.existsSync(new URL('../site/public/update/latest.json', import.meta.url)), 'site/public/update/latest.json 要存在')
  const latest = JSON.parse(read('site/public/update/latest.json'))
  assert.match(latest.version, /^\d+\.\d+\.\d+$/)
  // firebase 的 ignore 是 glob；逐條確認沒有一條會蓋到 update/latest.json
  const glob = g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$')
  for (const g of firebase.hosting.ignore ?? []) assert.ok(!glob(g).test('update/latest.json'), `ignore 規則 ${g} 會把 latest.json 排除`)
  // 也不能有任何 rewrite 或 redirect 把 /update/latest.json 導走
  for (const rw of firebase.hosting.rewrites ?? []) {
    if (rw.source) assert.ok(!glob(rw.source.replace(/^\//, '')).test('update/latest.json'), `rewrite ${rw.source} 會蓋到 latest.json`)
  }
})
