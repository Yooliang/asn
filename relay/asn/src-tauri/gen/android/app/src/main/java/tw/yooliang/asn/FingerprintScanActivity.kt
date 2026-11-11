package tw.yooliang.asn

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.zxing.BarcodeFormat
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.journeyapps.barcodescanner.DefaultDecoderFactory

// 用相機掃電腦設定頁上的指紋 QR code。只認 QR code；掃到第一個就停相機、把字交給 FingerprintScan（同一個行程裡的物件，不經過網頁），
// 然後關掉自己。不拍照、不存影像、不上傳：畫面只是即時預覽，解碼完就丟。
// 相機權限（CAMERA）由函式庫的清單帶進來；這裡第一次用才問，被拒就回 denied（改用選的）。
// 這個畫面不對外開放（exported=false），只有 FingerprintScan 從 MainActivity 叫得起來。
class FingerprintScanActivity : AppCompatActivity() {
  private var scanView: DecoratedBarcodeView? = null
  private var granted = false
  private var awaitingPermission = false
  private var finishedByUs = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (!packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
      end("no_camera", null)
      return
    }
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    val root = FrameLayout(this)
    val v = DecoratedBarcodeView(this)
    v.barcodeView.decoderFactory = DefaultDecoderFactory(listOf(BarcodeFormat.QR_CODE))
    v.setStatusText("把鏡頭對準電腦畫面上的 QR code")
    root.addView(v, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    val cancel = Button(this)
    cancel.text = "取消"
    cancel.setOnClickListener { end("cancel", null) }
    val lp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.END)
    val m = (16 * resources.displayMetrics.density).toInt()
    lp.setMargins(m, m * 2, m, m)
    root.addView(cancel, lp)
    setContentView(root)
    scanView = v
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
      granted = true
      beginDecode()
    } else {
      awaitingPermission = true
      ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
    }
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != REQ_CAMERA) return
    awaitingPermission = false
    if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
      granted = true
      beginDecode()
      scanView?.resume()
    } else {
      end("denied", null)
    }
  }

  /** 只解 QR code，掃到第一個就回呼一次 */
  private fun beginDecode() {
    scanView?.decodeSingle(BarcodeCallback { r -> onDecoded(r?.text) })
  }

  private fun onDecoded(text: String?) {
    if (finishedByUs) return
    if (text.isNullOrEmpty()) return
    end("ok", text)
  }

  /** 停相機、把結果交給 FingerprintScan（同一個行程）、關掉這個畫面。只有 status 是 ok 才帶字 */
  private fun end(status: String, text: String?) {
    if (finishedByUs) return
    finishedByUs = true
    scanView?.pause()
    FingerprintScan.deliver(status, if (status == "ok") text else null)
    finish()
  }

  override fun onResume() {
    super.onResume()
    if (granted && !finishedByUs) scanView?.resume()
  }

  override fun onPause() {
    scanView?.pause()
    super.onPause()
  }

  // 本人切去別的程式就當取消（不在背景開著相機等）。問權限的對話框不算
  override fun onStop() {
    if (!finishedByUs && !awaitingPermission && !isChangingConfigurations) end("cancel", null)
    super.onStop()
  }

  private companion object {
    const val REQ_CAMERA = 7102
  }
}
