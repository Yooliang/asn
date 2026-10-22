package tw.yooliang.asn

// Google Play 版：不自己更新（Play 政策不允許），這裡只是空殼，讓共用的 AsnBridge 能編譯。沒有安裝權限、沒有叫系統安裝程式的程式碼。
object SelfUpdate {
  const val ENABLED = false

  fun install(activity: MainActivity, path: String): String = "unsupported"
}
