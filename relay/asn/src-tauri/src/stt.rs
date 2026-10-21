//! 語音輸入（本機辨識）：前端錄好一段 16 kHz 單聲道 WAV 交給這裡，用 whisper.cpp 的 whisper-cli.exe 在本機辨識，
//! 文字回前端（前端再過濾靜音幻覺字、填進輸入框，不自動送出）。**聲音不離開這台電腦**。
//!
//! 辨識引擎與模型都不進 git，第一次使用時由使用者按「下載」才抓：
//! - 引擎：whisper.cpp 官方 release（Windows：whisper-bin-x64.zip；Linux：whisper-bin-ubuntu-x64.tar.gz），固定 SHA-256。
//! - 模型：Hugging Face ggerganov/whisper.cpp 的 ggml 量化檔（固定 SHA-256）。
//!
//! 為什麼用外部程式而不是 whisper-rs：whisper-rs 要在每個開發者與 CI 的機器上編 C++（要 cmake、libclang），
//! 這期先用官方預編譯的執行檔；之後要內嵌再換，介面（stt_status／stt_install／stt_transcribe）不變。
use crate::App;
use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

pub const ENGINE_TAG: &str = "b5454";
#[cfg(windows)]
pub const ENGINE_URL: &str = "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip";
#[cfg(windows)]
pub const ENGINE_SHA256: &str = "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb";
#[cfg(windows)]
pub const ENGINE_BYTES: u64 = 8_928_640;
#[cfg(not(windows))]
pub const ENGINE_URL: &str = "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-ubuntu-x64.tar.gz";
#[cfg(not(windows))]
pub const ENGINE_SHA256: &str = "a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c";
#[cfg(not(windows))]
pub const ENGINE_BYTES: u64 = 10_364_195;

fn engine_cli_name() -> &'static str {
    if cfg!(windows) { "whisper-cli.exe" } else { "whisper-cli" }
}

pub struct Model {
    pub id: &'static str,
    pub file: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
    pub label: &'static str,
}
pub const MODELS: [Model; 2] = [
    Model {
        id: "small",
        file: "ggml-small-q5_1.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
        bytes: 190_085_487,
        label: "較準，約 190 MB",
    },
    Model {
        id: "base",
        file: "ggml-base-q5_1.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin",
        sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
        bytes: 59_707_625,
        label: "較快，約 60 MB",
    },
];
pub fn model_of(id: &str) -> Option<&'static Model> {
    MODELS.iter().find(|m| m.id == id)
}

/// 錄音上限（秒）與 WAV 規格：16 kHz、單聲道、16 位元
pub const MAX_SECONDS: u32 = 60;
pub const RATE: u32 = 16_000;
const MAX_WAV_BYTES: usize = (MAX_SECONDS as usize + 2) * RATE as usize * 2 + 44;
/// 辨識程式最久跑多久：到了就結束那一個子程序並回「辨識逾時」（前端另有 75 秒的保險）
const RUN_TIMEOUT: Duration = Duration::from_secs(60);
/// 前端按「取消」時叫醒正在等辨識程式的那一個 `run_with_deadline`
static CANCEL: tokio::sync::Notify = tokio::sync::Notify::const_new();

pub fn stt_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("stt")
}
pub fn engine_dir(data_dir: &Path) -> PathBuf {
    stt_dir(data_dir).join(format!("engine-{ENGINE_TAG}"))
}
pub fn model_path(data_dir: &Path, m: &Model) -> PathBuf {
    stt_dir(data_dir).join("models").join(m.file)
}
pub fn engine_ready(data_dir: &Path) -> bool {
    let d = engine_dir(data_dir);
    if cfg!(windows) {
        d.join("whisper-cli.exe").is_file() && d.join("whisper.dll").is_file()
    } else {
        d.join("whisper-cli").is_file() && d.join("libwhisper.so").is_file()
    }
}
pub fn model_ready(data_dir: &Path, m: &Model) -> bool {
    std::fs::metadata(model_path(data_dir, m)).map(|x| x.len() == m.bytes).unwrap_or(false)
}

// ---------- 下載（校驗碼不符就丟掉） ----------

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// 下載到 `dest`：先寫 `.part`、邊下載邊算 SHA-256、超過 `max_bytes` 就中止，全部收完且校驗碼相符才改名。
/// `progress(已下載, 總長)`；總長未知時為 0。失敗時 `.part` 一律刪掉。
pub async fn download_verified(client: &reqwest::Client, url: &str, dest: &Path, sha256: &str, max_bytes: u64, mut progress: impl FnMut(u64, u64)) -> Result<(), String> {
    if let Some(p) = dest.parent() {
        std::fs::create_dir_all(p).map_err(|e| format!("建立資料夾失敗：{e}"))?;
    }
    let part = PathBuf::from(format!("{}.part", dest.display()));
    let r = download_inner(client, url, &part, sha256, max_bytes, &mut progress).await;
    match r {
        Ok(()) => std::fs::rename(&part, dest).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            format!("存檔失敗：{e}")
        }),
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

async fn download_inner(client: &reqwest::Client, url: &str, part: &Path, sha256: &str, max_bytes: u64, progress: &mut impl FnMut(u64, u64)) -> Result<(), String> {
    let mut res = client.get(url).send().await.map_err(|e| format!("下載連線失敗：{}", e.without_url()))?;
    if !res.status().is_success() {
        return Err(format!("下載失敗：HTTP {}", res.status().as_u16()));
    }
    let total = res.content_length().unwrap_or(0);
    if total > max_bytes {
        return Err("下載的檔案比預期大，已中止。".into());
    }
    let mut f = std::fs::File::create(part).map_err(|e| format!("寫檔失敗：{e}"))?;
    let mut h = Sha256::new();
    let mut got = 0u64;
    let mut last = 0u64;
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("下載中斷：{}", e.without_url()))? {
        got += chunk.len() as u64;
        if got > max_bytes {
            return Err("下載的檔案比預期大，已中止。".into());
        }
        h.update(&chunk);
        f.write_all(&chunk).map_err(|e| format!("寫檔失敗：{e}"))?;
        if got - last >= 512 * 1024 {
            last = got;
            progress(got, total);
        }
    }
    f.flush().map_err(|e| format!("寫檔失敗：{e}"))?;
    drop(f);
    progress(got, total);
    if !hex(&h.finalize()).eq_ignore_ascii_case(sha256) {
        return Err("下載的檔案內容不對（校驗碼不符），已丟掉。".into());
    }
    Ok(())
}

// ---------- 引擎解壓縮 ----------

/// 只解出 Release/ 底下的 whisper-cli.exe 與 .dll（檔名不含路徑分隔，其餘一律略過，防 zip 路徑穿越）。
#[cfg(windows)]
pub fn extract_engine(zip_path: &Path, dest: &Path) -> Result<usize, String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("開啟壓縮檔失敗：{e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("壓縮檔格式不對：{e}"))?;
    let tmp = PathBuf::from(format!("{}.tmp", dest.display()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("建立資料夾失敗：{e}"))?;
    let mut n = 0;
    let res = (|| -> Result<(), String> {
        for i in 0..zip.len() {
            let mut e = zip.by_index(i).map_err(|e| format!("讀壓縮檔失敗：{e}"))?;
            if e.is_dir() {
                continue;
            }
            let name = e.name().replace('\\', "/");
            let Some(base) = name.strip_prefix("Release/") else { continue };
            let lower = base.to_ascii_lowercase();
            let wanted = lower == "whisper-cli.exe" || lower.ends_with(".dll");
            if !wanted || base.is_empty() || base.contains('/') || base.contains("..") || base.contains(':') {
                continue;
            }
            if e.size() > 64 * 1024 * 1024 {
                return Err("壓縮檔裡有異常大的檔案，已中止。".into());
            }
            let mut out = std::fs::File::create(tmp.join(base)).map_err(|e| format!("寫檔失敗：{e}"))?;
            std::io::copy(&mut e, &mut out).map_err(|e| format!("解壓縮失敗：{e}"))?;
            n += 1;
        }
        if !tmp.join("whisper-cli.exe").is_file() || !tmp.join("whisper.dll").is_file() {
            return Err("壓縮檔裡找不到辨識引擎。".into());
        }
        Ok(())
    })();
    if let Err(e) = res {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }
    let _ = std::fs::remove_dir_all(dest);
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_dir_all(&tmp);
        format!("安裝引擎失敗：{e}")
    })?;
    Ok(n)
}

/// 解出 whisper-bin-ubuntu-x64/ 底下的 whisper-cli 與 .so（不含子目錄，防路徑穿越）。
#[cfg(not(windows))]
pub fn extract_engine(tar_path: &Path, dest: &Path) -> Result<usize, String> {
    use flate2::read::GzDecoder;
    use tar::Archive;
    const PREFIX: &str = "whisper-bin-ubuntu-x64/";
    let file = std::fs::File::open(tar_path).map_err(|e| format!("開啟壓縮檔失敗：{e}"))?;
    let dec = GzDecoder::new(file);
    let mut archive = Archive::new(dec);
    let tmp = PathBuf::from(format!("{}.tmp", dest.display()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("建立資料夾失敗：{e}"))?;
    let mut n = 0;
    let res = (|| -> Result<(), String> {
        for entry in archive.entries().map_err(|e| format!("讀壓縮檔失敗：{e}"))? {
            let mut entry = entry.map_err(|e| format!("讀壓縮檔失敗：{e}"))?;
            let path = entry.path().map_err(|e| format!("讀壓縮檔失敗：{e}"))?;
            let name = path.to_string_lossy().replace('\\', "/");
            let Some(rest) = name.strip_prefix(PREFIX) else { continue };
            if rest.is_empty() || rest.contains('/') || rest.contains("..") || rest.contains(':') {
                continue;
            }
            let lower = rest.to_ascii_lowercase();
            let wanted = lower == "whisper-cli" || lower.ends_with(".so");
            if !wanted {
                continue;
            }
            if entry.size() > 64 * 1024 * 1024 {
                return Err("壓縮檔裡有異常大的檔案，已中止。".into());
            }
            let mut out = std::fs::File::create(tmp.join(rest)).map_err(|e| format!("寫檔失敗：{e}"))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("解壓縮失敗：{e}"))?;
            n += 1;
        }
        if !tmp.join("whisper-cli").is_file() || !tmp.join("libwhisper.so").is_file() {
            return Err("壓縮檔裡找不到辨識引擎。".into());
        }
        Ok(())
    })();
    if let Err(e) = res {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }
    let _ = std::fs::remove_dir_all(dest);
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_dir_all(&tmp);
        format!("安裝引擎失敗：{e}")
    })?;
    Ok(n)
}

// ---------- 辨識 ----------

/// 檢查前端交來的 WAV：RIFF/WAVE、PCM、單聲道、16 kHz、16 位元，長度 ≤ 60 秒。回傳秒數。
pub fn check_wav(b: &[u8]) -> Result<f32, String> {
    if b.len() > MAX_WAV_BYTES {
        return Err(format!("錄音太長（上限 {MAX_SECONDS} 秒）"));
    }
    if b.len() < 44 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" || &b[12..16] != b"fmt " {
        return Err("錄音格式不對".into());
    }
    let u16at = |o: usize| u16::from_le_bytes([b[o], b[o + 1]]);
    let u32at = |o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
    if u32at(16) != 16 || u16at(20) != 1 || u16at(22) != 1 || u32at(24) != RATE || u16at(34) != 16 {
        return Err("錄音格式不對（要 16 kHz、單聲道、16 位元）".into());
    }
    if &b[36..40] != b"data" {
        return Err("錄音格式不對".into());
    }
    let n = u32at(40) as usize;
    if n == 0 || 44 + n > b.len() {
        return Err("錄音是空的或不完整".into());
    }
    Ok(n as f32 / (RATE as f32 * 2.0))
}

pub fn prompt_for(lang: &str) -> Option<&'static str> {
    match lang {
        "zh" => Some("以下是繁體中文的句子，請使用正確的標點符號。"),
        _ => None,
    }
}

/// whisper-cli 的參數：不印時間軸與進度、輸出純文字檔 `<out_base>.txt`
pub fn build_args(model: &Path, wav: &Path, out_base: &Path, lang: &str, threads: usize) -> Vec<OsString> {
    let mut a: Vec<OsString> = vec!["-m".into(), model.into(), "-f".into(), wav.into(), "-l".into(), lang.into(), "-t".into(), threads.to_string().into(), "-nt".into(), "-np".into(), "-otxt".into(), "-of".into(), out_base.into()];
    if let Some(p) = prompt_for(lang) {
        a.push("--prompt".into());
        a.push(p.into());
    }
    a
}

/// 讀辨識結果的文字檔：每行去頭尾空白、空行拿掉、用空格接起來
pub fn read_transcript(txt: &str) -> String {
    txt.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ")
}

static BUSY: AtomicBool = AtomicBool::new(false);
struct BusyGuard;
impl BusyGuard {
    fn take() -> Option<BusyGuard> {
        BUSY.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).ok().map(|_| BusyGuard)
    }
}
impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

/// 跑一個子程序，最多等 `timeout`，或 `cancel` 被叫醒就提前結束。逾時／取消時**只結束這一個自己啟動的子程序**（用它的 handle，
/// 不靠名稱、不動別的程序）並等它真的結束才回傳。`on_spawn` 收到子程序的 PID（測試用來確認它真的死了）。
/// 呼叫端要自己設 `kill_on_drop(true)`，萬一這個 future 被丟掉也不會留下孤兒。
pub async fn run_with_deadline(mut cmd: tokio::process::Command, timeout: Duration, cancel: &tokio::sync::Notify, on_spawn: impl FnOnce(u32)) -> Result<std::process::ExitStatus, String> {
    let mut child = cmd.spawn().map_err(|e| format!("辨識引擎啟動失敗：{e}"))?;
    if let Some(pid) = child.id() {
        on_spawn(pid);
    }
    tokio::select! {
        r = child.wait() => r.map_err(|e| format!("辨識引擎執行失敗：{e}")),
        _ = tokio::time::sleep(timeout) => {
            let _ = child.kill().await;
            Err("辨識逾時".to_string())
        }
        _ = cancel.notified() => {
            let _ = child.kill().await;
            Err("已取消".to_string())
        }
    }
}

async fn run_engine(data_dir: &Path, model: &Model, wav: &[u8], lang: &str) -> Result<String, String> {
    let _g = BusyGuard::take().ok_or("上一段還在辨識中")?;
    let dir = engine_dir(data_dir);
    let tmp = stt_dir(data_dir).join("tmp");
    std::fs::create_dir_all(&tmp).map_err(|e| format!("建立暫存資料夾失敗：{e}"))?;
    let stamp = format!("{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    let wav_path = tmp.join(format!("in-{stamp}.wav"));
    let out_base = tmp.join(format!("out-{stamp}"));
    let txt_path = tmp.join(format!("out-{stamp}.txt"));
    std::fs::write(&wav_path, wav).map_err(|e| format!("寫入暫存失敗：{e}"))?;
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
    let mut cmd = tokio::process::Command::new(dir.join(engine_cli_name()));
    cmd.args(build_args(&model_path(data_dir, model), &wav_path, &out_base, lang, threads))
        .current_dir(&dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：不要閃出黑視窗
    let res = match run_with_deadline(cmd, RUN_TIMEOUT, &CANCEL, |_| {}).await {
        Err(e) => Err(e),
        Ok(s) if !s.success() => Err("辨識引擎執行失敗".to_string()),
        Ok(_) => std::fs::read_to_string(&txt_path).map(|t| read_transcript(&t)).map_err(|_| "辨識沒有產生結果".to_string()),
    };
    let _ = std::fs::remove_file(&wav_path);
    let _ = std::fs::remove_file(&txt_path);
    res
}

// ---------- 指令 ----------

#[derive(Serialize)]
pub struct ModelInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub ready: bool,
}
#[derive(Serialize)]
pub struct Status {
    pub engine: bool,
    pub models: Vec<ModelInfo>,
    /// 目前設定用的模型是否可用（引擎＋模型都在）
    pub ready: bool,
    pub installing: bool,
    pub lang: String,
    pub model: String,
}

static INSTALLING: AtomicBool = AtomicBool::new(false);

pub fn status_of(data_dir: &Path) -> Status {
    let cfg = crate::voicecfg::load(data_dir);
    let engine = engine_ready(data_dir);
    let models: Vec<ModelInfo> = MODELS.iter().map(|m| ModelInfo { id: m.id, label: m.label, ready: model_ready(data_dir, m) }).collect();
    let ready = engine && model_of(&cfg.stt_model).map(|m| model_ready(data_dir, m)).unwrap_or(false);
    Status { engine, models, ready, installing: INSTALLING.load(Ordering::SeqCst), lang: cfg.stt_lang, model: cfg.stt_model }
}

#[tauri::command]
pub fn stt_status(app: State<'_, App>) -> Status {
    status_of(&app.data_dir)
}

#[derive(Serialize, Clone)]
struct Progress {
    stage: &'static str,
    done: u64,
    total: u64,
}

/// 下載引擎與目前選的模型（已有的略過）。進度用事件 `asn:stt-progress`（stage：engine／model）。
#[tauri::command]
pub async fn stt_install(app: State<'_, App>, handle: AppHandle) -> Result<(), String> {
    let cfg = crate::voicecfg::load(&app.data_dir);
    let model = model_of(&cfg.stt_model).ok_or("語音輸入的模型不認得")?;
    if INSTALLING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("已經在下載了".into());
    }
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            INSTALLING.store(false, Ordering::SeqCst);
        }
    }
    let _r = Reset;
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).read_timeout(Duration::from_secs(60)).build().map_err(|e| e.to_string())?;
    let dd = app.data_dir.clone();
    if !engine_ready(&dd) {
        let ext = if cfg!(windows) { "zip" } else { "tar.gz" };
        let archive = stt_dir(&dd).join(format!("engine-{ENGINE_TAG}.{ext}"));
        let h = handle.clone();
        download_verified(&client, ENGINE_URL, &archive, ENGINE_SHA256, ENGINE_BYTES + 1024 * 1024, move |d, t| {
            let _ = h.emit("asn:stt-progress", Progress { stage: "engine", done: d, total: t });
        })
        .await?;
        let (z, d2) = (archive.clone(), engine_dir(&dd));
        let r = tauri::async_runtime::spawn_blocking(move || extract_engine(&z, &d2)).await.map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&archive);
        r?;
    }
    if !model_ready(&dd, model) {
        let h = handle.clone();
        download_verified(&client, model.url, &model_path(&dd, model), model.sha256, model.bytes + 1024 * 1024, move |d, t| {
            let _ = h.emit("asn:stt-progress", Progress { stage: "model", done: d, total: t });
        })
        .await?;
    }
    let _ = handle.emit("asn:stt-progress", Progress { stage: "done", done: 1, total: 1 });
    Ok(())
}

/// 辨識一段錄音（base64 的 WAV）。回傳原始文字；過濾幻覺字、簡轉繁在前端做（有測試）
#[tauri::command]
pub async fn stt_transcribe(app: State<'_, App>, wav: String) -> Result<String, String> {
    if wav.len() > MAX_WAV_BYTES * 4 / 3 + 16 {
        return Err(format!("錄音太長（上限 {MAX_SECONDS} 秒）"));
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(wav.as_bytes()).map_err(|_| "錄音格式不對")?;
    check_wav(&bytes)?;
    let cfg = crate::voicecfg::load(&app.data_dir);
    let model = model_of(&cfg.stt_model).ok_or("語音輸入的模型不認得")?;
    if !engine_ready(&app.data_dir) || !model_ready(&app.data_dir, model) {
        return Err("還沒下載語音辨識".into());
    }
    run_engine(&app.data_dir, model, &bytes, &cfg.stt_lang).await
}

/// 取消正在進行的辨識：結束那個 whisper-cli 子程序，並等它收乾淨（最多 3 秒），這樣馬上再錄一段不會撞到「上一段還在辨識中」
#[tauri::command]
pub async fn stt_cancel() {
    if BUSY.load(Ordering::SeqCst) {
        CANCEL.notify_waiters();
        for _ in 0..60 {
            if !BUSY.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write as _};

    fn wav(seconds: f32) -> Vec<u8> {
        let n = (seconds * RATE as f32) as usize;
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&((36 + n * 2) as u32).to_le_bytes());
        v.extend_from_slice(b"WAVEfmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes());
        v.extend_from_slice(&RATE.to_le_bytes());
        v.extend_from_slice(&(RATE * 2).to_le_bytes());
        v.extend_from_slice(&2u16.to_le_bytes());
        v.extend_from_slice(&16u16.to_le_bytes());
        v.extend_from_slice(b"data");
        v.extend_from_slice(&((n * 2) as u32).to_le_bytes());
        v.extend(std::iter::repeat(0u8).take(n * 2));
        v
    }

    #[test]
    fn 固定的校驗碼與檔案_網址和長度對得上() {
        assert_eq!(ENGINE_SHA256.len(), 64);
        assert!(ENGINE_URL.starts_with("https://github.com/ggml-org/whisper.cpp/releases/download/") && ENGINE_URL.contains(ENGINE_TAG));
        for m in &MODELS {
            assert_eq!(m.sha256.len(), 64, "{}", m.id);
            assert!(m.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{}", m.id);
            assert!(m.url.starts_with("https://huggingface.co/ggerganov/whisper.cpp/resolve/") && m.url.ends_with(m.file), "{}", m.id);
            assert!(model_of(m.id).is_some());
        }
        assert!(model_of("../x").is_none());
        // 設定檔能選的模型都要有對應
        for id in crate::voicecfg::MODEL_IDS {
            assert!(model_of(id).is_some(), "{id}");
        }
    }

    #[test]
    fn 檢查_wav_規格() {
        assert!((check_wav(&wav(1.5)).unwrap() - 1.5).abs() < 0.01);
        assert!(check_wav(&[]).is_err() && check_wav(b"RIFFxxxx").is_err());
        let mut bad = wav(1.0);
        bad[24] = 0x44; // 取樣率改掉
        assert!(check_wav(&bad).is_err());
        let mut stereo = wav(1.0);
        stereo[22] = 2;
        assert!(check_wav(&stereo).is_err());
        let mut trunc = wav(1.0);
        trunc.truncate(trunc.len() - 10);
        assert!(check_wav(&trunc).is_err(), "宣告的長度比實際長");
        assert!(check_wav(&wav(MAX_SECONDS as f32 + 5.0)).is_err(), "超過 60 秒");
        assert!(check_wav(&wav(MAX_SECONDS as f32)).is_ok());
        let mut empty = wav(0.0);
        empty.truncate(44);
        assert!(check_wav(&empty).is_err());
    }

    #[test]
    fn 辨識參數與結果讀取() {
        let a: Vec<String> = build_args(Path::new("m.bin"), Path::new("a.wav"), Path::new("out"), "zh", 4).iter().map(|s| s.to_string_lossy().to_string()).collect();
        assert_eq!(&a[..4], ["-m", "m.bin", "-f", "a.wav"]);
        for flag in ["-nt", "-np", "-otxt", "--prompt"] {
            assert!(a.contains(&flag.to_string()), "{flag}");
        }
        assert!(a.windows(2).any(|w| w == ["-l", "zh"]) && a.windows(2).any(|w| w == ["-t", "4"]));
        let en: Vec<String> = build_args(Path::new("m"), Path::new("a"), Path::new("o"), "en", 2).iter().map(|s| s.to_string_lossy().to_string()).collect();
        assert!(!en.contains(&"--prompt".to_string()), "只有中文才帶繁體提示");
        assert_eq!(read_transcript(" 你好\n\n 世界 \r\n"), "你好 世界");
        assert_eq!(read_transcript("\n \n"), "");
    }

    /// 起一個只服務一次的本機 HTTP 伺服器
    fn serve(status: &str, body: Vec<u8>) -> (String, std::thread::JoinHandle<()>) {
        let ln = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/f", ln.local_addr().unwrap().port());
        let status = status.to_string();
        let th = std::thread::spawn(move || {
            let (mut s, _) = ln.accept().unwrap();
            let mut buf = [0u8; 2048];
            let _ = s.read(&mut buf);
            let _ = write!(s, "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
            let _ = s.write_all(&body);
        });
        (url, th)
    }
    fn sha(b: &[u8]) -> String {
        hex(&Sha256::digest(b))
    }

    #[tokio::test]
    async fn 下載_校驗碼對才留下() {
        let d = tempfile::tempdir().unwrap();
        let data = vec![7u8; 1_300_000];
        let (url, th) = serve("200 OK", data.clone());
        let dest = d.path().join("sub").join("f.bin");
        let mut seen = 0u32;
        download_verified(&reqwest::Client::new(), &url, &dest, &sha(&data).to_uppercase(), 2_000_000, |_, _| seen += 1).await.unwrap();
        th.join().unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), data);
        assert!(seen >= 2, "有回報進度");
        assert!(!PathBuf::from(format!("{}.part", dest.display())).exists());
    }

    #[tokio::test]
    async fn 下載_校驗碼不符_過大_失敗狀態都丟掉() {
        let d = tempfile::tempdir().unwrap();
        let data = vec![1u8; 5000];
        // 校驗碼不符
        let (url, th) = serve("200 OK", data.clone());
        let dest = d.path().join("a.bin");
        let e = download_verified(&reqwest::Client::new(), &url, &dest, &sha(b"other"), 10_000, |_, _| {}).await.unwrap_err();
        th.join().unwrap();
        assert!(e.contains("校驗碼不符"), "{e}");
        assert!(!dest.exists() && !PathBuf::from(format!("{}.part", dest.display())).exists());
        // 比預期大
        let (url, th) = serve("200 OK", data.clone());
        let dest = d.path().join("b.bin");
        let e = download_verified(&reqwest::Client::new(), &url, &dest, &sha(&data), 100, |_, _| {}).await.unwrap_err();
        th.join().unwrap();
        assert!(e.contains("比預期大"), "{e}");
        assert!(!dest.exists());
        // HTTP 404
        let (url, th) = serve("404 Not Found", b"no".to_vec());
        let dest = d.path().join("c.bin");
        let e = download_verified(&reqwest::Client::new(), &url, &dest, &sha(b"no"), 100, |_, _| {}).await.unwrap_err();
        th.join().unwrap();
        assert!(e.contains("404"), "{e}");
        assert!(!dest.exists());
    }

    fn make_zip(path: &Path, files: &[(&str, &[u8])]) {
        let mut z = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        for (n, b) in files {
            z.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(b).unwrap();
        }
        z.finish().unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn 解壓縮_只收_release_底下的_cli_與_dll_路徑穿越一律略過() {
        let d = tempfile::tempdir().unwrap();
        let zp = d.path().join("e.zip");
        make_zip(&zp, &[
            ("Release/whisper-cli.exe", b"EXE"),
            ("Release/whisper.dll", b"DLL"),
            ("Release/ggml-cpu-x64.dll", b"G"),
            ("Release/bench.exe", b"no"),
            ("Release/sub/evil.dll", b"no"),
            ("Release/../evil.dll", b"no"),
            ("../evil.dll", b"no"),
            ("evil.dll", b"no"),
            ("Release/C:evil.dll", b"no"),
        ]);
        let dest = d.path().join("engine");
        assert_eq!(extract_engine(&zp, &dest).unwrap(), 3);
        let mut names: Vec<String> = std::fs::read_dir(&dest).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        names.sort();
        assert_eq!(names, ["ggml-cpu-x64.dll", "whisper-cli.exe", "whisper.dll"]);
        assert!(!d.path().join("evil.dll").exists() && !dest.join("evil.dll").exists());
        // 重裝會整個換掉，不留舊檔
        make_zip(&zp, &[("Release/whisper-cli.exe", b"EXE2"), ("Release/whisper.dll", b"DLL2")]);
        extract_engine(&zp, &dest).unwrap();
        assert_eq!(std::fs::read_dir(&dest).unwrap().count(), 2);
        assert_eq!(std::fs::read(dest.join("whisper-cli.exe")).unwrap(), b"EXE2");
    }

    #[test]
    #[cfg(windows)]
    fn 解壓縮_缺引擎或不是壓縮檔就失敗_不留半成品() {
        let d = tempfile::tempdir().unwrap();
        let zp = d.path().join("e.zip");
        make_zip(&zp, &[("Release/bench.exe", b"x")]);
        let dest = d.path().join("engine");
        assert!(extract_engine(&zp, &dest).is_err());
        assert!(!dest.exists() && !PathBuf::from(format!("{}.tmp", dest.display())).exists());
        std::fs::write(&zp, b"not a zip").unwrap();
        assert!(extract_engine(&zp, &dest).is_err());
    }

    /// 一個會睡很久的假程式（只連本機的 ping／sleep，不碰網路）
    fn sleeper() -> tokio::process::Command {
        #[cfg(windows)]
        let mut c = {
            let mut c = tokio::process::Command::new("ping.exe");
            c.args(["-n", "40", "127.0.0.1"]);
            c
        };
        #[cfg(not(windows))]
        let mut c = {
            let mut c = tokio::process::Command::new("sleep");
            c.arg("40");
            c
        };
        c.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);
        c
    }
    fn alive(pid: u32) -> bool {
        #[cfg(windows)]
        {
            let o = std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
            String::from_utf8_lossy(&o.stdout).contains(&format!(" {pid} "))
        }
        #[cfg(not(windows))]
        {
            std::process::Command::new("kill").args(["-0", &pid.to_string()]).status().map(|s| s.success()).unwrap_or(false)
        }
    }

    #[tokio::test]
    async fn 子程序逾時_只結束那一個程序_很快就回() {
        let n = tokio::sync::Notify::new();
        let pid = std::sync::atomic::AtomicU32::new(0);
        let t0 = std::time::Instant::now();
        let e = run_with_deadline(sleeper(), Duration::from_millis(400), &n, |p| pid.store(p, Ordering::SeqCst)).await.unwrap_err();
        assert_eq!(e, "辨識逾時");
        assert!(t0.elapsed() < Duration::from_secs(10), "不能等到睡醒：{:?}", t0.elapsed());
        let pid = pid.load(Ordering::SeqCst);
        assert!(pid != 0 && pid != std::process::id());
        assert!(!alive(pid), "逾時後那個子程序要真的結束");
    }

    #[tokio::test]
    async fn 子程序被取消_也只結束那一個程序() {
        let n = std::sync::Arc::new(tokio::sync::Notify::new());
        let n2 = n.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            n2.notify_waiters();
        });
        let pid = std::sync::atomic::AtomicU32::new(0);
        let t0 = std::time::Instant::now();
        let e = run_with_deadline(sleeper(), Duration::from_secs(30), &n, |p| pid.store(p, Ordering::SeqCst)).await.unwrap_err();
        assert_eq!(e, "已取消");
        assert!(t0.elapsed() < Duration::from_secs(10));
        assert!(!alive(pid.load(Ordering::SeqCst)));
    }

    #[tokio::test]
    async fn 子程序正常結束_不受逾時影響_啟動失敗有說明() {
        let n = tokio::sync::Notify::new();
        #[cfg(windows)]
        let c = {
            let mut c = tokio::process::Command::new("cmd");
            c.args(["/C", "exit", "0"]);
            c
        };
        #[cfg(not(windows))]
        let c = tokio::process::Command::new("true");
        let s = run_with_deadline(c, Duration::from_secs(20), &n, |_| {}).await.unwrap();
        assert!(s.success());
        let e = run_with_deadline(tokio::process::Command::new("no-such-program-xyz"), Duration::from_secs(1), &n, |_| {}).await.unwrap_err();
        assert!(e.contains("啟動失敗"), "{e}");
    }

    #[test]
    fn 狀態_沒下載就是沒準備好() {
        let d = tempfile::tempdir().unwrap();
        let s = status_of(d.path());
        assert!(!s.engine && !s.ready && s.models.iter().all(|m| !m.ready));
        assert_eq!((s.lang.as_str(), s.model.as_str()), ("zh", "small"));
        // 引擎在、模型長度不對（沒下載完）也不算
        let ed = engine_dir(d.path());
        std::fs::create_dir_all(&ed).unwrap();
        std::fs::write(ed.join(engine_cli_name()), b"x").unwrap();
        if cfg!(windows) {
            std::fs::write(ed.join("whisper.dll"), b"x").unwrap();
        } else {
            std::fs::write(ed.join("libwhisper.so"), b"x").unwrap();
        }
        let mp = model_path(d.path(), &MODELS[0]);
        std::fs::create_dir_all(mp.parent().unwrap()).unwrap();
        std::fs::write(&mp, b"short").unwrap();
        let s = status_of(d.path());
        assert!(s.engine && !s.ready);
    }
}
