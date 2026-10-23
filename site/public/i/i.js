// 邀請頁：從網址取出邀請碼，組出「打開 ASN」的 asn:// 連結與複製鈕。碼只在本頁使用，不送到任何地方（頁面不連線、不放分析程式）。
(function () {
  var m = /^\/i\/([A-Za-z0-9_-]{16,64})\/?$/.exec(location.pathname)
  var $ = function (id) { return document.getElementById(id) }
  if (!m) { $('bad').hidden = false; return }
  var code = m[1]
  $('code').textContent = code
  $('code-row').hidden = false
  var open = $('open')
  open.href = 'asn://invite/' + code
  open.hidden = false
  var copy = $('copy')
  copy.hidden = false
  copy.addEventListener('click', function () {
    var done = function () { copy.textContent = '已複製' }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, function () { window.prompt('請自己複製邀請碼', code) })
    else window.prompt('請自己複製邀請碼', code)
  })
})()