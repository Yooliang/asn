package tw.yooliang.asn

import java.io.File
import java.io.IOException

/**
 * 匯出到「下載/ASN」前的路徑判斷。純 Kotlin、不依賴 Android，可以直接在 JVM 上跑單元測試。
 *
 * 兩層判斷：
 * 1. [isValidExportRoot]：匯出的根資料夾本身要正好是 `<filesDir>/.irori-asn/received`，
 *    而且路徑上沒有任何一段是符號連結（字面路徑和解開後的路徑必須一致）。不是資料目錄本身、也不是它的上層。
 * 2. [resolve]：輸入的路徑解開（消掉 `..`、解開符號連結）之後，必須是根資料夾底下的一般檔。
 *    比對時多補一個分隔字元，所以名字開頭相同的兄弟資料夾不會被誤收。
 */
object ExportPath {
  /** 檔案的身分：所在裝置、檔案編號、是不是一般檔（不含符號連結）。值由呼叫端從作業系統取得 */
  data class FileId(val dev: Long, val ino: Long, val isRegular: Boolean)

  /** 已打開的檔（fstat）和路徑上的檔（lstat，不跟隨符號連結）是不是同一個一般檔：兩邊都要是一般檔，且裝置與檔案編號都相同 */
  fun sameRegularFile(opened: FileId, onPath: FileId): Boolean =
    opened.isRegular && onPath.isRegular && opened.dev == onPath.dev && opened.ino == onPath.ino

  /** 資料目錄的資料夾名稱，要和 Rust 端 datadir.rs 的 FALLBACK_NAME 一致（android.test.mjs 鎖住） */
  const val DATA_DIR_NAME = ".irori-asn"

  /** 收到的檔案資料夾名稱，要和 Rust 端 android.rs 的 `data_dir.join("received")` 一致 */
  const val RECEIVED_DIR_NAME = "received"

  /** 預期的匯出根資料夾（字面路徑，不解開符號連結）。[filesRoot] 要先是 canonical */
  fun expectedExportRoot(filesRoot: File): File = File(File(filesRoot, DATA_DIR_NAME), RECEIVED_DIR_NAME)

  /**
   * [exportRoot] 是否正好是 [filesRoot] 底下的 `.irori-asn/received`。
   * 若路徑上有符號連結，解開後的位置會和字面位置不同，一律不通過。
   */
  fun isValidExportRoot(filesRoot: File, exportRoot: File): Boolean {
    return try {
      val expected = expectedExportRoot(filesRoot.canonicalFile)
      exportRoot.canonicalFile.path == expected.path && expected.canonicalFile.path == expected.path
    } catch (e: IOException) {
      false
    }
  }

  /**
   * 回傳允許匯出的 canonical 檔案；不允許（跳出根資料夾、不是一般檔、不存在、路徑無法解開）回 null。
   * [exportRoot] 要是已通過 [isValidExportRoot] 的根資料夾。
   */
  fun resolve(exportRoot: File, path: String): File? {
    return try {
      val root = exportRoot.canonicalFile
      val src = File(path).canonicalFile
      if (!src.path.startsWith(root.path + File.separator)) return null
      if (!src.isFile) return null
      src
    } catch (e: IOException) {
      null
    } catch (e: SecurityException) {
      null
    }
  }
}
