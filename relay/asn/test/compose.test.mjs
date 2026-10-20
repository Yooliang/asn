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
} from '../ui/lib/compose.mjs'

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')

test('輸入提示：整合模式用較短 placeholder，完整說明放在 title', () => {
  assert.equal(composePlaceholder('merged'), COMPOSE_HINT_MERGED)
  assert.equal(composePlaceholder('split'), COMPOSE_HINT_FULL)
  assert.equal(composeHintTitle('split'), '')
  assert.equal(composeHintTitle('merged'), COMPOSE_HINT_FULL)
  assert.ok(COMPOSE_HINT_MERGED.length < COMPOSE_HINT_FULL.length)
})

test('守門：ChatPane 接上 compose 提示與 win-mode；輸入列大頭貼條件與 main 相同', () => {
  const pane = fs.readFileSync(path.join(UI, 'lib', 'chatpane.mjs'), 'utf8')
  assert.ok(pane.includes('composePlaceholder(props.winMode)'))
  assert.ok(pane.includes(':placeholder="composeHint"'))
  assert.ok(pane.includes('v-if="sideCol"'))
  assert.ok(pane.includes('v-if="sideCol && !collapsed"'))
  const html = fs.readFileSync(path.join(UI, 'list.html'), 'utf8')
  assert.ok(html.includes(':win-mode="ui.mode"'))
  const css = fs.readFileSync(path.join(UI, 'style.css'), 'utf8')
  assert.ok(css.includes('.composer textarea::placeholder{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'))
})
