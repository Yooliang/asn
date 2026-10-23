package tw.yooliang.asn

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.util.Locale

// 偽通話（#99）的語音：聽用安卓內建的 SpeechRecognizer（zh-TW，一次聽一句），念用安卓內建的 TextToSpeech（zh-TW）。
// 網頁（ui/lib/mobile-call.mjs）決定什麼時候聽、什麼時候念；這裡只負責把系統的結果變成事件推回網頁：
//   window.__asnCallEvent(json 字串)，事件有 perm／level／partial／result／error／tts-done／tts-error／background。
// 麥克風權限（RECORD_AUDIO）第一次按「通話」才詢問，不是安裝時；拒絕了網頁會顯示怎麼到系統設定開。
// 聲音不經過本 App 的伺服器：辨識是系統的語音服務做的（可能連到它自己的雲端，這是系統行為）。
class CallVoice(private val activity: MainActivity) {
  companion object {
    const val REQ_MIC = 4417
  }

  private var recognizer: SpeechRecognizer? = null
  private var tts: TextToSpeech? = null
  private var ttsReady = false
  private val pending = ArrayDeque<Pair<String, String>>()
  private var lastLevelAt = 0L
  @Volatile private var inCall = false

  private fun emit(obj: JSONObject) {
    val wv = activity.webView ?: return
    val js = "window.__asnCallEvent&&window.__asnCallEvent(" + JSONObject.quote(obj.toString()) + ")"
    activity.runOnUiThread { try { wv.evaluateJavascript(js, null) } catch (e: Exception) { } }
  }
  private fun ev(t: String, build: JSONObject.() -> Unit = {}) = emit(JSONObject().put("t", t).apply(build))

  fun available(): Boolean = try { SpeechRecognizer.isRecognitionAvailable(activity) } catch (e: Exception) { false }

  fun micState(): String =
    if (ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) "granted" else "ask"

  fun requestMic() {
    activity.runOnUiThread {
      ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
    }
  }

  /** MainActivity.onRequestPermissionsResult 轉進來 */
  fun onPermissionResult(granted: Boolean) = ev("perm") { put("granted", granted) }

  private val listener = object : RecognitionListener {
    override fun onReadyForSpeech(params: Bundle?) {}
    override fun onBeginningOfSpeech() {}
    override fun onBufferReceived(buffer: ByteArray?) {}
    override fun onEndOfSpeech() {}
    override fun onEvent(eventType: Int, params: Bundle?) {}
    override fun onRmsChanged(rmsdB: Float) {
      val n = System.currentTimeMillis()
      if (n - lastLevelAt < 100) return
      lastLevelAt = n
      ev("level") { put("v", ((rmsdB + 2f) / 12f).coerceIn(0f, 1f).toDouble()) }
    }
    override fun onPartialResults(partialResults: Bundle?) {
      val s = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: return
      ev("partial") { put("text", s) }
    }
    override fun onResults(results: Bundle?) {
      val s = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
      ev("result") { put("text", s) }
    }
    override fun onError(error: Int) {
      val kind = when (error) {
        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "silence"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "busy"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "denied"
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_SERVER, 11 -> "network"
        12, 13 -> "language"   // ERROR_LANGUAGE_NOT_SUPPORTED／ERROR_LANGUAGE_UNAVAILABLE（API 31）
        else -> "other"
      }
      if (kind != "silence") activity.runOnUiThread { destroyRecognizer() }   // 出了狀況的辨識器不再用，下一次重建
      ev("error") { put("kind", kind) }
    }
  }

  private fun destroyRecognizer() {
    try { recognizer?.destroy() } catch (e: Exception) { }
    recognizer = null
  }

  fun listen() {
    inCall = true
    activity.runOnUiThread {
      try {
        val r = recognizer ?: SpeechRecognizer.createSpeechRecognizer(activity).also {
          it.setRecognitionListener(listener)
          recognizer = it
        }
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
          putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
          putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-TW")
          putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "zh-TW")
          putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
          putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
          putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, activity.packageName)
          putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1200L)
        }
        r.startListening(intent)
      } catch (e: Exception) {
        destroyRecognizer()
        ev("error") { put("kind", "other") }
      }
    }
  }

  fun stopListen() {
    activity.runOnUiThread { try { recognizer?.cancel() } catch (e: Exception) { } }
  }

  private fun speakNow(id: String, text: String) {
    val t = tts ?: return
    if (t.speak(text, TextToSpeech.QUEUE_ADD, null, id) == TextToSpeech.ERROR) {
      ev("tts-error") { put("id", id); put("message", "語音合成失敗") }
    }
  }

  private fun initTts() {
    tts = TextToSpeech(activity) { status ->
      // 這個回呼在主執行緒
      val t = tts
      if (status != TextToSpeech.SUCCESS || t == null) {
        pending.clear()
        ev("tts-error") { put("message", "手機的語音合成引擎沒有啟動") }
        return@TextToSpeech
      }
      var r = t.setLanguage(Locale.TAIWAN)
      if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) r = t.setLanguage(Locale.CHINESE)
      if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
        pending.clear()
        ev("tts-error") { put("message", "這支手機沒有中文語音，請到系統設定的「文字轉語音」安裝") }
        return@TextToSpeech
      }
      t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {}
        override fun onDone(utteranceId: String?) { ev("tts-done") { put("id", utteranceId ?: "") } }
        @Deprecated("舊版回呼")
        override fun onError(utteranceId: String?) { ev("tts-error") { put("id", utteranceId ?: ""); put("message", "語音合成失敗") } }
        override fun onError(utteranceId: String?, errorCode: Int) { ev("tts-error") { put("id", utteranceId ?: ""); put("message", "語音合成失敗") } }
      })
      ttsReady = true
      while (pending.isNotEmpty()) { val (id, text) = pending.removeFirst(); speakNow(id, text) }
    }
  }

  fun speak(id: String, text: String) {
    inCall = true
    activity.runOnUiThread {
      if (tts == null) initTts()
      if (ttsReady) speakNow(id, text) else pending.addLast(id to text)
    }
  }

  fun stopSpeak() {
    activity.runOnUiThread { pending.clear(); try { tts?.stop() } catch (e: Exception) { } }
  }

  /** 通話結束：放掉辨識器與語音合成（不留著佔麥克風） */
  fun end() {
    inCall = false
    activity.runOnUiThread {
      destroyRecognizer()
      pending.clear()
      try { tts?.stop(); tts?.shutdown() } catch (e: Exception) { }
      tts = null; ttsReady = false
    }
  }

  /** 畫面被關掉或切到其他程式（MainActivity.onStop）：通話中就通知網頁掛斷，並放掉麥克風 */
  fun onBackground() {
    if (!inCall) return
    ev("background")
    end()
  }
}
