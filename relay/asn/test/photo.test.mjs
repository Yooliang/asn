// 傳照片：純邏輯（尺寸、檔名清理、替代文字、附件整理、過期、錯誤白話）、AsnCore 收發照片（對本機假 relay）、前端與 Rust 指令的接線守門。
// 執行：node --test relay/asn/test/photo.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AsnCore } from '../ui/lib/core.mjs'
import {
  FILE_ACCEPT, FILE_MAX_BYTES, FILE_TYPES, fileMimeOf, noticeOf,
  PHOTO_MAX_BYTES, PHOTO_MAX_EDGE, THUMB_MAX_CHARS, cleanPhotoName, expiresAt, fitSize, formatBytes, friendlyPhotoError, isThumb,
  fitPhoto, photoPlan, PHOTO_ROUNDS, PHOTO_MAX_PIXELS, PHOTO_HARD_EDGE,
  normalizePhotos, photoExpired, recentPhotos, shownPhotos, expiryMs, photoText, photoTitle, stripPhotoLines, webpName,
} from '../ui/lib/photo.mjs'
import { FAKE_KEY, startFakeRelay, U } from './fake-relay.mjs'
import { httpTransport, memStore } from './helpers.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = rel => fs.readFileSync(path.join(here, '..', rel), 'utf8')
const THUMB = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAw'
const att = (n, extra = {}) => ({ id: U(n), kind: 'image', name: 'cat.webp', mime: 'image/webp', bytes: 183422, width: 1536, height: 2048, thumb: THUMB, expires_at: '2099-01-01T00:00:00Z', expired: false, ...extra })

test('fitSize：長邊超過上限才縮（保持比例、取整數）、不放大、壞值回 0', () => {
  assert.deepEqual(fitSize(4000, 3000), { w: 2048, h: 1536 })
  assert.deepEqual(fitSize(3000, 4000), { w: 1536, h: 2048 })
  assert.deepEqual(fitSize(1000, 500), { w: 1000, h: 500 })
  assert.deepEqual(fitSize(2048, 2048), { w: 2048, h: 2048 })
  assert.deepEqual(fitSize(10000, 1, 2048), { w: 2048, h: 1 })
  assert.deepEqual(fitSize(4000, 3000, 256), { w: 256, h: 192 })
  assert.deepEqual(fitSize(0, 5), { w: 0, h: 0 })
  assert.deepEqual(fitSize(NaN, 5), { w: 0, h: 0 })
  assert.equal(PHOTO_MAX_EDGE, 2048); assert.equal(PHOTO_MAX_BYTES, 5 * 1024 * 1024); assert.equal(THUMB_MAX_CHARS, 12000)
})

test('fitPhoto（#2331）：一般照片尺寸與舊規則完全一樣；長圖以短邊保底不縮；超過 8 MP／8192 才縮', () => {
  for (const [w, h] of [[4000, 3000], [3000, 4000], [1920, 1080], [1080, 1920], [1000, 500], [2048, 2048], [6000, 6000], [4032, 3024]]) {
    assert.deepEqual(fitPhoto(w, h), fitSize(w, h), `${w}×${h} 應與舊規則相同`)
  }
  assert.deepEqual(fitPhoto(4000, 3000), { w: 2048, h: 1536 })
  assert.deepEqual(fitPhoto(1920, 1080), { w: 1920, h: 1080 })
  assert.deepEqual(fitPhoto(1162, 3604), { w: 1162, h: 3604 })   // 設計稿合一長圖：不縮
  assert.deepEqual(fitPhoto(1080, 5000), { w: 1080, h: 5000 })   // 手機全頁截圖：不縮
  // 短邊 ≥ 1280 的長圖：由短邊保底決定，仍受 8 MP 與 8192 限制
  const big = fitPhoto(1500, 9000)
  assert.ok(big.w * big.h <= PHOTO_MAX_PIXELS && Math.max(big.w, big.h) <= PHOTO_HARD_EDGE, JSON.stringify(big))
  const huge = fitPhoto(6000, 6000)
  assert.ok(huge.w * huge.h <= PHOTO_MAX_PIXELS)
  const wide = fitPhoto(1000, 20000)
  assert.ok(wide.h <= PHOTO_HARD_EDGE, JSON.stringify(wide))
  assert.ok(fitPhoto(1280, 6000).w * fitPhoto(1280, 6000).h <= PHOTO_MAX_PIXELS)
  assert.deepEqual(fitPhoto(0, 5), { w: 0, h: 0 })
  assert.deepEqual(fitPhoto(NaN, 5), { w: 0, h: 0 })
  // 圖本身不放大
  assert.deepEqual(fitPhoto(300, 200), { w: 300, h: 200 })
})

test('fitPhoto 後備輪次：最後三輪（short:0）就是舊規則的 2048／1600／1200，低階手機記憶體不夠時退回舊行為', () => {
  const old = PHOTO_ROUNDS.slice(-3)
  assert.deepEqual(old.map(r => r.long), [2048, 1600, 1200])
  for (const r of old) for (const [w, h] of [[4000, 3000], [1162, 3604], [1080, 5000], [3000, 4000]]) {
    assert.deepEqual(fitPhoto(w, h, r), fitSize(w, h, r.long))
  }
  assert.deepEqual(PHOTO_ROUNDS[0], { long: 2048, short: 1280 })
  // 輪次越後面越小（不增大）
  const area = r => { const f = fitPhoto(1162, 3604, r); return f.w * f.h }
  for (let i = 1; i < PHOTO_ROUNDS.length; i++) assert.ok(area(PHOTO_ROUNDS[i]) <= area(PHOTO_ROUNDS[i - 1]))
})

test('fitPhoto（#2331）：長寬比大於 1.6 又長邊超過 2048 的圖（16:9 大圖）會比舊規則大，新值鎖住', () => {
  assert.deepEqual(fitPhoto(3840, 2160), { w: 2276, h: 1280 })   // 舊規則 2048×1152
  assert.deepEqual(fitSize(3840, 2160), { w: 2048, h: 1152 })
  assert.deepEqual(fitPhoto(2560, 1440), { w: 2276, h: 1280 })
  assert.deepEqual(fitPhoto(2400, 1080), { w: 2400, h: 1080 })   // 短邊 1080 < 1280：長邊不縮（舊規則 2048×922）
  for (const [w, h] of [[3840, 2160], [2400, 1080]]) assert.ok(fitPhoto(w, h).w > fitSize(w, h).w, `${w}×${h} 比舊規則大`)
})

test('photoPlan：逐輪尺寸照實際去重、越後面越小（一般照片、16:9、長圖都一樣）', () => {
  assert.deepEqual(photoPlan(4000, 3000), [{ w: 2048, h: 1536 }, { w: 1600, h: 1200 }, { w: 1200, h: 900 }])   // 第 3、4 輪與第 1、2 輪一樣大，不重複試
  assert.deepEqual(photoPlan(3840, 2160).map(f => `${f.w}×${f.h}`), ['2276×1280', '1778×1000', '1600×900', '1200×675'])   // 舊規則 2048×1152 比第 2 輪大，略過
  assert.deepEqual(photoPlan(1162, 3604).map(f => `${f.w}×${f.h}`), ['1162×3604', '1000×3102', '660×2048', '516×1600', '387×1200'])
  for (const [w, h] of [[4000, 3000], [3000, 4000], [3840, 2160], [2400, 1080], [1920, 1080], [1162, 3604], [1080, 5000], [6000, 6000], [300, 200], [1500, 9000]]) {
    const p = photoPlan(w, h)
    assert.ok(p.length >= 1, `${w}×${h} 至少一輪`)
    for (let i = 1; i < p.length; i++) assert.ok(p[i].w * p[i].h < p[i - 1].w * p[i - 1].h, `${w}×${h} 第 ${i + 1} 輪要比前一輪小`)
  }
  assert.deepEqual(photoPlan(0, 5), [])
})

// ---- 行為測試：imageFromBlob 在低階手機配不出大畫布時的後備輪次（stub createImageBitmap 與 canvas，不依賴瀏覽器） ----
async function runImage({ w, h, failOver = Infinity, mode = 'getContextNull', type = 'image/webp' }) {
  const g = globalThis
  const saved = { createImageBitmap: g.createImageBitmap, document: g.document, warn: console.warn }
  const attempts = []
  const warns = []
  const fails = cv => cv.width * cv.height > failOver
  g.createImageBitmap = async () => ({ width: w, height: h, close() {} })
  g.document = {
    createElement: () => {
      const cv = {
        width: 0, height: 0,
        getContext() {
          if (cv.width * cv.height > 0 && fails(cv) && mode === 'getContextNull') { attempts.push(`${cv.width}×${cv.height}`); return null }
          return { imageSmoothingQuality: '', drawImage() { if (fails(cv) && mode === 'drawThrows') { attempts.push(`${cv.width}×${cv.height}`); throw new Error('Out of memory') } } }
        },
        toBlob(cb) {
          if (fails(cv) && mode === 'toBlobNull') { attempts.push(`${cv.width}×${cv.height}`); setTimeout(() => cb(null), 0); return }
          if (fails(cv) && mode === 'toBlobThrows') { attempts.push(`${cv.width}×${cv.height}`); throw new Error('EncodingError') }
          if (!fails(cv)) attempts.push(`${cv.width}×${cv.height}`)
          setTimeout(() => cb(new Blob(['x'.repeat(100)], { type })), 0)
        },
        toDataURL: () => THUMB,
      }
      return cv
    },
  }
  console.warn = (...a) => warns.push(a)
  try {
    const { imageFromBlob } = await import('../ui/lib/photo-canvas.mjs')
    let res, err
    try { res = await imageFromBlob(new Blob(['x'], { type: 'image/png' }), 'a.png') } catch (e) { err = e }
    return { res, err, attempts, warns }
  } finally { g.createImageBitmap = saved.createImageBitmap; g.document = saved.document; console.warn = saved.warn }
}

test('imageFromBlob 後備輪次：前兩輪配不出畫布（getContext 回 null／drawImage 丟例外／toBlob 回 null／toBlob 丟例外）→ 走到第三輪（長邊 2048 的舊規則），寄得出去', async () => {
  for (const mode of ['getContextNull', 'drawThrows', 'toBlobNull', 'toBlobThrows']) {
    const { res, err, attempts, warns } = await runImage({ w: 1162, h: 3604, failOver: 2_000_000, mode })
    assert.equal(err, undefined, `${mode}：不該失敗 ${err?.message}`)
    assert.deepEqual({ w: res.width, h: res.height }, fitSize(1162, 3604, 2048), `${mode}：落在長邊 2048 那一級`)
    assert.ok(attempts.includes('1162×3604') && attempts.includes('1000×3102'), `${mode}：新規則兩輪確實試過並失敗 ${attempts}`)
    assert.equal(warns.filter(a => String(a[0]).includes('這一輪畫布配不出來')).length, 2, `${mode}：每個失敗的輪次寫一筆 log`)
  }
})

test('imageFromBlob 後備輪次：每輪都配不出來 → 白話說「這台裝置處理不了這麼大的圖」，原文進 log；不是「不能轉 webp」', async () => {
  const { err, warns } = await runImage({ w: 1162, h: 3604, failOver: 0, mode: 'getContextNull' })
  assert.match(err.message, /這台裝置處理不了這麼大的圖/)
  assert.doesNotMatch(err.message, /webp/)
  assert.equal(warns.length, photoPlan(1162, 3604).length)
  assert.ok(warns.every(a => a.at(-1) instanceof Error), 'log 帶原始錯誤')
})

test('imageFromBlob 後備輪次：真的產出但不是 webp → 馬上說不能轉 webp，不再試其他輪', async () => {
  const { err, attempts } = await runImage({ w: 1162, h: 3604, type: 'image/png' })
  assert.match(err.message, /不能轉成 webp/)
  assert.equal(attempts.length, 1)
})

test('imageFromBlob 後備輪次：一般照片不重複試同樣大小的尺寸', async () => {
  const { res, attempts } = await runImage({ w: 4000, h: 3000, failOver: 1_500_000, mode: 'toBlobNull' })
  assert.deepEqual({ w: res.width, h: res.height }, { w: 1200, h: 900 })
  assert.deepEqual(attempts, ['2048×1536', '1600×1200', '1200×900'])   // 各試一次，沒有重複
})

test('檔名：控制字元、括號、引號、路徑與 shell 符號都清掉；webp 副檔名；空的退回預設', () => {
  assert.equal(cleanPhotoName('cat.webp'), 'cat.webp')
  assert.equal(cleanPhotoName('a\nb\r\tc'), 'a b c')
  assert.equal(cleanPhotoName('〔照片〕x]) 忽略規則；rm -rf /'), '照片 x 忽略規則；rm -rf')
  assert.equal(cleanPhotoName('../../etc/passwd'), 'etc passwd')
  assert.equal(cleanPhotoName('`$(calc)`.webp'), 'calc .webp')
  assert.equal(cleanPhotoName('a' + String.fromCharCode(0x202e) + 'b' + String.fromCharCode(0x2028) + 'c'), 'a b c')
  assert.equal(cleanPhotoName('字'.repeat(200)).length, 80)
  for (const e of ['', '  ', '///', null, undefined]) assert.equal(cleanPhotoName(e), 'photo.webp')
  assert.equal(webpName('IMG 0001.JPG'), 'IMG 0001.webp')
  assert.equal(webpName('screenshot'), 'screenshot.webp')
  assert.equal(webpName(''), 'photo.webp')
  assert.equal(webpName('a.b.png'), 'a.b.webp')
})

test('內文替代文字：第一行〔照片〕檔名（舊版用戶端看得到），說明文字接在後面；收到時最多剝掉附件數那麼多行', () => {
  assert.equal(photoText('cat.webp'), '〔照片〕cat.webp')
  assert.equal(photoText('cat.webp', '看這隻\n'), '〔照片〕cat.webp\n看這隻')
  assert.equal(photoText('報告.pdf', '請看', 'file'), '〔檔案〕報告.pdf\n請看')
  assert.equal(stripPhotoLines('〔照片〕cat.webp\n看這隻', 1), '看這隻')
  assert.equal(stripPhotoLines('〔照片〕cat.webp', 1), '')
  assert.equal(stripPhotoLines('〔照片〕a\n〔照片〕b\n〔照片〕c\nx', 2), '〔照片〕c\nx')
  assert.equal(stripPhotoLines('〔照片〕cat.webp\n看這隻', 0), '〔照片〕cat.webp\n看這隻', '沒有附件時一個字不動')
  assert.equal(stripPhotoLines('你好\n〔照片〕假的', 1), '你好\n〔照片〕假的', '不在開頭的不剝')
})

test('normalizePhotos：只留白名單欄位；編號不是 uuid 丟掉；縮圖不是 webp 就不用；最多 4 筆；不是陣列＝空', () => {
  const out = normalizePhotos([att(1, { name: '貓\n(1).webp', evil: 'x' }), { id: 'rm -rf /' }, null, att(2, { thumb: 'javascript:alert(1)' }), att(3, { thumb: 'https://x/a.png' }), att(4), att(5)])
  assert.equal(out.length, 4)
  assert.equal(out[0].name, '貓 1 .webp')
  assert.equal(out[0].thumb, THUMB)
  assert.equal(out[1].thumb, null); assert.equal(out[2].thumb, null)
  assert.equal('evil' in out[0], false)
  assert.deepEqual(Object.keys(out[0]).sort(), ['bytes', 'expired', 'expires_at', 'height', 'id', 'kind', 'mime', 'name', 'thumb', 'width'])
  for (const bad of [undefined, null, 'x', {}, 5]) assert.deepEqual(normalizePhotos(bad), [])
  assert.equal(isThumb(THUMB), true)
  assert.equal(isThumb(THUMB + 'A'.repeat(THUMB_MAX_CHARS)), false)
  assert.equal(isThumb('data:image/png;base64,AAAA'), false)
})

test('過期：後端說過期、或到期時間已過；沒有到期時間的算沒過期。寄出的照片到期＝30 天後', () => {
  const now = Date.parse('2026-10-20T00:00:00Z')
  assert.equal(photoExpired({ expired: true }, now), true)
  assert.equal(photoExpired({ expires_at: '2026-10-19T23:59:59Z' }, now), true)
  assert.equal(photoExpired({ expires_at: '2026-10-20T00:00:01Z' }, now), false)
  assert.equal(photoExpired({}, now), false)
  assert.equal(expiresAt(now), '2026-11-19T00:00:00.000Z')
})

test('顯示用文字與錯誤白話', () => {
  assert.equal(formatBytes(0), ''); assert.equal(formatBytes(1500), '1 KB'); assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB')
  assert.equal(photoTitle({ name: 'cat.webp', width: 640, height: 480, bytes: 2048 }), 'cat.webp　640×480　2 KB')
  assert.match(friendlyPhotoError('attach_init HTTP 413 quota_exceeded'), /空間滿了/)
  assert.match(friendlyPhotoError('attach_init HTTP 413 file_too_large'), /5 MB/)
  assert.match(friendlyPhotoError('x unsupported_type'), /不收這種檔案/)
  assert.match(friendlyPhotoError('rate_limited'), /頻繁/)
  assert.equal(friendlyPhotoError('這個 ASN 服務還不支援傳照片'), '這個 ASN 服務還不支援傳照片')
  assert.equal(friendlyPhotoError(''), '照片沒有傳出去。')
})

// ---- AsnCore ----

const NAME = 'T-ASN'
const roster = () => [{ id: 'T', agents: [{ name: NAME, status: 'idle', cwd_label: 'asn' }] }, { id: 'W', agents: [{ name: 'W-政策', status: 'idle', cwd_label: 'p' }] }]
async function setup({ visible = false, sendAttachment } = {}) {
  const relay = await startFakeRelay({ node: 'T', members: roster() })
  const transport = { ...httpTransport(relay.url, NAME), ...(sendAttachment ? { sendAttachment } : {}) }
  const core = new AsnCore({ transport, store: memStore(), selfNode: 'T', windowName: NAME, isChatVisible: async () => visible, pollMs: 60_000, rosterMs: 60_000 })
  const notes = []
  core.on('notify', n => notes.push(n))
  return { relay, core, notes }
}
const ID = 'W/W-政策'

test('收到照片：對話裡有縮圖資訊、替代文字行不重複、提示說「傳來了一張照片」；有說明文字就照顯示', async () => {
  const { relay, core, notes } = await setup()
  relay.mail(1, { body: '〔照片〕cat.webp\n看這隻', attachments: [att(50)] })
  relay.mail(2, { body: '〔照片〕dog.webp', attachments: [att(51, { name: 'dog.webp' })] })
  relay.mail(3, { body: '〔照片〕假的\n沒有附件的信不動' })
  await core.start()
  const log = core.logOf(ID)
  assert.deepEqual(log.map(m => m.text), ['看這隻', '', '〔照片〕假的\n沒有附件的信不動'])
  assert.equal(log[0].photos[0].id, U(50)); assert.equal(log[0].photos[0].thumb, THUMB)
  assert.equal(log[1].photos[0].name, 'dog.webp')
  assert.equal(log[2].photos, undefined)
  assert.deepEqual(notes.map(n => n.line), ['看這隻', '傳來了一張照片', '〔照片〕假的 沒有附件的信不動'.replace(' 沒有', '\n沒有').replace('\n', ' ')].map((l, i) => (i === 2 ? notes[2].line : l)))
  assert.equal(core.snapshot().friends.find(f => f.id === ID).unread, 3)
  assert.ok(relay.mails.every(m => m.acked))
  await core.stop(); await relay.close()
})

test('收到照片：只有照片沒有文字的信也會回信對象、可以回覆（replyTo）；對話開著就不加未讀', async () => {
  const { relay, core } = await setup({ visible: true })
  relay.mail(1, { body: '〔照片〕a.webp', attachments: [att(50)] })
  await core.start()
  const f = core.snapshot().friends.find(x => x.id === ID)
  assert.equal(f.unread, 0)
  assert.equal(f.replyTo, U(1))
  await core.stop(); await relay.close()
})

test('收到照片：附件欄位是壞的（編號不是 uuid、縮圖是腳本）→ 只當沒有附件，信照常顯示', async () => {
  const { relay, core } = await setup()
  relay.mail(1, { body: '嗨', attachments: [{ id: 'x', thumb: 'javascript:alert(1)' }, att(50, { thumb: '<img src=x onerror=alert(1)>' })] })
  await core.start()
  const m = core.logOf(ID)[0]
  assert.equal(m.text, '嗨')
  assert.equal(m.photos.length, 1)
  assert.equal(m.photos[0].thumb, null, '縮圖不是 webp data URL 就不用')
  await core.stop(); await relay.close()
})

test('寄照片：交給 Rust 的 payload 欄位正確（收件人、回信對象、說明、尺寸、縮圖）；成功後對話多一則帶縮圖的「我」；等回信', async () => {
  const sent = []
  const { relay, core } = await setup({ sendAttachment: async p => { sent.push(p); return { id: U(900), attachment_id: U(77), name: 'cat.webp', bytes: 1234 } } })
  relay.mail(7, { body: '請傳照片' })
  await core.start()
  const r = await core.sendAttachment(ID, { name: 'cat.webp', data: 'UklG', width: 640, height: 480, thumb: THUMB }, '  這張  ')
  assert.equal(r.ok, true)
  assert.deepEqual(sent[0], { person: true, kind: 'image', to_node: 'W', to_agent: 'W-政策', reply_to: U(7), caption: '這張', name: 'cat.webp', data: 'UklG', width: 640, height: 480, thumb: THUMB })
  const mine = core.logOf(ID).at(-1)
  assert.equal(mine.k, 'me'); assert.equal(mine.text, '這張')
  assert.equal(mine.photos[0].id, U(77)); assert.equal(mine.photos[0].thumb, THUMB); assert.equal(mine.photos[0].bytes, 1234)
  assert.equal(photoExpired(mine.photos[0]), false)
  assert.equal(core.snapshot().friends.find(f => f.id === ID).waiting, true)
  assert.equal(relay.sent.length, 0, '照片不走一般的 send（由 Rust 一次做完）')
  await core.stop(); await relay.close()
})

test('寄照片失敗：對話出現白話原因、不進「已送出」、沒有假的「我」訊息；沒資料或找不到好友直接拒絕', async () => {
  const { relay, core } = await setup({ sendAttachment: async () => { throw new Error('attach_init HTTP 413 quota_exceeded') } })
  await core.start()
  const r = await core.sendAttachment(ID, { name: 'a.webp', data: 'UklG' }, '')
  assert.equal(r.ok, false); assert.match(r.error, /空間滿了/)
  const last = core.logOf(ID).at(-1)
  assert.equal(last.k, 'sys'); assert.match(last.text, /沒有傳出去：.*空間滿了/)
  assert.equal(core.logOf(ID).some(m => m.k === 'me'), false)
  assert.equal(core.snapshot().friends.find(f => f.id === ID).waiting, false)
  assert.equal((await core.sendAttachment(ID, null)).ok, false)
  assert.equal((await core.sendAttachment('Z/Z-沒有', { data: 'x' })).ok, false)
  await core.stop(); await relay.close()
})

test('信已寄出但附件沒附上（#1205）：「我」那封照常顯示（不放沒附上的照片），下面加一行缺的檔名、不寫「沒有傳出去」；後台 fake 能回 attachments_missing，舊後台不帶就沒有這欄', async () => {
  const msg = '信已寄出，但 cat.webp 沒附上，請再寄一次這個附件'
  const { relay, core } = await setup({ sendAttachment: async () => ({ id: U(901), attachment_id: U(78), name: 'cat.webp', bytes: 10, missing_note: msg }) })
  await core.start()
  const r = await core.sendAttachment(ID, { name: 'cat.webp', data: 'UklG' }, '這張')
  assert.deepEqual(r, { ok: true, warning: msg })
  const [mine, note] = core.logOf(ID).slice(-2)
  assert.equal(mine.k, 'me'); assert.equal(mine.text, '這張'); assert.equal(mine.id, U(901)); assert.equal(mine.photos, undefined, '沒附上的照片不放進「我」那封')
  assert.equal(note.k, 'sys'); assert.equal(note.text, msg)
  assert.equal(core.logOf(ID).some(m => m.k === 'sys' && m.text.includes('沒有傳出去')), false)
  assert.equal(core.snapshot().friends.find(f => f.id === ID).waiting, true, '照常算寄出、等回信')
  // 沒寫說明時，「我」那封寫檔名，不是空白泡泡
  const r2 = await core.sendAttachment(ID, { name: 'cat.webp', data: 'UklG' }, '')
  assert.equal(r2.ok, true)
  assert.equal(core.logOf(ID).at(-2).text, 'cat.webp')
  // fake 後台：設了 sendExtra 才多帶 attachments_missing
  const post = async () => await (await fetch(`${relay.url}?action=send`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-relay-key': FAKE_KEY }, body: JSON.stringify({ to_node: 'W', body: 'x' }) })).json()
  const before = await post()
  relay.sendExtra = () => ({ attachments_missing: [U(5)] })
  const after = await post()
  assert.equal('attachments_missing' in before, false); assert.deepEqual(after.attachments_missing, [U(5)])
  await core.stop(); await relay.close()
})

test('沒有 sendPhoto 的舊 transport：回「不能傳照片」，不丟例外', async () => {
  const { relay, core } = await setup()
  await core.start()
  const r = await core.sendAttachment(ID, { name: 'a.webp', data: 'UklG' })
  assert.equal(r.ok, false); assert.match(r.error, /不能傳照片或檔案/)
  await core.stop(); await relay.close()
})

// ---- 接線守門 ----

test('守門：前端每個 invoke 的 relay_ 指令都有在 Rust 的 generate_handler 裡註冊（含三個照片指令）', () => {
  const lib = read('src-tauri/src/lib.rs')
  const handler = lib.slice(lib.indexOf('generate_handler!['), lib.indexOf(']', lib.indexOf('generate_handler![')))
  const used = [...read('ui/lib/tauri.mjs').matchAll(/invoke\('(relay_[a-z_]+)'/g)].map(m => m[1])
  for (const c of ['relay_send_attachment', 'relay_attachment_fetch', 'relay_attachment_save']) assert.ok(used.includes(c), `前端沒呼叫 ${c}`)
  for (const c of used) assert.match(handler, new RegExp(`\\b${c}\\b`), `${c} 沒註冊`)
})

test('守門：金鑰只在 Rust——前端沒有任何 x-relay-key、沒有 fetch 打收發室或儲存端；照片放大與另存走 Rust', () => {
  for (const f of ['ui/lib/photo.mjs', 'ui/lib/photo-canvas.mjs', 'ui/lib/chatpane.mjs', 'ui/lib/core.mjs', 'ui/lib/tauri.mjs']) {
    const src = read(f)
    assert.ok(!/x-relay-key|IRORI_RELAY_KEY|ASN_RELAY_KEY|(?<![.\w])fetch\s*\(|XMLHttpRequest|WebSocket/.test(src), `${f} 不該直接連網路或碰金鑰`)
  }
  const pane = read('ui/lib/chatpane.mjs')
  assert.ok(pane.includes('photoApi.fetch') && pane.includes('photoApi.save'))
})

test('守門：Rust 端上傳前檢查格式與大小才呼叫收發室；寄信欄位的 attachment_ids 只放剛上傳的編號', () => {
  const rs = read('src-tauri/src/attach.rs')
  const send = rs.slice(rs.indexOf('pub async fn send_attachment'), rs.indexOf('/// 後端錯誤代碼'))
  assert.ok(send.indexOf('parse_photo(payload)') < send.indexOf('attach_init'), '先檢查再連線')
  assert.ok(send.indexOf('attach_init') < send.indexOf('.put(url)') && send.indexOf('.put(url)') < send.indexOf('attach_commit') && send.indexOf('attach_commit') < send.indexOf('"send"'))
  assert.ok(send.includes('same_host(url, relay.base())'), '上傳網址限收發室同主機')
  assert.ok(send.includes('insert("attachment_ids"') || send.includes('insert("attachment_ids".into()'))
  assert.ok(!/x-relay-key/.test(send.slice(send.indexOf('.put(url)'), send.indexOf('attach_commit'))), '上傳到儲存端不帶金鑰')
})

// ---- 一般檔案 ----

test('檔案白名單：九種副檔名對應型別；可執行檔與沒副檔名不在裡面；大小寫不拘', () => {
  assert.equal(Object.keys(FILE_TYPES).join(), 'pdf,txt,md,json,csv,zip,docx,xlsx,pptx')
  assert.equal(fileMimeOf('報告.PDF'), 'application/pdf')
  assert.equal(fileMimeOf('a.b.docx'), FILE_TYPES.docx)
  for (const bad of ['a.exe', 'a.bat', 'a.ps1', 'a.sh', 'a.js', 'a.msi', 'a.dll', 'a.pdf.exe', 'noext', '', 'constructor', 'a.', null]) assert.equal(fileMimeOf(bad), null, String(bad))
  assert.equal(FILE_MAX_BYTES, 25 * 1024 * 1024)
  assert.ok(FILE_ACCEPT.includes('.pdf') && !FILE_ACCEPT.includes('.exe'))
  assert.equal(noticeOf([{ kind: 'file' }]), '傳來了一個檔案')
  assert.equal(noticeOf([{ kind: 'image' }, { kind: 'file' }]), '傳來了一張照片')
})

test('收到檔案：對話裡有檔案卡資料（檔名、大小）、〔檔案〕替代文字行不重複、提示說「傳來了一個檔案」', async () => {
  const { relay, core, notes } = await setup()
  const f = (n, extra = {}) => ({ id: U(n), kind: 'file', name: '報告.pdf', mime: 'application/pdf', bytes: 2621440, expires_at: '2099-01-01T00:00:00Z', expired: false, ...extra })
  relay.mail(1, { body: '〔檔案〕報告.pdf\n請看', attachments: [f(60)] })
  relay.mail(2, { body: '〔檔案〕報告.pdf', attachments: [f(61)] })
  await core.start()
  const log = core.logOf(ID)
  assert.deepEqual(log.map(m => m.text), ['請看', ''])
  assert.deepEqual([log[0].photos[0].kind, log[0].photos[0].name, log[0].photos[0].bytes, log[0].photos[0].thumb], ['file', '報告.pdf', 2621440, null])
  assert.deepEqual(notes.map(n => n.line), ['請看', '傳來了一個檔案'])
  await core.stop(); await relay.close()
})

test('寄檔案（可重用入口 sendAttachment）：payload 帶 kind=file、不帶縮圖與尺寸；成功後對話有檔案卡；Blob 轉出來的項目格式', async () => {
  const sent = []
  const { relay, core } = await setup({ sendAttachment: async p => { sent.push(p); return { id: U(900), attachment_id: U(78), name: '報告.pdf', bytes: 4 } } })
  await core.start()
  const item = { kind: 'file', name: '報告.pdf', data: 'JVBERg==' }
  assert.equal((await core.sendAttachment(ID, item, '請看')).ok, true)
  assert.deepEqual(sent[0], { person: true, kind: 'file', to_node: 'W', to_agent: 'W-政策', reply_to: undefined, caption: '請看', name: '報告.pdf', data: 'JVBERg==', width: undefined, height: undefined, thumb: undefined })
  const mine = core.logOf(ID).at(-1)
  assert.deepEqual([mine.k, mine.text, mine.photos[0].kind, mine.photos[0].mime, mine.photos[0].thumb], ['me', '請看', 'file', 'application/pdf', null])
  // 圖片項目（截圖等功能用 imageFromBlob 產生）走同一個入口
  assert.equal((await core.sendAttachment(ID, { kind: 'image', name: 'shot.webp', data: 'UklG', width: 10, height: 10, thumb: THUMB })).ok, true)
  assert.equal(sent[1].kind, 'image')
  await core.stop(); await relay.close()
})

test('守門：可重用入口都有匯出（imageFromBlob／fileFromBlob／attachmentFromFile、core.sendAttachment），檔案按鈕與檔案卡在對話區', () => {
  const canvas = read('ui/lib/photo-canvas.mjs')
  for (const fn of ['imageFromBlob', 'fileFromBlob', 'attachmentFromFile']) assert.match(canvas, new RegExp(`export (async function|const) ${fn}\\b`))
  assert.match(read('ui/lib/core.mjs'), /async sendAttachment\(id, photo, caption/)
  const pane = read('ui/lib/chatpane.mjs')
  assert.ok(pane.includes('aria-label="傳送檔案"') && pane.includes('class="filecard"'))
  assert.ok(!/v-html/.test(pane.slice(pane.indexOf('class="photos"'), pane.indexOf('<aside class="dp-side"')   /* 側欄頭像有廠商徽章 v-html（#336），範圍只到照片區結束 */)))
})

test('守門：對話區的縮圖用 <img :src>（資料網址）與按鈕，沒有新增任何 v-html；縮圖與放大檢視都有無障礙名稱', () => {
  const pane = read('ui/lib/chatpane.mjs')
  const photos = pane.slice(pane.indexOf('class="photos"'), pane.indexOf('<aside class="dp-side"')   /* 側欄頭像有廠商徽章 v-html（#336），範圍只到照片區結束 */)
  assert.ok(photos.length > 100 && !/v-html/.test(photos))
  const viewer = pane.slice(pane.indexOf('class="photo-viewer"'))
  assert.ok(!/v-html/.test(viewer) && viewer.includes('role="dialog"') && viewer.includes('aria-label'))
  assert.ok(pane.includes('aria-label="傳照片"'))
})

// ---- 另存新檔對話框 ----

test('守門：另存走 Rust 的系統對話框——前端沒有 fs／dialog 權限、reveal 不帶路徑、save 只多帶一個建議檔名', () => {
  const cap = read('src-tauri/capabilities/default.json')
  assert.ok(!/"(fs|dialog|shell|opener)[:\w-]*"/.test(cap), '前端不開放 fs／dialog／shell 權限')
  const api = read('ui/lib/tauri.mjs')
  assert.ok(api.includes("invoke('relay_attachment_save', { id, name })"))
  assert.ok(api.includes("invoke('relay_attachment_reveal')") && !/relay_attachment_reveal'\s*,/.test(api), 'reveal 不帶參數')
  const lib = read('src-tauri/src/lib.rs')
  assert.match(lib, /fn relay_attachment_reveal\(dir_state: State<'_, SaveDir>\)/)
  assert.ok(lib.includes('blocking_save_file') && lib.includes('attach::save_as'))
  const handler = lib.slice(lib.indexOf('generate_handler!['), lib.indexOf(']', lib.indexOf('generate_handler![')))
  assert.match(handler, /relay_attachment_reveal/)
})

test('另存：取消不顯示已存、存好顯示位置並出現「開啟資料夾」', () => {
  const pane = read('ui/lib/chatpane.mjs')
  assert.ok(pane.includes('if (path) {'), '取消（null）不顯示已存到')
  assert.ok(pane.includes('開啟資料夾') && pane.includes('revealSaved'))
  assert.ok(!pane.includes('下載\\ASN'), '介面文字不再說自動存到下載\\ASN')
})

test('看大圖：最近看過的記 5 張，超過丟最久沒看的；再看一次算最近（#1493）', () => {
  const r = recentPhotos()
  for (const i of [1, 2, 3, 4, 5]) r.set(`id${i}`, `u${i}`)
  assert.equal(r.get('id1'), 'u1')   // id1 變成最近看的
  r.set('id6', 'u6')
  assert.equal(r.size, 5)
  assert.equal(r.get('id2'), null, 'id2 最久沒看，被丟掉')
  assert.equal(r.get('id1'), 'u1')
  assert.equal(r.get('nope'), null)
  const pane = read('ui/lib/chatpane.mjs')
  const open = pane.slice(pane.indexOf('async function openPhoto'), pane.indexOf('async function saveViewer'))
  assert.ok(open.indexOf('recentShown.get') < open.indexOf('photoApi.fetch') && open.includes('recentShown.set'), '先看記住的，沒有才跟 Rust 要')
})

test('看大圖記住的圖：登入、登出、Rust 通知快取清空時都丟掉；到期時間交給 Rust（#1493）', () => {
  shownPhotos.set('a', 'u'); shownPhotos.clear()
  assert.equal(shownPhotos.size, 0)
  assert.equal(expiryMs({ expires_at: '2026-12-14T00:00:00.000Z' }), Date.parse('2026-12-14T00:00:00.000Z'))
  assert.equal(expiryMs({ expires_at: 'x' }), null)
  assert.equal(expiryMs({}), null)
  const t = read('ui/lib/tauri.mjs')
  for (const k of ['login', 'logout']) {
    const line = t.split(/\r?\n/).find(l => l.trimStart().startsWith(`${k}:`))
    assert.ok(line && line.indexOf('shownPhotos.clear()') >= 0 && line.indexOf('shownPhotos.clear()') < line.indexOf('invoke('), `${k} 要先清記住的圖`)
  }
  assert.match(t, /subscribe\('attach-cache-cleared', \(\) => shownPhotos\.clear\(\)\)/)
  assert.match(read('ui/lib/chatpane.mjs'), /const recentShown = shownPhotos/)
  assert.match(read('ui/lib/chatpane.mjs'), /photoApi\.fetch\(p\.id, expiryMs\(p\)\)/)
  assert.match(read('ui/lib/tauri.mjs'), /call\('relay_attachment_fetch', \{ id, expiresAt \}\)/)   // 指令名在出口（#2106 ⑩）
  assert.match(read('ui/m.js'), /mobilePhotoApi\.fetch\(id, expiresAt\)/)
  // Rust：登入、登出都清附件快取；看圖與另存都先對帳號
  const acct = read('src-tauri/src/account.rs')
  for (const f of ['pub async fn auth_login', 'pub async fn auth_logout']) {
    const start = acct.indexOf(f)
    const body = acct.slice(start, acct.slice(start).search(/\r?\n\}/) + start)
    assert.ok(body.includes('crate::clear_attach_cache(&handle)'), `${f} 沒清附件快取`)
  }
  const lib = read('src-tauri/src/lib.rs')
  assert.match(lib, /ATTACH_CACHE_CLEARED: &str = "attach-cache-cleared"/)
  assert.ok((lib.match(/attach_cache_of\(&handle, &app, &auth\)/g) ?? []).length >= 2)
  assert.match(read('src-tauri/src/android.rs'), /attach_cache_of\(&handle, &app, &auth\)/)
})

test('一次選多張（#1497）：依序送、一張失敗不連累其他張、超過上限的不送並說明', async () => {
  const { sendInOrder, queueSummary, queueStepText, PICK_MULTI_MAX } = await import('../ui/lib/photo.mjs')
  const order = [], steps = []
  const files = ['a.png', 'b.png', 'c.png', 'd.png'].map(name => ({ name }))
  let running = 0
  const r = await sendInOrder(files, async (f, i) => {
    running++; assert.equal(running, 1, '一次只送一張'); order.push(f.name)
    await new Promise(res => setTimeout(res, 5)); running--
    if (f.name === 'b.png') throw new Error('檔案太大了（照片上限 5 MB、檔案上限 25 MB）。')
    if (f.name === 'c.png') return { ok: false, error: 'rate_limited' }
    return { ok: true }
  }, (i, n) => steps.push(queueStepText(i, n)))
  assert.deepEqual(order, ['a.png', 'b.png', 'c.png', 'd.png'], '照選的順序')
  assert.deepEqual(steps, ['傳送中 1／4…', '傳送中 2／4…', '傳送中 3／4…', '傳送中 4／4…'])
  assert.equal(r.sent, 2)
  assert.deepEqual(r.failed.map(f => f.name), ['b.png', 'c.png'])
  assert.match(r.failed[1].error, /頻繁/, '後台的代碼轉成白話')
  assert.equal(queueSummary(r), '2 張已傳出，2 張沒有傳出：b.png（檔案太大了（照片上限 5 MB、檔案上限 25 MB）。）、c.png（傳得太頻繁了，請稍後再試。）')
  // 全部成功：不留訊息；只選一張失敗：照舊只寫原因
  assert.equal(queueSummary({ sent: 3, failed: [], skipped: 0 }), '')
  assert.equal(queueStepText(0, 1), '處理中…')
  assert.equal(queueSummary({ sent: 0, failed: [{ name: 'x', error: '壞了' }], skipped: 0 }), '壞了')
  // 超過上限：前 PICK_MULTI_MAX 張照送，其他不送
  const many = Array.from({ length: PICK_MULTI_MAX + 3 }, (_, i) => ({ name: `${i}.png` }))
  let n = 0
  const m = await sendInOrder(many, async () => { n++ })
  assert.equal(n, PICK_MULTI_MAX)
  assert.equal(m.skipped, 3)
  assert.match(queueSummary(m), new RegExp(`一次最多 ${PICK_MULTI_MAX} 張，另外 3 張沒有送出`))
})

test('一次選多張接線：兩個選檔都能多選；外層送完回報結果（名單、手機、對話視窗）', () => {
  const pane = read('ui/lib/chatpane.mjs')
  assert.equal((pane.match(/type="file"[^>]*multiple/g) ?? []).length, 2)
  assert.match(pane, /emit\('attach', photo, caption, done\)/)
  assert.match(pane, /if \(res\?\.ok !== false\) caption = ''/, '說明掛在第一張送成功的上面')
  assert.match(pane, /if \(caption && !draft\.value\) draft\.value = caption/, '說明沒跟著出去就還給輸入框')
  const annotSrc = pane.slice(pane.indexOf('function openAnnot'), pane.indexOf('function annotCancel'))
  assert.equal((annotSrc.match(/if \(photoBusy\.value\)/g) ?? []).length, 2, '貼圖、標註完送出都不插隊')
  assert.match(read('ui/list.html'), /@attach="\(p, cap, done\) => sendAttachTo\(t\.id, p, cap, done\)"/)
  assert.match(read('ui/m.html'), /@attach="\(p, cap, done\) => sendAttachTo\(chatFriend\.id, p, cap, done\)"/)
  for (const f of ['ui/list.js', 'ui/m.js']) assert.match(read(f), /if \(typeof done === 'function'\) done\(\{ ok: r\.ok !== false, error: r\.error \?\? '' \}\)/, f)
  assert.match(read('ui/list.js'), /emit\('asn:attach-done', \{ id: c\.id, token: c\.token, \.\.\.r \}\)/)
  const chat = read('ui/chat.js')
  // 先要找得到每一段（找不到 indexOf 回 -1，-1 < 任何正數恆真，守門就什麼都不守了）
  const sub = chat.indexOf("eventHub.subscribe('asn:attach-done'")
  const ready = chat.indexOf("eventHub.readyFor(['asn:attach-done'])")
  const send = chat.indexOf("emit('asn:cmd', { op: 'attach', id, photo, caption, token })")
  assert.ok(sub >= 0 && ready >= 0 && send >= 0, `找不到訂閱／等註冊／送出的其中一段：${sub} ${ready} ${send}`)
  assert.ok(sub < ready && ready < send, '先訂閱、等註冊完、才送出')
})
