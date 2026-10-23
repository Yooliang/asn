// 語音辨識文字整理（移植自 Irori 的 VoiceActivityTests／SttText 測試）：整句靜音幻覺丟掉，真正的話（就算提到這些字）保留。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fullWidthPunctuation, isHallucination, normalize, s2t } from '../ui/lib/stt-text.mjs'
import { SIMPLIFIED, TRADITIONAL } from '../ui/lib/s2t-table.mjs'

const DROPPED = [
  '（字幕製作:貝爾）', '字幕製作：貝爾', '(字幕製作:貝爾）', '字幕by索蘭婭', '中文字幕志愿者 李宗盛',
  '謝謝觀看', '谢谢观看！', '謝謝大家的收看。', '請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目', '请订阅我的频道',
  '由 Amara.org 社群提供的字幕', '字幕由 Amara 社群提供', '中文字幕提供：小明', 'Thanks for watching!', '我們下期再見',
]
const KEPT = [
  '我在做字幕製作的工作', '字幕怎麼不見了', '字幕太小了', '字幕', '中文字幕可以開嗎', '幫我訂閱這個頻道好嗎',
  '謝謝你', '拜拜', '翻譯一下這句', '今天天氣很好', '謝謝觀看，那我們明天去海邊吧',
]

test('整句都是靜音幻覺：判成幻覺，整理後變空字串', () => {
  for (const raw of DROPPED) {
    assert.equal(isHallucination(raw), true, raw)
    assert.equal(normalize(raw), '', raw)
  }
})

test('真正的話就算提到這些字也保留（不誤殺）', () => {
  for (const raw of KEPT) {
    assert.equal(isHallucination(raw), false, raw)
    assert.notEqual(normalize(raw), '', raw)
  }
  assert.equal(isHallucination(''), false)
  assert.equal(isHallucination('   '), false)
  assert.equal(normalize(''), '')
  assert.equal(normalize(null), '')
})

test('雜訊標記、只剩標點都算空；括號整段去掉', () => {
  for (const raw of ['[音樂]', '(掌聲)', '（笑）', '♪♪', '【字幕】', '...', '，。', ' ']) assert.equal(normalize(raw), '', raw)
  assert.equal(normalize('你好 [音樂] 嗎'), '你好嗎')
})

test('簡轉繁：字對字，有歧義的不動', () => {
  assert.equal(s2t('谢谢观看'), '謝謝觀看')
  assert.equal(s2t('今天天气很好，我们去海边'), '今天天氣很好，我們去海邊')
  assert.equal(s2t('hello 123'), 'hello 123')
  assert.equal(normalize('请帮我订一张机票'), '請幫我訂一張機票')
  assert.equal([...SIMPLIFIED].length, [...TRADITIONAL].length)
  assert.equal([...SIMPLIFIED].length, 2571)
})

test('中文字之間的空白拿掉、中英交界保留；半形標點接在中文後換全形', () => {
  assert.equal(normalize('你 好 嗎'), '你好嗎')
  assert.equal(normalize('打開 Chrome 瀏覽器'), '打開 Chrome 瀏覽器')
  assert.equal(fullWidthPunctuation('你好,世界.'), '你好，世界。')
  assert.equal(fullWidthPunctuation('hello, world.'), 'hello, world.')
  assert.equal(normalize('今天天氣好嗎?'), '今天天氣好嗎？')
})

test('提示詞被念回來：整句、片段、重複都丟掉；短片段與真的話保留', async () => {
  const { isPromptEcho } = await import('../ui/lib/stt-text.mjs')
  for (const raw of ['請使用正確的標點符號。', '以下是繁体中文的句子，请使用正確的標點符號。', '以下是繁體中文的句子，', '請使用正確的標點符號。 請使用正確的標點符號。', ' 請使用正確的標點符號 ']) {
    assert.equal(isPromptEcho(raw), true, raw)
    assert.equal(isHallucination(raw), true, raw)
    assert.equal(normalize(raw), '', raw)
  }
  for (const raw of ['標點符號', '請使用正確的方法開門', '', '。', '你好']) assert.equal(isPromptEcho(raw), false, raw)
  for (const raw of ['。', '，', '?', '', '  ', '…']) assert.equal(normalize(raw), '', raw)
})

test('提示詞要和 Rust 的 stt.rs 一致', async () => {
  const { STT_PROMPTS } = await import('../ui/lib/stt-text.mjs')
  const fs = await import('node:fs')
  const rs = fs.readFileSync(new URL('../src-tauri/src/stt.rs', import.meta.url), 'utf8')
  for (const p of STT_PROMPTS) assert.ok(rs.includes('"' + p + '"'), p)
})
