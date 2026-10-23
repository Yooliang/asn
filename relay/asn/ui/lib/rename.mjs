// 改設備名（視窗名）後就地更新畫面，不重載頁面。
// 為什麼從前要重載：視窗名在啟動時從 startup_info 讀一次，之後散在 AsnCore（收信過濾、寄件名、名單自己那筆）、
// 畫面上的 info.window_name（分組標題、頁籤、本機判斷、大頭貼）與 me.nick。這些現在都由這裡一次換掉。

/** 改名後的新狀態：舊名進舊名清單（改名前寄來的回信還要收）、新名不留在舊名清單裡。純函式，不改傳入的物件 */
export function renamedInfo(info, name) {
  const prev = info.window_name
  const old = (info.old_names ?? []).filter(n => n !== name)
  if (prev && prev !== name && !old.includes(prev)) old.unshift(prev)
  return { window_name: name, old_names: old }
}

/** 改名成功後套用到畫面：info（要是響應式物件）、核心、「我」的暱稱。回傳新名字 */
export function applyRename({ info, core, me }, name) {
  Object.assign(info, renamedInfo(info, name))
  core.setWindowName(name)
  me.nick = name
  return name
}
