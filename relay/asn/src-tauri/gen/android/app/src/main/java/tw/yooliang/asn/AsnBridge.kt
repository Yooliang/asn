package tw.yooliang.asn

import android.app.DownloadManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Process
import android.system.Os
import android.system.OsConstants
import android.system.StructStat
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.MediaStore
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileInputStream

// 網頁（ui/m.js）能呼叫的系統功能。方法都在 WebView 的背景執行緒上被叫到，要碰畫面的一律丟回主執行緒。
// 這個物件只交給本 App 內建的頁面；收到的檔案路徑一律先檢查是在 App 私有資料夾底下才動。
class AsnBridge(private val activity: MainActivity) {
  private val filesRoot: File = activity.filesDir.canonicalFile
  /**
   * 只有「收到的檔案」可以匯出：Rust 端 relay_attachment_save 存到 `<data_dir>/received`，
   * 安卓的 data_dir 是 `<filesDir>/.irori-asn`（datadir.rs 的 FALLBACK_NAME，守門測試鎖住兩邊一致）。
   * App 私有資料夾裡的其他檔案（金鑰、登入資料、設定）一律不匯出。
   * 每次匯出前還會用 [ExportPath.isValidExportRoot] 確認這個資料夾的位置正確
   */
  private val exportRoot: File = ExportPath.expectedExportRoot(filesRoot).canonicalFile

  /** 震動（對方傳來「震動」時）：兩下短震。網頁自己的 navigator.vibrate 沒有點擊動作就會被擋，所以走這裡 */
  @JavascriptInterface
  fun vibrate(ms: Long) {
    val v: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }
    if (v == null || !v.hasVibrator()) return
    val d = ms.coerceIn(20L, 1000L)
    v.vibrate(VibrationEffect.createWaveform(longArrayOf(0, d, 80, d), -1))
  }

  /** 把「收到的檔案」資料夾裡的檔案複製到系統「下載/ASN」。成功回給人看的位置，失敗回空字串。
   *  路徑判斷在 [ExportPath]：先確認匯出根資料夾本身就是 `<filesDir>/.irori-asn/received`，
   *  再把輸入路徑解開（canonicalFile：消掉 ..、解開符號連結）後比對，只收根資料夾底下的一般檔。
   *  打開來源檔之後會再驗：比對已開的檔（fstat）和 canonical 路徑上的檔（lstat，不跟隨符號連結）是不是同一個一般檔
   *  （裝置與檔案編號相同），並把輸入路徑重新解開再判斷一次；有任何不一致就放棄（檢查與開檔是兩個動作，中間路徑可能變動）。
   *  任何失敗路徑都會刪掉已建立的下載項目，不留 IS_PENDING 的半成品 */
  @JavascriptInterface
  fun exportFile(path: String): String {
    var uri: Uri? = null
    var done = false
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return ""
      if (!ExportPath.isValidExportRoot(filesRoot, exportRoot)) return ""
      val src = ExportPath.resolve(exportRoot, path) ?: return ""
      val ext = src.extension.lowercase()
      val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
      val resolver = activity.contentResolver
      FileInputStream(src).use { input ->
        // 開檔後再驗：手上這個已開的檔，要和 canonical 路徑上的檔是同一個一般檔；另外輸入路徑重新解開也要還是剛才那個檔
        if (!openedIsPathFile(input, src) || ExportPath.resolve(exportRoot, path) != src) return ""
        val values = ContentValues().apply {
          put(MediaStore.Downloads.DISPLAY_NAME, src.name)
          put(MediaStore.Downloads.MIME_TYPE, mime)
          put(MediaStore.Downloads.RELATIVE_PATH, "Download/ASN")
          put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val created = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return ""
        uri = created
        resolver.openOutputStream(created)?.use { out -> input.copyTo(out) } ?: return ""
        // 複製完、解除 pending 前再驗一次，不一致就走 finally 的清理
        if (!openedIsPathFile(input, src) || ExportPath.resolve(exportRoot, path) != src) return ""
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        if (resolver.update(created, values, null, null) < 1) return ""
      }
      done = true
      return "下載/ASN/" + src.name
    } catch (e: Exception) {
      return ""
    } finally {
      val u = uri
      if (!done && u != null) {
        try {
          activity.contentResolver.delete(u, null, null)
        } catch (e: Exception) {
        }
      }
    }
  }

  private fun fileId(st: StructStat): ExportPath.FileId =
    ExportPath.FileId(st.st_dev, st.st_ino, OsConstants.S_ISREG(st.st_mode))

  /** 已打開的來源檔，和 canonical 路徑上的檔是不是同一個一般檔（取值在這裡，比對在 [ExportPath.sameRegularFile]） */
  private fun openedIsPathFile(input: FileInputStream, src: File): Boolean =
    try {
      ExportPath.sameRegularFile(fileId(Os.fstat(input.fd)), fileId(Os.lstat(src.path)))
    } catch (e: Exception) {
      false
    }

  /** 開啟系統的「下載」清單 */
  @JavascriptInterface
  fun openDownloads() {
    activity.runOnUiThread {
      try {
        activity.startActivity(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      } catch (e: Exception) {
      }
    }
  }

  /** 自行安裝版的自動更新：這個版本有沒有（Play 版回 false） */
  @JavascriptInterface
  fun selfUpdateEnabled(): Boolean = SelfUpdate.ENABLED

  /** 把下載好的更新檔交給系統安裝程式。回 ok／need_permission／error／unsupported */
  @JavascriptInterface
  fun installApk(path: String): String = SelfUpdate.install(activity, path)

  // ---------- 偽通話（#99）：安卓內建的語音辨識與語音合成，見 CallVoice.kt；事件由它推回網頁 ----------
  @JavascriptInterface fun callAvailable(): Boolean = activity.callVoice.available()
  /** 麥克風權限：granted／ask */
  @JavascriptInterface fun callMicState(): String = activity.callVoice.micState()
  @JavascriptInterface fun callRequestMic() = activity.callVoice.requestMic()
  @JavascriptInterface fun callListen(names: String) = activity.callVoice.listen(names)
  @JavascriptInterface fun callStopListen() = activity.callVoice.stopListen()
  @JavascriptInterface fun callSpeak(id: String, text: String) = activity.callVoice.speak(id, text)
  @JavascriptInterface fun callStopSpeak() = activity.callVoice.stopSpeak()
  @JavascriptInterface fun callEnd() = activity.callVoice.end()

  // ---------- 推播（#797，FCM）：見 AsnPush.kt；事件（perm／token／token-error／refresh）由它推回網頁 ----------
  /** unavailable（沒有 Firebase）／granted／ask（還沒問過通知權限）／denied（問過被拒，不再問） */
  @JavascriptInterface fun pushState(): String = AsnPush.state(activity)
  /** 問通知權限（只問一次） */
  @JavascriptInterface fun pushAskPermission() = AsnPush.askPermission(activity)
  /** 向 Firebase 取權杖，結果用事件交給網頁 */
  @JavascriptInterface fun pushRequestToken() = AsnPush.requestToken(activity)
  /** 登出、換帳號時刪掉 Firebase 的權杖 */
  @JavascriptInterface fun pushDeleteToken() = AsnPush.deleteToken(activity)

  /** 查看電腦終端前的本人確認（生物辨識或螢幕鎖）。結果 ok／cancel／no_lock 經 window.__asnConfirmViewer(callbackId, result) 交回 */
  @JavascriptInterface
  fun confirmViewer(callbackId: String) {
    activity.runOnUiThread { ViewerConfirm.ask(activity, callbackId) }
  }

  /**
   * 「記住這台」「忘記」前的本人確認：challenge 是 Rust 剛發的一次性憑證。這裡只開生物辨識／螢幕鎖，**不寫任何檔**；
   * 憑證檔只有在驗證通過的那一刻由 ViewerConfirm 寫。結果 ok／cancel／no_lock 一樣經 window.__asnConfirmViewer(callbackId, result) 交回
   */
  @JavascriptInterface
  fun confirmWithToken(callbackId: String, challenge: String) {
    activity.runOnUiThread { ViewerConfirm.ask(activity, callbackId, challenge) }
  }

  /**
   * 用相機掃電腦設定頁上的指紋 QR code：challenge 是 Rust 剛發的 scan 憑證。掃到的字**不會**交回網頁：外殼掃到後跳本人確認，
   * 通過才把字存進 App 私有資料夾給 Rust 讀；網頁只收到狀態字 ok／cancel／denied／no_camera／bad_qr／no_lock
   * （同一個 window.__asnConfirmViewer(callbackId, result)）。這裡不寫任何檔
   */
  @JavascriptInterface
  fun scanFingerprint(callbackId: String, challenge: String) {
    activity.runOnUiThread { FingerprintScan.start(activity, callbackId, challenge) }
  }

  /** 通話中讓螢幕保持亮著（不然自己暗掉就會被當成切到背景而結束通話） */
  @JavascriptInterface
  fun keepAwake(on: Boolean) {
    activity.runOnUiThread {
      if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
  }

  /** 重新開啟 ASN（第一次登入建好這支手機的節點後，Rust 端要重新讀身分）。先叫起新的，再結束這個行程 */
  @JavascriptInterface
  fun relaunch() {
    activity.runOnUiThread {
      val intent = activity.packageManager.getLaunchIntentForPackage(activity.packageName) ?: return@runOnUiThread
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
      activity.startActivity(intent)
      activity.finishAffinity()
      Process.killProcess(Process.myPid())
    }
  }
}
