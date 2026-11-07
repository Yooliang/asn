package tw.yooliang.asn

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

// FCM 的接收端（#797）。**不解析訊息內容**：不讀 data、不讀 notification；通知文字用 AsnPush 的常數，點下去只是打開主畫面。
//   * onMessageReceived：App 在前景就不顯示（人正在看，門鈴與輪詢會把信拉進來）；在背景才顯示固定文字的系統通知。
//     （App 完全關著時，FCM 的 notification 欄位由系統直接顯示，不會經過這裡；那個文字也是後台的固定常數。）
//   * onNewToken：Firebase 換了權杖。這裡不收、不存權杖，只請網頁重新取一次再交給後台；App 沒開著就等下次打開 App 時重報。
class AsnMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    if (AsnPush.appInForeground()) return
    AsnPush.show(applicationContext)
  }

  override fun onNewToken(token: String) {
    MainActivity.current?.pushEvent("{\"t\":\"refresh\"}")
  }
}
