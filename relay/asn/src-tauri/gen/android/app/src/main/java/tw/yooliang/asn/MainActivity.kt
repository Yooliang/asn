package tw.yooliang.asn

import android.content.pm.PackageManager
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

// 安卓外殼。畫面與邏輯都在 Rust 與 ui/（和電腦版共用），這裡只做三件系統層的事：
//   1. 邊到邊顯示時，把狀態列、導覽列、鍵盤的高度讓出來（不然輸入框會被鍵盤蓋住）
//   2. 把 AsnBridge 以 window.AsnAndroid 交給網頁（震動、匯出收到的檔案、重新開啟、通話的語音）。只有本 App 內建的頁面載得進這個 WebView
//   3. 登入完成後，瀏覽器用 tw.yooliang.asn://login-done 把使用者帶回來（AndroidManifest 的 intent-filter）
class MainActivity : TauriActivity() {
  var webView: WebView? = null   // 通話的事件（CallVoice）、推播的事件（AsnPush）要推回網頁
  companion object {
    /** 目前開著的主畫面（推播服務收到「權杖換新」時用來通知網頁）；沒開著就是 null */
    @Volatile var current: MainActivity? = null
  }

  /** 推一則推播事件給網頁（window.__asnPushEvent）。內容是外殼自己組的 JSON（權杖已檢過格式），網頁不在就略過 */
  fun pushEvent(json: String) {
    val w = webView ?: return
    w.post { w.evaluateJavascript("window.__asnPushEvent && window.__asnPushEvent(${org.json.JSONObject.quote(json)})", null) }
  }

  /** 告知網頁 App 進前景（true）或進背景（false）：網頁再交給 Rust，在線回報立刻帶 foreground（#1281，推播只看前景）。網頁不在就略過 */
  private fun fgEvent(fg: Boolean) {
    val w = webView ?: return
    w.post { w.evaluateJavascript("window.__asnFgEvent && window.__asnFgEvent($fg)", null) }
  }
  val callVoice: CallVoice by lazy { CallVoice(this) }

  // 麥克風權限的回答（通話第一次使用時才問）
  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode == CallVoice.REQ_MIC) callVoice.onPermissionResult(grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED)
    // 通知權限的回答（只問一次，被拒之後不再問）：給了就請網頁去取權杖
    if (requestCode == AsnPush.REQ_NOTIF) pushEvent("{\"t\":\"perm\",\"granted\":${grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED}}")
  }

  // 查看終端前的螢幕鎖確認（API 29 以下）的回答
  @Deprecated("Deprecated in Java")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
    @Suppress("DEPRECATION")
    super.onActivityResult(requestCode, resultCode, data)
    ViewerConfirm.onActivityResult(this, requestCode, resultCode)
  }

  // 螢幕關閉或切到其他程式：通話自動結束（麥克風不留著）
  override fun onStop() {
    // 先排進「進背景」的告知（false），再結束通話；結束通話就算丟例外，false 也已經排進去，super.onStop() 一定會執行。
    // 注意 fgEvent 只是把 JS 排進網頁的佇列，不保證在網頁被凍住之前執行；漏掉時 Rust 端的前景告知 90 秒後自己過期
    try {
      fgEvent(false)
      callVoice.onBackground()
    } finally {
      super.onStop()
    }
  }

  override fun onStart() {
    super.onStart()
    fgEvent(true)    // 回前景也立刻送一次
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    current = this
    AsnPush.ensureChannel(this)   // App 關著時系統顯示的通知要用這個頻道，所以一開 App 就先建好
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  override fun onDestroy() {
    if (current === this) current = null
    if (isFinishing) ViewerConfirm.clear()
    super.onDestroy()
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(AsnBridge(this), "AsnAndroid")
    // 鎖定縮放（雙指縮放、雙擊放大）；系統的「字型大小」無障礙設定照常生效（textZoom 不動）
    webView.settings.setSupportZoom(false)
    webView.settings.builtInZoomControls = false
    webView.settings.displayZoomControls = false
  }
}
