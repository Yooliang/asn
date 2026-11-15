// 手機名單列的長按（#1479）：手指（或觸控筆）按住一列約半秒，叫出那一列的選單。滑鼠不算長按（電腦版用右鍵）。
// 純邏輯：計時器可以換掉（測試用）。手指移動超過一小段（要捲動了）、抬起、取消都不會觸發；
// 觸發後緊接著的那一下 click 要吞掉（不然放開手指會同時點進那一則）；系統自己送來的 contextmenu 也走同一條，同一次長按只開一次。
export const ROW_PRESS_MS = 500
export const ROW_PRESS_MOVE_PX = 10
const CLICK_GUARD_MS = 800

export function createRowPress({ ms = ROW_PRESS_MS, setTimer = (f, t) => setTimeout(f, t), clearTimer = id => clearTimeout(id), now = () => Date.now(), onLong } = {}) {
  let timer = 0
  let origin = null
  let firedAt = -Infinity
  let upAt = -Infinity   // 長按之後手指放開的時間（按很久才放開，click 在放開之後才來）
  const cancel = () => { if (timer) clearTimer(timer); timer = 0; origin = null }
  const fire = id => { firedAt = now(); try { onLong?.(id) } catch (e) { console.info('[ASN] 長按選單', e?.message ?? e) } }
  return {
    down(id, e) {
      cancel()
      if (!id || e?.pointerType === 'mouse') return
      origin = { x: e?.clientX ?? 0, y: e?.clientY ?? 0 }
      timer = setTimer(() => { timer = 0; origin = null; fire(id) }, ms)
    },
    move(e) {
      if (!timer || !origin) return
      if (Math.hypot((e?.clientX ?? 0) - origin.x, (e?.clientY ?? 0) - origin.y) > ROW_PRESS_MOVE_PX) cancel()
    },
    up() { if (firedAt > upAt) upAt = now(); cancel() },
    // 系統的長按／右鍵選單事件：剛由計時器開過就不重複開
    menu(id) {
      cancel()
      if (!id || now() - Math.max(firedAt, upAt) < CLICK_GUARD_MS) return
      fire(id)
    },
    // click 之前問一聲：剛長按過就吞掉這一下（回 true＝請呼叫端 stopImmediatePropagation）
    // 最後一次「長按觸發」或「長按後放開手指」的時間（選單剛開、手指剛放開的那一瞬間，落在選單上的 click 不算數）
    lastAt() { return Math.max(firedAt, upAt) },
    swallowClick() { return now() - Math.max(firedAt, upAt) < CLICK_GUARD_MS },
  }
}

/** 給 v-bind 用的一組事件：每個名單列 v-bind="press.bind(id)" 就好 */
export function rowPressBind(press, id) {
  return {
    onPointerdown: e => press.down(id, e),
    onPointermove: e => press.move(e),
    onPointerup: () => press.up(),
    onPointercancel: () => press.up(),
    onPointerleave: () => press.up(),
    onContextmenu: e => { e.preventDefault(); press.menu(id) },
    onClickCapture: e => { if (press.swallowClick()) { e.stopImmediatePropagation(); e.preventDefault() } },
  }
}
