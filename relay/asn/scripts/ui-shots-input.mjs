// 真的輸入（滑鼠、觸控、按鍵、選檔）：探測靠頁面呼叫 __smokeInput，由這裡用偵錯協定送出。
// 內容逐字取自 scripts/smoke-ui.mjs 的 realInput（那支是直接執行的腳本、不能 import，所以複製一份給 ui-shots 用；
// 之後要統一時把兩邊都改成 import 這一支，不要讓兩份各自長）。唯一差別：SMOKE_FILES、chooserWaiters 改由參數傳入。
import path from 'node:path'

// 選檔用的測試檔：兩張正常的 1×1 PNG、一張壞掉的（內容不是圖）
export const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

export async function realInput(S, payload, { SMOKE_FILES, chooserWaiters }) {
  let req
  try { req = JSON.parse(payload) } catch { return }
  if (Array.isArray(req.click)) {
    const [x, y] = req.click
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  } else if (Array.isArray(req.move)) {
    // { move: [x, y] }：滑鼠移到那個位置（不按）
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: req.move[0], y: req.move[1] })
  } else if (Array.isArray(req.rightClick)) {
    // { rightClick: [x, y] }：滑鼠右鍵點一下（叫出右鍵選單）
    const [x, y] = req.rightClick
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 })
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 })
  } else if (Array.isArray(req.hold)) {
    // { hold: [x, y, ms] }：手指按住 ms 毫秒再放開（長按）
    const [x, y, ms] = req.hold
    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
    await new Promise(r => setTimeout(r, ms))
    await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else if (typeof req.text === 'string') {
    await S('Input.insertText', { text: req.text })   // 真的打字（插入文字）
  } else if (req.shiftEnter === true) {
    const k = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 }   // Shift+Enter：輸入框換行
    await S('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...k })
    await S('Input.dispatchKeyEvent', { type: 'keyUp', ...k })
  } else if (req.key === 'Backspace') {
    // { key: 'Backspace' }：按一下刪除鍵（真的按鍵；先全選再按就是清空輸入框）
    const k = { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }
    await S('Input.dispatchKeyEvent', { type: 'keyDown', ...k })
    await S('Input.dispatchKeyEvent', { type: 'keyUp', ...k })
  } else if (Array.isArray(req.wheel)) {
    // { wheel: [x, y, deltaY] }：在那個位置轉一次滾輪（負數＝往前）
    const [x, y, deltaY] = req.wheel
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await S('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
  } else if (Array.isArray(req.drag)) {
    // { drag: [x0, y0, x1, y1] }：按住左鍵從起點拖到終點（分幾步移動）
    const [x0, y0, x1, y1] = req.drag
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 })
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 })
    for (let i = 1; i <= 5; i++) await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * i / 5, y: y0 + (y1 - y0) * i / 5, button: 'left', buttons: 1 })
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', buttons: 0, clickCount: 1 })
  } else if (Array.isArray(req.dblclick)) {
    // { dblclick: [x, y] }：滑鼠雙擊
    const [x, y] = req.dblclick
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    for (const clickCount of [1, 2]) {
      await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount })
      await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount })
    }
  } else if (Array.isArray(req.pinch)) {
    // { pinch: [cx, cy, d0, d1] }：兩指以 (cx, cy) 為中心左右排開，指距從 d0 變成 d1
    const [cx, cy, d0, d1] = req.pinch
    const at = d => [{ x: cx - d / 2, y: cy, id: 1 }, { x: cx + d / 2, y: cy, id: 2 }]
    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(d0) })
    for (let i = 1; i <= 6; i++) await S('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(d0 + (d1 - d0) * i / 6) })
    await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else if (Array.isArray(req.tap2)) {
    // { tap2: [x, y] }：手指快速點兩下
    const [x, y] = req.tap2
    for (let i = 0; i < 2; i++) {
      await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
      await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      if (!i) await new Promise(r => setTimeout(r, 80))
    }
  } else if (Array.isArray(req.files)) {
    // { files: [selector, 檔名…] }：像使用者在選檔對話框選了這些檔（偵錯協定 DOM.setFileInputFiles，會觸發 change）。
    // 檔名指 smoke 自備的測試檔（SMOKE_FILES），不能指到別的地方
    const [selector, ...names] = req.files
    const files = names.map(n => path.join(SMOKE_FILES, path.basename(String(n))))
    const { root } = await S('DOM.getDocument', { depth: 0 })
    const { nodeId } = await S('DOM.querySelector', { nodeId: root.nodeId, selector })
    if (!nodeId) throw new Error(`找不到選檔欄位 ${selector}`)
    await S('DOM.setFileInputFiles', { nodeId, files })
  } else if (Array.isArray(req.choose)) {
    // { choose: [x, y, 檔名] }：在那個位置真的點一下，攔下因此打開的選檔對話框（含相機的 capture 欄位），像使用者選了這個檔；
    // 回報對話框的模式到 window.__smokeChooser（frame、mode），沒打開就記成 null。檔名只能指 smoke 自備的測試檔
    const [x, y, name] = req.choose
    await S('Page.setInterceptFileChooserDialog', { enabled: true })
    const opened = new Promise(resolve => { chooserWaiters.push(resolve); setTimeout(() => resolve(null), 3000) })
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    const ev = await opened
    chooserWaiters.length = 0
    await S('Runtime.evaluate', { expression: `window.__smokeChooser = ${JSON.stringify(ev ? { mode: ev.mode } : null)}` })
    if (ev && name) await S('DOM.setFileInputFiles', { backendNodeId: ev.backendNodeId, files: [path.join(SMOKE_FILES, path.basename(String(name)))] })
    await S('Page.setInterceptFileChooserDialog', { enabled: false })
  } else if (Array.isArray(req.gesture)) {
    // { gesture: [x, y, dx, dy] }：手指按在 (x, y)，分十步滑 (dx, dy) 再放開（瀏覽器真的捲動，跟手機滑表格一樣）；dx 負數＝往左滑（內容往右捲）
    const [x, y, dx, dy = 0] = req.gesture
    await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })   // 先開觸控（只影響這一頁），觸控事件才會變成捲動
    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
    for (let i = 1; i <= 10; i++) { await S('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / 10, y: y + dy * i / 10, id: 1 }] }); await new Promise(r => setTimeout(r, 16)) }
    await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else if (typeof req.touch === 'boolean') {
    // { touch: true }：把這一頁當成觸控手機（沒有滑鼠游標：(hover: none)、(pointer: coarse)）；{ touch: false } 改回來。只影響這一頁
    await S('Emulation.setTouchEmulationEnabled', { enabled: req.touch, maxTouchPoints: req.touch ? 5 : 1 })
  } else if (typeof req.key === 'string') {
    const code = { Escape: 27, Enter: 13 }[req.key] ?? 0
    await S('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: req.key, code: req.key, windowsVirtualKeyCode: code })
    await S('Input.dispatchKeyEvent', { type: 'keyUp', key: req.key, code: req.key, windowsVirtualKeyCode: code })
  }
}

