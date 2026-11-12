// 外觀（lib/skin.mjs）：畫面出來之前先套上記下來的那一套，免得先閃一下復古 Aero；別的視窗改了外觀，這個視窗跟著換，不用重開。
// 跨視窗兩條路：localStorage 的 storage 事件，加上名單視窗送的 Tauri 事件 asn:skin（有些平台的 WebView 不保證跨視窗送 storage 事件）。
// 只讀 localStorage 的 asnSkin，只認 aero／modern，壞值當復古 Aero。
(function () {
  var pick = function (v) { return v === 'modern' ? 'modern' : 'aero' }
  var set = function (v) { document.documentElement.setAttribute('data-skin', pick(v)) }
  var s = 'aero'
  try { s = localStorage.getItem('asnSkin') } catch (e) {}
  set(s)
  window.addEventListener('storage', function (e) { if (e.key === 'asnSkin') set(e.newValue) })
  try { var ev = window.__TAURI__ && window.__TAURI__.event; if (ev && ev.listen) ev.listen('asn:skin', function (e) { set(e && e.payload) }) } catch (e) {}
})()
