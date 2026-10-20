import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMPOSE_HINT_FULL,
  COMPOSE_HINT_MERGED,
  composeHintTitle,
  composePlaceholder,
  showComposeSideCol,
  showComposeSideSpacer,
} from '../ui/lib/compose.mjs'

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')

test('輸入提示：整合模式用較短 placeholder，完整說明放在 title', () => {
  assert.equal(composePlaceholder('merged'), COMPOSE_HINT_MERGED)
  assert.equal(composePlaceholder('split'), COMPOSE_HINT_FULL)
  assert.equal(composeHintTitle('split'), '')
  assert.equal(composeHintTitle('merged'), COMPOSE_HINT_FULL)
  assert.ok(COMPOSE_HINT_MERGED.length < COMPOSE_HINT_FULL.length)
})

test('輸入列大頭貼：整合模式一律顯示；分離模式與對話區側欄對齊', () => {
  assert.equal(showComposeSideCol('merged', 'left', false), true)
  assert.equal(showComposeSideCol('merged', 'left', true), true)
  assert.equal(showComposeSideCol('merged', 'inline', false), true)
  assert.equal(showComposeSideSpacer('merged', 'left'), true)
  assert.equal(showComposeSideSpacer('merged', 'inline'), false)
  assert.equal(showComposeSideCol('split', 'left', false), true)
  assert.equal(showComposeSideCol('split', 'left', true), false)
  assert.equal(showComposeSideSpacer('split', 'inline'), false)
})

test('守門：ChatPane 接上 compose 提示與 win-mode；placeholder 不換行樣式', () => {
  const pane = fs.readFileSync(path.join(UI, 'lib', 'chatpane.mjs'), 'utf8')
  assert.ok(pane.includes('composePlaceholder(props.winMode)'))
  assert.ok(pane.includes(':placeholder="composeHint"'))
  assert.ok(pane.includes('showComposeSideCol(props.winMode'))
  assert.ok(pane.includes('sideCol && !collapsed'))
  const html = fs.readFileSync(path.join(UI, 'list.html'), 'utf8')
  assert.ok(html.includes(':win-mode="ui.mode"'))
  const css = fs.readFileSync(path.join(UI, 'style.css'), 'utf8')
  assert.ok(css.includes('.composer textarea::placeholder'))
  assert.ok(css.includes('white-space:nowrap'))
  assert.ok(!css.includes('.shell.merged .compose-row'))
})
