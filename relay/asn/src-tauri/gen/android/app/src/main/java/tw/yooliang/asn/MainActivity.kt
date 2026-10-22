package tw.yooliang.asn

import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

// 安卓外殼。畫面與邏輯都在 Rust 與 ui/（和電腦版共用），這裡只做三件系統層的事：
//   1. 邊到邊顯示時，把狀態列、導覽列、鍵盤的高度讓出來（不然輸入框會被鍵盤蓋住）
//   2. 把 AsnBridge 以 window.AsnAndroid 交給網頁（震動、匯出收到的檔案、重新開啟）。只有本 App 內建的頁面載得進這個 WebView
//   3. 登入完成後，瀏覽器用 tw.yooliang.asn://login-done 把使用者帶回來（AndroidManifest 的 intent-filter）
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    webView.addJavascriptInterface(AsnBridge(this), "AsnAndroid")
  }
}
