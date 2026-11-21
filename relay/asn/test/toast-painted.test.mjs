// #1953：提示視窗畫完要回報 toast_painted，--shot 截圖才知道可以拍（拍到透明視窗＝拍到底下的對話視窗）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n')

test('#1953 toast.js 掛載後等兩個 requestAnimationFrame 才呼叫 toast_painted', () => {
  const js = read('ui', 'toast.js')
  assert.match(js, /\.mount\('#app'\)[\s\S]*requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => \{ invoke\('toast_painted'\)/)
})

test('#1953 toast_painted 登記成指令、Painted 狀態有註冊，且只在電腦端', () => {
  const lib = read('src-tauri', 'src', 'lib.rs')
  assert.ok(lib.includes('wins::toast_painted'))
  assert.ok(lib.includes('.manage(wins::Painted::default())'))
  const wins = read('src-tauri', 'src', 'wins.rs')
  assert.match(wins, /WindowEvent::Destroyed[\s\S]{0,80}forget\(/, '關窗要清掉記錄')
  assert.ok(!/toast_painted/.test(read('ui', 'm.html')), '手機頁面不碰提示視窗指令')
})
