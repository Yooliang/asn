package tw.yooliang.asn

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

// 推播（#797，FCM）：App 關著時手機也要響。設計見 docs/design/PUSH-FCM.md；安全檢查點見私有文件 todo-next-797-push.md ③。
// 規則（有守門測試 test/android-push.test.mjs）：
//   * **通知文字是這裡的常數**，和後台（push_fcm.ts）送的固定文字一致；不讀 FCM 訊息裡的任何欄位（data、notification 都不看），點下去只是打開主畫面。
//   * 沒有 Firebase（建置時沒放 google-services.json，或手機沒有 Google 服務）：一律當作不能用，什麼都不做，也不會出錯。
//   * 系統通知權限（Android 13 以上）只問一次：被拒之後不再問，使用者要自己到系統設定開。
//   * 權杖只經過 [pushEvent] 交給網頁再交給 Rust；這裡不存、不寫 log。
object AsnPush {
  const val CHANNEL_ID = "asn_messages"
  const val TAG = "asn-new-message"
  const val TITLE = "ASN"
  const val BODY = "ASN 有新訊息"
  const val NOTIFICATION_ID = 797
  const val REQ_NOTIF = 7971
  private const val PREFS = "asn_push"
  private const val KEY_ASKED = "perm_asked"
  private val TOKEN_RE = Regex("^[A-Za-z0-9_:-]{32,1024}$")

  /** Firebase 有沒有設好（沒有 google-services.json 的建置、手機沒有 Google 服務都是 false） */
  fun firebaseReady(ctx: Context): Boolean = try {
    FirebaseApp.getApps(ctx).isNotEmpty()
  } catch (e: Throwable) {
    false
  }

  fun permissionGranted(ctx: Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
      ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

  /** 給網頁看的狀態：unavailable（沒有 Firebase）／granted／ask（還沒問過）／denied（問過被拒，不再問） */
  fun state(ctx: Context): String = when {
    !firebaseReady(ctx) -> "unavailable"
    permissionGranted(ctx) -> "granted"
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ASKED, false) -> "denied"
    else -> "ask"
  }

  /** 問通知權限：只在「沒給、也沒問過」時問一次；問之前先記下，被拒就不會再問 */
  fun askPermission(activity: MainActivity) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || state(activity) != "ask") return
    activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_ASKED, true).apply()
    activity.runOnUiThread { ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF) }
  }

  fun ensureChannel(ctx: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, ctx.getString(R.string.push_channel_name), NotificationManager.IMPORTANCE_DEFAULT))
  }

  fun appInForeground(): Boolean = try {
    ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
  } catch (e: Throwable) {
    false
  }

  /** 顯示固定文字的系統通知；同一個標記、同一個編號，後一則取代前一則。沒有通知權限就不顯示 */
  fun show(ctx: Context) {
    if (!permissionGranted(ctx)) return
    ensureChannel(ctx)
    val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP) } ?: return
    val tap = PendingIntent.getActivity(ctx, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val n = NotificationCompat.Builder(ctx, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_asn)
      .setContentTitle(TITLE)
      .setContentText(BODY)
      .setAutoCancel(true)
      .setContentIntent(tap)
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)
      .build()
    try {
      NotificationManagerCompat.from(ctx).notify(TAG, NOTIFICATION_ID, n)
    } catch (e: SecurityException) {
      // 權限剛被收回：不顯示
    }
  }

  /** 向 Firebase 取目前的權杖；結果用 pushEvent 交給網頁（token／token-error），這裡不留 */
  fun requestToken(activity: MainActivity) {
    if (!firebaseReady(activity)) return
    try {
      FirebaseMessaging.getInstance().token.addOnCompleteListener { t ->
        val tok = if (t.isSuccessful) t.result else null
        if (tok != null && TOKEN_RE.matches(tok)) activity.pushEvent("{\"t\":\"token\",\"token\":\"$tok\"}")   // 格式檢過才放進字串，不會有引號或跳脫
        else activity.pushEvent("{\"t\":\"token-error\"}")
      }
    } catch (e: Throwable) {
      activity.pushEvent("{\"t\":\"token-error\"}")
    }
  }

  /** 登出、換帳號：刪掉 Firebase 的權杖（後台那邊由網頁先取消） */
  fun deleteToken(ctx: Context) {
    if (!firebaseReady(ctx)) return
    try {
      FirebaseMessaging.getInstance().deleteToken()
    } catch (e: Throwable) {
    }
  }
}
