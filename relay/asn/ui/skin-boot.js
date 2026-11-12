// 外觀（lib/skin.mjs）：畫面出來之前先套上記下來的那一套，免得先閃一下復古 Aero；別的視窗改了外觀（storage 事件），這個視窗跟著換，不用重開。
// 只讀 localStorage 的 asnSkin，壞值當復古 Aero。
(function () {
  var pick = function (v) { return v === 'modern' ? 'modern' : 'aero' }
  var s = 'aero'
  try { s = pick(localStorage.getItem('asnSkin')) } catch (e) {}
  document.documentElement.setAttribute('data-skin', s)
  window.addEventListener('storage', function (e) { if (e.key === 'asnSkin') document.documentElement.setAttribute('data-skin', pick(e.newValue)) })
})()
