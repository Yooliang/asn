package tw.yooliang.asn

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File

// 「自行安裝版」（官網下載的 APK）的自動更新：把 Rust 端下載並驗過 sha256 的 APK 交給系統安裝程式。
// Google Play 版用 src/play 底下的同名空殼，不含這些程式碼，也不宣告安裝權限。
object SelfUpdate {
  const val ENABLED = true

  /** 回 "ok"（已叫出系統安裝畫面）、"need_permission"（已開啟「允許安裝未知應用程式」設定，使用者允許後要再按一次）、"error" */
  fun install(activity: MainActivity, path: String): String {
    try {
      val updates = File(activity.filesDir, ".irori-asn/updates").canonicalFile
      val apk = File(path).canonicalFile
      if (!apk.path.startsWith(updates.path + File.separator) || !apk.isFile || !apk.name.endsWith(".apk")) return "error"
      if (!activity.packageManager.canRequestPackageInstalls()) {
        val i = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.runOnUiThread { activity.startActivity(i) }
        return "need_permission"
      }
      val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", apk)
      val i = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      activity.runOnUiThread { activity.startActivity(i) }
      return "ok"
    } catch (e: Exception) {
      return "error"
    }
  }
}
