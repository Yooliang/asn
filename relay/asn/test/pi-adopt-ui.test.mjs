// 0.2 A5：接手使用者自己開的 pi（前景程序條目）。選單叫「接手」（跟 Grok 一致，用詞放在常數），要勾選確認才送；對話框照實寫會先關掉原本的 pi
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ADOPT_LABEL, PI_ADOPT_ACK, buildOpRequest, dialogEngine, isPiAdoptable, menuItems, opFormError, progressView } from '../ui/lib/partner-ops.mjs'
import { opDialogText } from '../ui/lib/partner-ops-ui.mjs'

const ctx = { machines: { H: { online: true, launcher: { profiles: [{ id: 'pi' }] } } }, loaded: true, signedIn: true }
const proc = (agent, extra = {}) => ({ node: 'H', agent, entryKind: 'process', engine: 'pi', status: 'online', ...extra })

test('前景的 pi 程序條目可以「接手」；背景、別的引擎、不是程序條目都不行', () => {
  assert.equal(isPiAdoptable(proc('pi · MiniMax #4001（前景）')), true)
  assert.equal(isPiAdoptable(proc('pi #4001（背景）')), false)
  assert.equal(isPiAdoptable(proc('pico #1（前景）', { engine: 'pico' })), false)
  assert.equal(isPiAdoptable({ node: 'H', agent: 'Pi妹妹', engine: 'pi' }), false, '已經由 ASN 管理的 pi 視窗不是接手的對象')
  const items = menuItems(proc('pi #4001（前景）'), ctx)
  const h = items.find(i => i.key === 'handover')
  assert.deepEqual([h.label, h.ok], [ADOPT_LABEL, true])
  assert.equal(ADOPT_LABEL, '接手')
  assert.ok(items.filter(i => i.key !== 'handover').every(i => !i.ok), '其餘項目照舊只能顯示')
  assert.equal(dialogEngine(proc('pi #4001（前景）')), 'pi_adopt')
})

test('要勾選確認才送；送出的請求就是 handover（後台不用改）', () => {
  const f = proc('pi #4001（前景）')
  const item = menuItems(f, ctx).find(i => i.key === 'handover')
  assert.match(opFormError(f, 'handover', { ack: false }, item), /先勾選確認/)
  assert.equal(opFormError(f, 'handover', { ack: true }, item), '')
  assert.deepEqual(buildOpRequest(f, 'handover', {}), { node: 'H', name: 'pi #4001（前景）', op: 'handover' })
})

test('對話框照實寫：會先關掉原本的 pi、正在回覆會中斷、找不到對話不動、還沒講話要先講一句；確認鍵紅色', () => {
  const t = opDialogText('handover', 'pi #4001（前景）', '家用機', 'pi_adopt')
  assert.equal(t.ack, PI_ADOPT_ACK)
  assert.equal(t.danger, true)
  const all = t.points.join('\n')
  for (const re of [/會先關掉原本的 pi（終端機留著），再用同一段對話開一個由 ASN 管理的 pi。原本的 pi 如果正在回覆，這一輪會中斷/, /不只一段就不會接手，什麼都不關/, /先在 pi 裡講一句/, /手動接回的指令/]) assert.match(all, re)
})

test('完成的文字：說明原本的已關閉、新的名字', () => {
  const v = progressView({ status: 'ok', result: { kind: 'pi_adopt', name: 'pi-專案', kept_terminal: true } }, { op: 'handover' })
  assert.match(v.text, /原本的 pi 已關閉（終端機留著）.*「pi-專案」/)
})
