// 截圖標註畫面下方的說明文字（#392）：.annot 是白字，輸入框又會繼承字色（button,input{color:inherit}），沒設底色就變白底白字
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const css = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8')
const rule = sel => css.split('\n').find(l => l.startsWith(sel + '{')) ?? ''

test('說明文字輸入框自己設字色與底色，不吃標註畫面的白字', () => {
  assert.match(rule('.annot'), /color:#fff/, '前提：標註畫面是白字')
  const cap = rule('.an-cap')
  assert.match(cap, /background:var\(--panel\)/)
  assert.match(cap, /color:var\(--fg\)/)
})
