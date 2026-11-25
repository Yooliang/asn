package tw.yooliang.asn

import android.content.Intent
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

// 念出訊息（#2304）：對話裡的喇叭鈕與「收到新訊息自動念」用的語音合成。
// 與通話用的 CallVoice.kt 各用各的 TextToSpeech 引擎：通話結束時關掉它的引擎，不會把正在念的訊息一起關掉。
// 事件走自己的 window.__asnReadEvent(json 字串)：read-done／read-error／read-voices。
// 網頁（ui/lib/mobile-speak.mjs）決定念什麼、念哪一段；這裡只負責把系統的結果變成事件推回網頁，不碰金鑰、不碰收信。
class ReadAloud(private val activity: MainActivity) {
  private var tts: TextToSpeech? = null
  @Volatile private var ready = false
  @Volatile private var initFailed = ""
  private var wantVoicesEvent = false
  private val pending = ArrayDeque<Triple<String, String, String>>()

  private fun emit(obj: JSONObject) {
    val wv = activity.webView ?: return
    val js = "window.__asnReadEvent&&window.__asnReadEvent(" + JSONObject.quote(obj.toString()) + ")"
    activity.runOnUiThread { try { wv.evaluateJavascript(js, null) } catch (e: Exception) { } }
  }
  private fun ev(t: String, build: JSONObject.() -> Unit = {}) = emit(JSONObject().put("t", t).apply(build))

  /** 這支手機有沒有語音合成服務（沒有就不顯示喇叭鈕） */
  fun available(): Boolean = try {
    activity.packageManager.queryIntentServices(Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE), 0).isNotEmpty()
  } catch (e: Exception) { false }

  private fun voicesJson(t: TextToSpeech): JSONObject {
    val voices = JSONArray()
    try {
      for (v in t.voices ?: emptySet<Voice>()) {
        voices.put(JSONObject()
          .put("id", v.name)
          .put("name", v.name)
          .put("lang", v.locale.toLanguageTag())
          .put("quality", v.quality)
          .put("needsNet", v.isNetworkConnectionRequired))
      }
    } catch (e: Exception) { Log.w("ASN", "念出：讀聲音清單失敗 ${e.message}") }
    val langs = JSONArray()
    try { for (l in t.availableLanguages ?: emptySet<Locale>()) langs.put(l.toLanguageTag()) } catch (e: Exception) { Log.w("ASN", "念出：讀語言清單失敗 ${e.message}") }
    return JSONObject().put("voices", voices).put("langs", langs)
  }

  /** 聲音與語言清單：引擎已啟動就直接回 JSON 字串；還在啟動回 "pending"，好了用 read-voices 事件送；啟動失敗回空清單加 error */
  fun voices(): String {
    val t = tts
    if (ready && t != null) return voicesJson(t).toString()
    if (initFailed.isNotEmpty()) return JSONObject().put("voices", JSONArray()).put("langs", JSONArray()).put("error", initFailed).toString()
    activity.runOnUiThread { wantVoicesEvent = true; if (tts == null) initTts() }
    return "pending"
  }

  private fun applyVoice(t: TextToSpeech, voiceId: String) {
    if (voiceId.isNotEmpty()) {
      val v = try { t.voices?.firstOrNull { it.name == voiceId } } catch (e: Exception) { null }
      if (v != null) { if (t.setVoice(v) == TextToSpeech.SUCCESS) return }
      else Log.w("ASN", "念出：找不到指定的聲音，改用預設中文")
    }
    var r = t.setLanguage(Locale.TAIWAN)
    if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) t.setLanguage(Locale.CHINESE)
  }

  private fun speakNow(id: String, text: String, voiceId: String) {
    val t = tts ?: return
    applyVoice(t, voiceId)
    if (t.speak(text, TextToSpeech.QUEUE_ADD, null, id) == TextToSpeech.ERROR) {
      ev("read-error") { put("id", id); put("message", "語音合成失敗") }
    }
  }

  private fun initTts() {
    tts = TextToSpeech(activity) { status ->
      val t = tts   // 這個回呼在主執行緒
      if (status != TextToSpeech.SUCCESS || t == null) {
        initFailed = "手機的語音合成引擎沒有啟動"
        Log.w("ASN", "念出：$initFailed")
        pending.clear()
        ev("read-error") { put("message", initFailed) }
        if (wantVoicesEvent) { wantVoicesEvent = false; ev("read-voices") { put("voices", JSONArray()); put("langs", JSONArray()); put("error", initFailed) } }
        return@TextToSpeech
      }
      t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {}
        override fun onDone(utteranceId: String?) { ev("read-done") { put("id", utteranceId ?: "") } }
        override fun onStop(utteranceId: String?, interrupted: Boolean) { ev("read-done") { put("id", utteranceId ?: "") } }
        @Deprecated("舊版回呼")
        override fun onError(utteranceId: String?) { ev("read-error") { put("id", utteranceId ?: ""); put("message", "語音合成失敗") } }
        override fun onError(utteranceId: String?, errorCode: Int) { ev("read-error") { put("id", utteranceId ?: ""); put("message", "語音合成失敗") } }
      })
      ready = true
      if (wantVoicesEvent) { wantVoicesEvent = false; val o = voicesJson(t); o.put("t", "read-voices"); emit(o) }
      while (pending.isNotEmpty()) { val (id, text, voice) = pending.removeFirst(); speakNow(id, text, voice) }
    }
  }

  fun speak(id: String, text: String, voiceId: String) {
    activity.runOnUiThread {
      if (tts == null) initTts()
      if (ready) speakNow(id, text, voiceId) else pending.addLast(Triple(id, text, voiceId))
    }
  }

  fun stop() {
    activity.runOnUiThread { pending.clear(); try { tts?.stop() } catch (e: Exception) { } }
  }

  /** 畫面被關掉或切到其他程式（MainActivity.onStop）：停止念出並放掉引擎，不在背景繼續念 */
  fun onBackground() {
    activity.runOnUiThread {
      pending.clear()
      try { tts?.stop(); tts?.shutdown() } catch (e: Exception) { }
      tts = null; ready = false; initFailed = ""
    }
  }
}
