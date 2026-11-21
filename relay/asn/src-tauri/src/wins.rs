//! 多視窗：每個好友一扇對話、右下角提示視窗（置頂、不搶焦點、不進工作列、透明）、震動（真的移動視窗）、
//! 視窗按鈕（最小化／最大化／關閉）與 --shot 的螢幕擷取。
use crate::nowin::NoWindow;
use crate::{App, BROWSER_ARGS};
use serde::Deserialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};

const TOAST_W: f64 = 270.0;
const TOAST_H: f64 = 96.0;
const TOAST_GAP: f64 = 8.0;
const TOAST_MAX: usize = 3;
const TOAST_MS: u64 = 5500;
/// 安裝並登入的常駐進度小窗（#650 E1）
const PROG_W: f64 = 360.0;
const PROG_H: f64 = 208.0;
const PROG_LABEL: &str = "setup-progress";
/// 第幾輪：每次開小窗加一。結束後的自動關窗要帶著自己那一輪的編號，編號不同就不關（新的一輪已經接手）
static PROG_ROUND: AtomicU64 = AtomicU64::new(0);
/// 做完之後多久自己關（秒）
pub const PROG_DONE_SECS: u64 = 8;

/// 小窗的位置（物理像素）：貼工作區右下角，疊在 3 個提示視窗的位置之上，永遠不會跟任何一個提示重疊
pub fn progress_origin(wa_x: i32, wa_y: i32, wa_w: i32, wa_h: i32, sf: f64) -> (i32, i32) {
    let (pw, ph, th, gap) = ((PROG_W * sf) as i32, (PROG_H * sf) as i32, (TOAST_H * sf) as i32, (TOAST_GAP * sf) as i32);
    (wa_x + wa_w - pw - gap, wa_y + wa_h - (th + gap) * TOAST_MAX as i32 - ph - gap)
}

/// 最後一個進度事件：小窗開得比事件慢時，開起來先向這裡要（setup_progress_snapshot）
static PROG_LAST: Mutex<Vec<serde_json::Value>> = Mutex::new(Vec::new());

fn is_current_round(round: u64) -> bool {
    PROG_ROUND.load(Ordering::SeqCst) == round
}

/// 記下最新的進度事件：只留一個；結果（done）出來之後，晚到的進度不蓋掉結果
fn record_progress(ev: &serde_json::Value) {
    let mut last = PROG_LAST.lock().unwrap();
    if !last.first().is_some_and(|e| e["phase"] == "done") {
        last.clear();
        last.push(ev.clone());
    }
}

/// 送一個進度事件給所有視窗（名單裡的進度行與小窗都聽），同時記下來
pub fn progress_emit(app: &AppHandle, ev: serde_json::Value) {
    record_progress(&ev);
    let _ = app.emit("agent-setup", ev);
}

/// 小窗開起來時向這裡要目前的狀態（最後一個進度，或已經出來的結果）
#[tauri::command]
pub fn setup_progress_snapshot() -> Vec<serde_json::Value> {
    PROG_LAST.lock().unwrap().clone()
}

/// 開常駐進度小窗（已經開著就什麼都不做）：置頂、不搶輸入焦點、不進工作列、無邊框透明、可以點（取消鈕），不會自己關，結束後由呼叫端用 close_setup_progress 關。
/// 主視窗隱藏或最小化時照樣跳出來（它是獨立的視窗）
/// 回傳這一輪的編號。上一輪的小窗還開著（結果還在顯示）就沿用那個視窗，但清掉舊狀態、送「重來」事件讓畫面回到開頭，舊的計時到了也不會關到這一輪
pub fn open_setup_progress(app: &AppHandle) -> Result<u64, String> {
    let round = PROG_ROUND.fetch_add(1, Ordering::SeqCst) + 1;
    PROG_LAST.lock().unwrap().clear();
    if let Some(w) = app.get_webview_window(PROG_LABEL) {
        let _ = app.emit("agent-setup", serde_json::json!({ "phase": "reset" }));
        let _ = w.show();   // 舊窗本來就開著，這裡不會再呼叫系統顯示，也就不會搶焦點
        return Ok(round);
    }
    let origin = app.primary_monitor().ok().flatten().map(|m| {
        let wa = m.work_area();
        let sf = m.scale_factor();
        let (x, y) = progress_origin(wa.position.x, wa.position.y, wa.size.width as i32, wa.size.height as i32, sf);
        (x, y, sf)
    });
    let mut builder = WebviewWindowBuilder::new(app, PROG_LABEL, WebviewUrl::App("setup-progress.html".into()))
        .title("ASN 安裝並登入")
        .inner_size(PROG_W, PROG_H)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(cfg!(windows))   // 見 show_toast：Windows 要在建窗當下顯示才不會搶焦點
        .disable_drag_drop_handler()
        .additional_browser_args(BROWSER_ARGS);
    if let Some((x, y, sf)) = origin {
        builder = builder.position(x as f64 / sf, y as f64 / sf);
    }
    let w = builder.build().map_err(|e| e.to_string())?;
    if let Some((x, y, _)) = origin {
        let _ = w.set_position(PhysicalPosition::new(x, y));   // 建窗時的位置是邏輯座標；多螢幕縮放不同時這裡校正
    }
    if !cfg!(windows) {
        let _ = w.show();
    }
    Ok(round)
}

/// 關小窗；只有編號還是這一輪才關（新的一輪已經開始就不動它）
pub fn close_setup_progress(app: &AppHandle, round: u64) {
    if !is_current_round(round) {
        return;
    }
    if let Some(w) = app.get_webview_window(PROG_LABEL) {
        let _ = w.close();
    }
}

#[derive(Default)]
pub struct Slots(Mutex<[bool; TOAST_MAX]>);

/// 已經畫完（頁面回報過 `toast_painted`）的提示視窗 label；視窗關閉時清掉（#1953）
#[derive(Default)]
pub struct Painted(Mutex<HashSet<String>>);

impl Painted {
    fn mark(&self, label: &str) { self.0.lock().unwrap().insert(label.to_string()); }
    fn forget(&self, label: &str) { self.0.lock().unwrap().remove(label); }
    fn has(&self, label: &str) -> bool { self.0.lock().unwrap().contains(label) }
}

/// 提示頁掛載並等過兩個畫面更新後呼叫：回報「這扇已經畫出內容」。--shot 截圖前靠它判斷能不能拍
#[tauri::command]
pub fn toast_painted(window: Window, painted: State<'_, Painted>) {
    if window.label().starts_with("toast-") { painted.mark(window.label()); }
}

const PAINT_WAIT_MS: u64 = 10_000;
const PAINT_POLL_MS: u64 = 100;

/// 等 `open()` 列出的每一扇都 `painted(label)` 為真，最多等 `max`；回傳逾時時還沒畫好的 label（全好就是空的）。
/// 逾時不當錯誤：照常擷取，由測試門檻判定；沒畫好的是哪一扇寫進 log
async fn wait_all_painted(open: impl Fn() -> Vec<String>, painted: impl Fn(&str) -> bool, max: Duration, poll: Duration) -> Vec<String> {
    let t0 = std::time::Instant::now();
    loop {
        let waiting: Vec<String> = open().into_iter().filter(|l| !painted(l)).collect();
        if waiting.is_empty() {
            // 正面紀錄：放行時哪幾扇已回報畫完、等了多久（過去只能靠「沒有逾時行」推論）
            let mut open = open();
            open.sort();
            elog!("[shot] 提示視窗都已回報畫完，等了 {}ms：{}", t0.elapsed().as_millis(), if open.is_empty() { "（沒有提示視窗）".to_string() } else { open.join("、") });
            return waiting;
        }
        if t0.elapsed() >= max {
            elog!("[shot] 等了 {}ms 仍沒畫好的提示視窗：{}", t0.elapsed().as_millis(), waiting.join("、"));
            return waiting;
        }
        tokio::time::sleep(poll).await;
    }
}

/// 視窗外框：false＝自訂（ASN 自己畫 Aero 風標題列與邊框，預設）、true＝Windows 原生。
/// 開機時讀資料夾裡 asn-me.json 的 frame 欄位（前端存的設定），之後由設定頁透過 set_frame 即時改。
#[derive(Default)]
pub struct Frame(pub AtomicBool);

/// 存檔文字 → 是不是原生外框：只有 `"frame":"native"` 才是；沒這欄位的舊存檔、壞檔、壞值一律是自訂
pub fn native_from_saved(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text).ok().and_then(|v| v.get("frame")?.as_str().map(|f| f == "native")).unwrap_or(false)
}

/// 開機：照存檔設定主視窗的外框（視窗是由 tauri.conf 建的，預設無邊框）
pub fn init_frame(app: &AppHandle, native: bool) {
    app.state::<Frame>().0.store(native, Ordering::Relaxed);
    if native {
        if let Some(w) = app.get_webview_window("list") {
            let _ = w.set_decorations(true);
        }
    }
}

/// 目前是不是原生外框（每扇視窗載入時問一次，決定要不要藏自畫的標題列）
#[tauri::command]
pub fn frame_native(frame: State<'_, Frame>) -> bool {
    frame.0.load(Ordering::Relaxed)
}

/// 設定頁切換外框：名單、對話視窗立刻改，之後開的視窗也照這個；提示視窗永遠無邊框
#[tauri::command]
pub fn set_frame(app: AppHandle, frame: State<'_, Frame>, native: bool) {
    frame.0.store(native, Ordering::Relaxed);
    for (label, w) in app.webview_windows() {
        if label == "list" || label.starts_with("chat-") || is_panel_label(&label) {
            let _ = w.set_decorations(native);
        }
    }
    let _ = app.emit("asn:frame", native);
}

/// 對話視窗標籤：好友 id 的 UTF-8 位元組轉十六進位（標籤只允許英數與 -/:_）
pub fn chat_label(id: &str) -> String {
    let hex: String = id.bytes().map(|b| format!("{b:02x}")).collect();
    format!("chat-{hex}")
}

fn q(s: &str) -> String {
    crate::relay::encode_component(s)
}

#[tauri::command]
pub async fn open_chat(app: AppHandle, frame: State<'_, Frame>, id: String, title: String) -> Result<(), String> {
    let label = chat_label(&id);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    // 有多扇對話時錯開位置，不要疊在一起
    let n = app.webview_windows().keys().filter(|k| k.starts_with("chat-")).count() as f64;
    let mut b = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(format!("chat.html?id={}", q(&id)).into()))
        .title(title)
        .inner_size(720.0, 600.0)
        .min_inner_size(520.0, 440.0)
        .decorations(frame.0.load(Ordering::Relaxed))
        .disable_drag_drop_handler()   // 讓 WebView2 的 HTML5 拖放（分頁排序）能觸發
        .additional_browser_args(BROWSER_ARGS);
    b = if n == 0.0 { b.center() } else { b.position(120.0 + 28.0 * n, 80.0 + 28.0 * n) };
    b.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// 指引、設定兩扇聊天窗（分離模式）：每種各一扇，內容由名單視窗用事件換
const PANEL_KINDS: [&str; 2] = ["guide", "setting"];

/// 指引、設定視窗的標籤；種類不認得就 None
pub fn panel_label(kind: &str) -> Option<String> {
    PANEL_KINDS.contains(&kind).then(|| format!("panel-{kind}"))
}

/// 視窗標籤是不是指引、設定視窗
pub fn is_panel_label(label: &str) -> bool {
    label.strip_prefix("panel-").is_some_and(|k| PANEL_KINDS.contains(&k))
}

/// 開（或叫出）指引／設定視窗：已開著就只換標題並叫到前面，內容由前端用 asn:panel 事件換；沒開就照記住的大小開新的
#[tauri::command]
pub async fn open_panel(app: AppHandle, frame: State<'_, Frame>, kind: String, title: String, w: f64, h: f64) -> Result<(), String> {
    let label = panel_label(&kind).ok_or("不認得的視窗種類")?;
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_title(&title);
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let (w, h) = (w.clamp(360.0, 8000.0), h.clamp(320.0, 8000.0));
    let mut b = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(format!("panel.html?kind={kind}").into()))
        .title(title)
        .inner_size(w, h)
        .min_inner_size(360.0, 320.0)
        .decorations(frame.0.load(Ordering::Relaxed))
        .disable_drag_drop_handler()
        .additional_browser_args(BROWSER_ARGS);
    // 指引錯開在左、設定在右，同時開著也不會疊在一起
    b = if kind == "guide" { b.position(140.0, 100.0) } else { b.position(200.0, 130.0) };
    b.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// 關掉指引、設定視窗（kind 給了只關那一種），回傳原本開著的種類（整合模式切換時前端把它們變成分頁）
#[tauri::command]
pub fn close_panels(app: AppHandle, kind: Option<String>) -> Vec<String> {
    let mut kinds = vec![];
    for (label, w) in app.webview_windows() {
        let Some(k) = label.strip_prefix("panel-").filter(|k| PANEL_KINDS.contains(k)) else { continue };
        if kind.as_deref().is_some_and(|only| only != k) {
            continue;
        }
        kinds.push(k.to_string());
        let _ = w.close();
    }
    kinds.sort();
    kinds
}

/// 該好友的對話視窗是否開著且沒最小化（來信時決定要不要未讀＋提示）
#[tauri::command]
pub fn chat_visible(app: AppHandle, id: String) -> bool {
    app.get_webview_window(&chat_label(&id)).map(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(true)).unwrap_or(false)
}

/// 對話視窗標籤 → 好友 id（chat_label 的反向；不合格式就 None）
pub fn chat_id_of(label: &str) -> Option<String> {
    let hex = label.strip_prefix("chat-")?;
    if hex.is_empty() || hex.len() % 2 != 0 || !hex.is_ascii() {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok()).collect();
    String::from_utf8(bytes?).ok()
}

/// 整合模式用：關掉所有對話視窗，回傳它們原本是哪些好友（前端把它們變成分頁）
#[tauri::command]
pub fn close_chats(app: AppHandle) -> Vec<String> {
    let mut ids = vec![];
    for (label, w) in app.webview_windows() {
        if let Some(id) = chat_id_of(&label) {
            ids.push(id);
            let _ = w.close();
        }
    }
    ids.sort();
    ids
}

/// 從視窗標籤清單挑出開著的對話視窗（好友 id）與指引、設定視窗（種類），各自排序（記住分頁用）
pub fn open_window_sets<'a>(labels: impl Iterator<Item = &'a str>) -> (Vec<String>, Vec<String>) {
    let (mut chats, mut panels) = (vec![], vec![]);
    for label in labels {
        if let Some(id) = chat_id_of(label) {
            chats.push(id);
        } else if let Some(k) = label.strip_prefix("panel-").filter(|k| PANEL_KINDS.contains(k)) {
            panels.push(k.to_string());
        }
    }
    chats.sort();
    panels.sort();
    (chats, panels)
}

/// 目前開著的對話視窗與指引、設定視窗（不關掉）；前端存「重啟後要開回哪些視窗」
#[tauri::command]
pub fn open_windows(app: AppHandle) -> (Vec<String>, Vec<String>) {
    let wins = app.webview_windows();
    open_window_sets(wins.keys().map(|k| k.as_str()))
}

/// 主視窗（名單／整合模式的唯一視窗）是否開著且沒最小化
#[tauri::command]
pub fn main_visible(app: AppHandle) -> bool {
    app.get_webview_window("list").map(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(true)).unwrap_or(false)
}

/// 整合模式點好友／點提示：把主視窗叫出來
#[tauri::command]
pub fn show_main(app: AppHandle) {
    if let Some(w) = app.get_webview_window("list") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 套用視窗模式的大小：整合模式最小 720×480，分開模式最小 280×420；大小是前端記住的（CSS 像素）
#[tauri::command]
pub fn main_layout(app: AppHandle, merged: bool, w: f64, h: f64, recenter: bool) {
    let Some(win) = app.get_webview_window("list") else { return };
    let (mw, mh) = if merged { (720.0, 480.0) } else { (280.0, 420.0) };
    let (w, h) = (w.clamp(mw, 8000.0), h.clamp(mh, 8000.0));
    let _ = win.set_min_size(Some(LogicalSize::new(mw, mh)));
    let _ = win.set_size(LogicalSize::new(w, h));
    if recenter {
        let _ = win.center();
    }
}

/// 震動：把該好友的對話視窗（整合模式＝主視窗）左右上下抖約 0.55 秒，再放回原位
#[tauri::command]
pub fn shake(app: AppHandle, id: String, main: Option<bool>) {
    let label = if main == Some(true) { "list".to_string() } else { chat_label(&id) };
    let Some(w) = app.get_webview_window(&label) else { return };
    let Ok(origin) = w.outer_position() else { return };
    let _ = w.unminimize();
    std::thread::spawn(move || {
        let offs: [(i32, i32); 10] = [(-9, 4), (8, -5), (-7, -3), (7, 5), (-6, 2), (5, -4), (-4, 3), (3, -2), (-2, 1), (0, 0)];
        for (dx, dy) in offs {
            let _ = w.set_position(PhysicalPosition::new(origin.x + dx, origin.y + dy));
            std::thread::sleep(Duration::from_millis(55));
        }
        let _ = w.set_position(origin);
    });
}

#[derive(Deserialize)]
pub struct Toast {
    cid: String,
    title: String,
    line: String,
    status: String,
    hue: f64,
    dp: String,
    /// 提示上的大頭貼：設備上傳的圖（data URL）；沒有就由提示視窗用好友 id 自己畫自動產生的那張
    av: Option<String>,
}

fn clip(s: &str, n: usize) -> String {
    let t: String = s.chars().take(n).collect();
    if s.chars().count() > n { format!("{t}…") } else { t }
}

/// 提示視窗的網址；大頭貼（av）只有通過格式與大小檢查才帶，否則不帶（提示視窗會改用自動產生的）
fn toast_url(toast: &Toast, status: &str) -> String {
    let mut url = format!(
        "toast.html?cid={}&title={}&line={}&status={}&hue={}&dp={}",
        q(&toast.cid), q(&clip(&toast.title, 40)), q(&clip(&toast.line, 60)), status, toast.hue as i64, q(&clip(&toast.dp, 2))
    );
    if let Some(av) = toast.av.as_deref().filter(|a| crate::avatar::validate(a).is_ok()) {
        url.push_str(&format!("&av={}", q(av)));
    }
    url
}

/// 提示視窗幾毫秒後自己關；--shot 模式回 None（不自動關，等截圖拍完由 `close_shot_toasts` 關）。
/// #1953：Windows runner 上擷取很慢，提示視窗 5.5 秒就自關，重截還沒輪到它就消失了，留下畫到一半的小圖
fn toast_auto_close_ms(shot_mode: bool) -> Option<u64> {
    if shot_mode { None } else { Some(TOAST_MS) }
}

/// --shot：截圖（含重截）全部結束後，關掉還開著的提示視窗並放掉位置
fn close_shot_toasts(app: &AppHandle) {
    for (label, w) in app.webview_windows() {
        if !label.starts_with("toast-") { continue }
        let _ = w.close();   // 視窗可能剛好已被點掉；關不掉不影響截圖結果
        if let Some(slot) = label.strip_prefix("toast-").and_then(|r| r.split('-').next()).and_then(|n| n.parse::<usize>().ok()) {
            if slot < TOAST_MAX { release(app, slot); }
        }
    }
}

fn release(app: &AppHandle, slot: usize) {
    app.state::<Slots>().0.lock().unwrap()[slot] = false;
}

/// 右下角提示：置頂、不搶焦點、不進工作列、無邊框透明；貼螢幕工作區右下角往上疊，約 5.5 秒後自己關
#[tauri::command]
pub async fn show_toast(app: AppHandle, slots: State<'_, Slots>, state: State<'_, App>, toast: Toast) -> Result<(), String> {
    let slot = {
        let mut s = slots.0.lock().unwrap();
        match s.iter().position(|u| !*u) {
            Some(i) => { s[i] = true; i }
            None => return Ok(()),   // 同時最多三則
        }
    };
    static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let label = format!("toast-{}-{}", slot, SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let status = if ["online", "busy", "away", "offline"].contains(&toast.status.as_str()) { toast.status.as_str() } else { "online" };
    let url = toast_url(&toast, status);
    // 貼工作區右下角（扣掉工作列），第 slot 則往上疊
    let origin = app.primary_monitor().ok().flatten().map(|m| {
        let sf = m.scale_factor();
        let wa = m.work_area();
        let (tw, th, gap) = ((TOAST_W * sf) as i32, (TOAST_H * sf) as i32, (TOAST_GAP * sf) as i32);
        let x = wa.position.x + wa.size.width as i32 - tw - gap;
        let y = wa.position.y + wa.size.height as i32 - (th + gap) * (slot as i32 + 1);
        (x, y, sf)
    });
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("ASN 提示")
        .inner_size(TOAST_W, TOAST_H)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        // 建窗當下就顯示：tao 只在建窗時用 SW_SHOWNOACTIVATE，建完就清掉不搶焦點的記號；之後才 show() 會走 SW_SHOW，
        // ASN 在前景時前景與輸入焦點都被這扇窗拿走，WS_EX_NOACTIVATE 也擋不住。直接呼叫 Win32 顯示則會少刷新外框，多出原生標題列。
        // 其他平台維持原本的先設位置再顯示
        .visible(cfg!(windows))
        .disable_drag_drop_handler()
        .additional_browser_args(BROWSER_ARGS);
    if let Some((x, y, sf)) = origin {
        builder = builder.position(x as f64 / sf, y as f64 / sf);
    }
    // 視窗不論怎麼關（自動關、點掉、截圖後統一關）都清掉「已畫完」記錄
    let w = match builder.build() {
        Ok(w) => w,
        Err(e) => { release(&app, slot); return Err(e.to_string()); }
    };
    let (a_ev, l_ev) = (app.clone(), label.clone());
    w.on_window_event(move |ev| {
        if let WindowEvent::Destroyed = ev { a_ev.state::<Painted>().forget(&l_ev); }
    });
    if let Some((x, y, _)) = origin {
        let _ = w.set_position(PhysicalPosition::new(x, y));   // 建窗時的位置是邏輯座標；多螢幕縮放不同時這裡校正
    }
    if !cfg!(windows) {
        let _ = w.show();
    }
    // --shot 模式不自動關：截圖流程（含重截）要拍得到它，由 take_shot 拍完統一關（#1953）
    if let Some(ms) = toast_auto_close_ms(state.shot.is_some()) {
        let (a2, l2) = (app.clone(), label.clone());
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            if let Some(w) = a2.get_webview_window(&l2) { let _ = w.close(); }
            release(&a2, slot);
        });
    }
    Ok(())
}

/// 點提示：叫樞紐開對話，並關掉這則提示
#[tauri::command]
pub fn toast_click(app: AppHandle, window: Window, cid: String) {
    let _ = app.emit("asn:open", serde_json::json!({ "cid": cid }));
    let _ = window.close();
}

/// 自訂標題列的按鈕
#[tauri::command]
pub fn win_ctl(window: Window, op: String) {
    match op.as_str() {
        "min" => { let _ = window.minimize(); }
        "max" => { if window.is_maximized().unwrap_or(false) { let _ = window.unmaximize(); } else { let _ = window.maximize(); } }
        "close" => { let _ = window.close(); }
        _ => {}
    }
}

/// --shot：把名單、對話、提示三類視窗各用螢幕擷取存成 PNG（沒有 capturePage，所以用 PowerShell CopyFromScreen 抓視窗範圍）
#[tauri::command]
pub async fn take_shot(app: AppHandle, state: State<'_, App>, tab: Option<String>) -> Result<(), String> {
    let dir = state.shot.clone().ok_or("不在 --shot 模式")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let wins = app.webview_windows();
    // 名單放左、對話放右，避免互相遮住
    // 暫時置頂，才不會被使用者桌面上別的視窗蓋住而拍到別人的畫面
    if let Some(l) = wins.get("list") { let _ = l.set_position(PhysicalPosition::new(40, 40)); let _ = l.set_always_on_top(true); }
    if let Some((_, c)) = wins.iter().find(|(k, _)| k.starts_with("chat-")) { let _ = c.set_position(PhysicalPosition::new(420, 40)); let _ = c.set_always_on_top(true); }
    for (label, p) in &wins { if is_panel_label(label) { let _ = p.set_position(PhysicalPosition::new(420, 40)); let _ = p.set_always_on_top(true); } }
    tokio::time::sleep(Duration::from_millis(900)).await;
    // 先等開著的提示視窗都回報畫完（上限約 10 秒）；逾時只記 log，照常擷取，由測試門檻判定
    {
        let a = app.clone();
        wait_all_painted(
            || a.webview_windows().into_keys().filter(|l| l.starts_with("toast-")).collect(),
            |l| a.state::<Painted>().has(l),
            Duration::from_millis(PAINT_WAIT_MS),
            Duration::from_millis(PAINT_POLL_MS),
        ).await;
    }
    // 提示視窗只在這次截的是「完整一輪」（沒帶 tab）時才關：之後帶 tab 的逐頁截圖不拍提示視窗，也不需要它
    let close = tab.is_none();
    capture_then_cleanup(
        capture_until_drawn(&dir, SHOT_MIN_BYTES, shot_retry_max(shot_toast_lenient()), Duration::from_millis(SHOT_RETRY_MS), |only| {
            let (app, dir, tab) = (app.clone(), dir.clone(), tab.clone());
            async move { take_shot_capture(&app, &dir, tab, only).await }
        }, ShotHooks {
            nudge: |name: &str| nudge_toast(&app, name),
            diag: |small: &[String]| {
                let (app, dir, small) = (app.clone(), dir.clone(), small.to_vec());
                async move { shot_diag(&app, &dir, &small).await }
            },
            budget: Duration::from_millis(SHOT_RETRY_BUDGET_MS),
        }),
        || if close { close_shot_toasts(&app) },
    )
    .await
}

/// 先等截圖做完，不論成敗再收尾（關提示視窗）；收尾一定排在截圖之後
async fn capture_then_cleanup<Fut, C>(capture: Fut, cleanup: C) -> Result<(), String>
where
    Fut: std::future::Future<Output = Result<(), String>>,
    C: FnOnce(),
{
    let r = capture.await;
    cleanup();
    r
}

/// 截圖檔小於這個大小，視為視窗還沒畫完（慢的機器上提示視窗常見，#1953）；只用來決定要不要重截，不是測試門檻
const SHOT_MIN_BYTES: u64 = 3000;
const SHOT_RETRY_MAX: u32 = 40;
const SHOT_RETRY_MS: u64 = 150;
/// 發版機放寬模式（#2033）的重截上限：提示視窗截圖疑似空白只警告，不值得把 e2e 的時間花在重截上
/// （Windows 每次重截約 1.2 秒，40 次約 48 秒，會把 e2e 拖到逾時）
const SHOT_RETRY_MAX_LENIENT: u32 = 8;

/// 發版 workflow 設 `ASN_SHOT_TOAST_LENIENT=1` 時，提示視窗截圖疑似空白只警告（判斷在 test/shot-png.mjs 的 checkShot）
fn shot_toast_lenient() -> bool {
    std::env::var("ASN_SHOT_TOAST_LENIENT").is_ok_and(|v| v == "1")
}

fn shot_retry_max(lenient: bool) -> u32 {
    if lenient { SHOT_RETRY_MAX_LENIENT } else { SHOT_RETRY_MAX }
}

/// 重截總時間上限：實測 40 次約 48 秒，留給 e2e 其餘步驟的空間
const SHOT_RETRY_BUDGET_MS: u64 = 60_000;

/// 重截時的兩個外掛動作（注入，單元測試用假的）：
/// - `nudge(視窗名)`：對仍太小的提示視窗催它重新合成；失敗只記 log，不中斷截圖
/// - `diag(仍太小的名單)`：重截超過 `SHOT_DIAG_AFTER` 次還太小時做一次診斷（整螢幕圖＋視窗順序 log）
/// - `budget`：重截總時間上限，超過就停、照現狀交出（e2e 有 120 秒逾時，不能被重截吃光）
struct ShotHooks<N, D> { nudge: N, diag: D, budget: Duration }

/// 重截超過這麼多次仍太小，就留一份整螢幕圖與視窗順序（診斷用，每次截圖只做一次）
const SHOT_DIAG_AFTER: u32 = 10;

/// 催提示視窗重新合成：尺寸加 1 像素再還原。不啟用、不搶焦點，也不 hide／show（show 會走 SW_SHOW 搶焦點）
fn nudge_toast(app: &AppHandle, name: &str) -> Result<(), String> {
    let w = app.get_webview_window(name).ok_or_else(|| "視窗已不在".to_string())?;
    let s = w.outer_size().map_err(|e| e.to_string())?;
    w.set_size(tauri::PhysicalSize::new(s.width + 1, s.height)).map_err(|e| e.to_string())?;
    w.set_size(tauri::PhysicalSize::new(s.width, s.height)).map_err(|e| e.to_string())
}

/// 診斷：整個螢幕存成 diag-screen.png（和其他截圖同資料夾、同 artifact），並把各視窗的最上層順序寫進 log
async fn shot_diag(app: &AppHandle, dir: &Path, small: &[String]) {
    elog!("[shot] 重截超過 {SHOT_DIAG_AFTER} 次仍太小：{}；存整螢幕圖並記視窗順序", small.join("、"));
    let hwnds = window_handles(app);
    elog!("[shot] 視窗代號：{}", hwnds.join(" "));
    match shot_diag_capture(dir, &hwnds).await {
        Ok(out) => elog!("[shot] 視窗由上而下（序號 代號 可見 位置大小 標題）：\n{}", out.trim_end()),
        Err(e) => elog!("[shot] 診斷擷取失敗：{e}"),
    }
}

#[cfg(windows)]
fn window_handles(app: &AppHandle) -> Vec<String> {
    app.webview_windows().into_iter().filter_map(|(l, w)| w.hwnd().ok().map(|h| format!("{l}={}", h.0 as usize))).collect()
}
#[cfg(not(windows))]
fn window_handles(_app: &AppHandle) -> Vec<String> { vec![] }

#[cfg(windows)]
async fn shot_diag_capture(dir: &Path, hwnds: &[String]) -> Result<String, String> {
    let script = r#"
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public class Z {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
[Z]::SetProcessDPIAware() | Out-Null
$v = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $v.Width, $v.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($v.X, $v.Y, 0, 0, $bmp.Size)
$bmp.Save((Join-Path $env:ASN_DIR 'diag-screen.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
$ours = @{}
foreach ($kv in ($env:ASN_HWNDS -split ' ')) { if ($kv) { $p = $kv -split '='; $ours[$p[1]] = $p[0] } }
$h = [Z]::GetTopWindow([IntPtr]::Zero); $i = 0
while ($h -ne [IntPtr]::Zero -and $i -lt 400) {
  $key = [string]([int64]$h)
  $vis = [Z]::IsWindowVisible($h)
  if ($ours.ContainsKey($key) -or ($vis -and $i -lt 40)) {
    $r = New-Object Z+RECT; [Z]::GetWindowRect($h, [ref]$r) | Out-Null
    $sb = New-Object System.Text.StringBuilder 80; [Z]::GetWindowText($h, $sb, 80) | Out-Null
    $tag = if ($ours.ContainsKey($key)) { $ours[$key] } else { '-' }
    Write-Output ("{0} {1} {2} ({3},{4},{5}x{6}) {7}" -f $i, $tag, $vis, $r.L, $r.T, ($r.R-$r.L), ($r.B-$r.T), $sb.ToString())
  }
  $h = [Z]::GetWindow($h, 2); $i++
}
"#;
    let o = tokio::process::Command::new("powershell").no_window()
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("ASN_DIR", dir)
        .env("ASN_HWNDS", hwnds.join(" "))
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !o.status.success() { return Err(format!("結束碼 {}：{}", o.status, String::from_utf8_lossy(&o.stderr).trim())); }
    Ok(String::from_utf8_lossy(&o.stdout).into_owned())
}

/// 非 Windows：沒有視窗順序可查，只記一行（Linux 的 scrot 路徑不需要這份診斷）
#[cfg(not(windows))]
async fn shot_diag_capture(_dir: &Path, _hwnds: &[String]) -> Result<String, String> {
    Ok("（此平台不做視窗順序診斷）".to_string())
}

/// 截完檢查每張圖，太小的（還沒畫完）隔一小段時間只重截那幾扇，最多重試 `max_retry` 次；仍太小就照現狀交出，由測試判定。
/// 重截前，對仍太小的提示視窗（`toast-` 開頭）先催一次重新合成（#2033：網頁回報畫完不等於螢幕已呈現）
async fn capture_until_drawn<F, Fut, N, D, DFut>(dir: &Path, min_bytes: u64, max_retry: u32, gap: Duration, mut capture: F, mut hooks: ShotHooks<N, D>) -> Result<(), String>
where
    F: FnMut(Option<Vec<String>>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<String>, String>>,
    N: FnMut(&str) -> Result<(), String>,
    D: FnMut(&[String]) -> DFut,
    DFut: std::future::Future<Output = ()>,
{
    let t0 = std::time::Instant::now();
    let mut names = capture(None).await?;
    let mut diagnosed = false;
    for n in 1..=max_retry {
        names.retain(|n| std::fs::metadata(dir.join(format!("{n}.png"))).map(|m| m.len() < min_bytes).unwrap_or(true));
        if names.is_empty() { break }
        if t0.elapsed() >= hooks.budget {
            elog!("[shot] 重截已超過 {}ms 上限，仍太小的照現狀交出：{}", hooks.budget.as_millis(), names.join("、"));
            break;
        }
        for name in names.iter().filter(|x| x.starts_with("toast-")) {
            if let Err(e) = (hooks.nudge)(name) { elog!("[shot] 催 {name} 重新合成失敗（照常重截）：{e}"); }
        }
        if n > SHOT_DIAG_AFTER && !diagnosed {
            diagnosed = true;
            (hooks.diag)(&names).await;
        }
        tokio::time::sleep(gap).await;
        // 重截失敗（擷取程序偶發錯誤、視窗剛好被收掉）不該讓已截到的結果作廢：停止重試，照現狀交出
        names = match capture(Some(names)).await {
            Ok(done) => done,
            Err(e) => { elog!("[shot] 重截失敗，保留已截到的圖：{e}"); break }
        };
        // 每次重截都留一行：哪幾扇、現在多大、距離第一次截多久（排查「畫不出來」還是「時間不夠」用）
        let sizes: Vec<String> = names.iter().map(|x| format!("{x}={}", std::fs::metadata(dir.join(format!("{x}.png"))).map(|m| m.len().to_string()).unwrap_or_else(|_| "無檔".into()))).collect();
        elog!("[shot] 重截 {n}：{} 耗時 {}ms", sizes.join(" "), t0.elapsed().as_millis());
    }
    Ok(())
}

#[cfg(windows)]
async fn take_shot_capture(app: &AppHandle, dir: &Path, tab: Option<String>, only: Option<Vec<String>>) -> Result<Vec<String>, String> {
    let mut specs = vec![];
    let mut names = vec![];
    for (label, w) in app.webview_windows() {
        // 帶 tab：只拍名單視窗，檔名 tabs-<tab>（逐頁籤截圖用）；分離模式開著的指引、設定視窗另拍，檔名就是 panel-guide、panel-setting
        if tab.is_some() && label != "list" && !is_panel_label(&label) { continue }
        let name = if is_panel_label(&label) { label.clone() } else if label == "list" { tab.as_ref().map(|t| format!("tabs-{}", t.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect::<String>())).unwrap_or_else(|| "list".to_string()) } else if label.starts_with("chat-") { "chat".to_string() } else if label.starts_with("toast-") { label.clone() } else { continue };
        if only.as_ref().is_some_and(|o| !o.contains(&name)) { continue }
        if let (Ok(p), Ok(s)) = (w.outer_position(), w.outer_size()) {
            names.push(name.clone());
            if only.is_some() { elog!("[shot] 重截目標 {name}：visible={:?} 位置=({},{}) 大小={}x{}", w.is_visible(), p.x, p.y, s.width, s.height); }
            specs.push(format!("{name}|{}|{}|{}|{}", p.x, p.y, s.width, s.height));
        }
    }
    let script = r#"
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[Dpi]::SetProcessDPIAware() | Out-Null
foreach ($s in ($env:ASN_SPECS -split ';')) {
  if (-not $s) { continue }
  $p = $s -split '\|'
  $bmp = New-Object System.Drawing.Bitmap ([int]$p[3]), ([int]$p[4])
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen([int]$p[1], [int]$p[2], 0, 0, $bmp.Size)
  $bmp.Save((Join-Path $env:ASN_DIR ($p[0] + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
"#;
    let status = tokio::process::Command::new("powershell").no_window()
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("ASN_SPECS", specs.join(";"))
        .env("ASN_DIR", dir)
        .status()
        .await
        .map_err(|e| e.to_string())?;
    if status.success() { Ok(names) } else { Err(format!("擷取失敗：{status}")) }
}

/// Linux：用 scrot 依視窗外框擷取（需 X11／Xvfb）；沒有 scrot 就略過 PNG，流程仍跑完。
#[cfg(not(windows))]
async fn take_shot_capture(app: &AppHandle, dir: &Path, tab: Option<String>, only: Option<Vec<String>>) -> Result<Vec<String>, String> {
    let scrot = which_scrot();
    let Some(scrot) = scrot else { return Ok(vec![]) };
    let mut names = vec![];
    for (label, w) in app.webview_windows() {
        if tab.is_some() && label != "list" && !is_panel_label(&label) {
            continue;
        }
        let name = if is_panel_label(&label) {
            label.clone()
        } else if label == "list" {
            tab.as_ref()
                .map(|t| format!("tabs-{}", t.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect::<String>()))
                .unwrap_or_else(|| "list".to_string())
        } else if label.starts_with("chat-") {
            "chat".to_string()
        } else if label.starts_with("toast-") {
            label.clone()
        } else {
            continue;
        };
        if only.as_ref().is_some_and(|o| !o.contains(&name)) {
            continue;
        }
        let (Ok(p), Ok(s)) = (w.outer_position(), w.outer_size()) else { continue };
        if s.width == 0 || s.height == 0 {
            continue;
        }
        if only.is_some() { elog!("[shot] 重截目標 {name}：visible={:?} 位置=({},{}) 大小={}x{}", w.is_visible(), p.x, p.y, s.width, s.height); }
        let out = dir.join(format!("{name}.png"));
        let area = format!("{},{},{},{}", p.x, p.y, s.width, s.height);
        let status = tokio::process::Command::new(&scrot).no_window()
            .args(["-o", "-a", &area, out.to_string_lossy().as_ref()])
            .status()
            .await
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("scrot 擷取失敗：{status}"));
        }
        names.push(name);
    }
    Ok(names)
}

#[cfg(not(windows))]
fn which_scrot() -> Option<String> {
    std::env::var_os("PATH").and_then(|path| {
        for dir in path.to_string_lossy().split(':').filter(|d| !d.is_empty()) {
            let p = std::path::PathBuf::from(dir).join("scrot");
            if p.is_file() {
                return Some(p.display().to_string());
            }
        }
        None
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #2033：發版機放寬模式少重截，e2e 不會被重截拖到逾時；平常仍照原上限重截
    #[test]
    fn t2033_放寬模式重截上限較短() {
        assert_eq!(shot_retry_max(false), SHOT_RETRY_MAX);
        assert_eq!(shot_retry_max(true), SHOT_RETRY_MAX_LENIENT);
        assert!(SHOT_RETRY_MAX_LENIENT * 1200 < 15_000, "放寬模式重截（Windows 每次約 1.2 秒）要在 15 秒內結束");
    }

    type NoNudge = fn(&str) -> Result<(), String>;
    type NoDiag = fn(&[String]) -> std::future::Ready<()>;

    /// 不做任何外掛動作的 hooks（只想測重截本身的測試用）
    fn no_hooks() -> ShotHooks<NoNudge, NoDiag> {
        ShotHooks { nudge: |_| Ok(()), diag: |_| std::future::ready(()), budget: Duration::from_secs(60) }
    }

    /// 假擷取：toast-2-2 寫成 804，直到第 `drawn_at` 次才變 9000；list 一律 9000；with_chat 時另帶一個一直太小的對話視窗
    fn fake_capture(dir: &Path, drawn_at: u32, with_chat: bool) -> impl FnMut(Option<Vec<String>>) -> std::future::Ready<Result<Vec<String>, String>> {
        let (d, mut n) = (dir.to_path_buf(), 0u32);
        move |_| {
            n += 1;
            std::fs::write(d.join("list.png"), vec![1u8; 9000]).unwrap();
            std::fs::write(d.join("toast-2-2.png"), vec![1u8; if n >= drawn_at { 9000 } else { 804 }]).unwrap();
            let mut names = vec!["list".to_string(), "toast-2-2".to_string()];
            if with_chat { std::fs::write(d.join("chat.png"), vec![1u8; 804]).unwrap(); names.push("chat".to_string()); }
            std::future::ready(Ok(names))
        }
    }

    type Log<T> = std::sync::Arc<std::sync::Mutex<Vec<T>>>;

    /// #2033：提示視窗太小，重截前要催它重新合成（網頁回報畫完不等於螢幕已呈現）；畫好之後就不再催
    #[tokio::test]
    async fn t2033_提示視窗太小才催_畫好就不催() {
        let dir = tempfile::tempdir().unwrap();
        let nudged: Log<String> = Default::default();
        let n2 = nudged.clone();
        let hooks = ShotHooks { nudge: move |name: &str| { n2.lock().unwrap().push(name.to_string()); Ok(()) }, diag: |_: &[String]| std::future::ready(()), budget: Duration::from_secs(60) };
        capture_until_drawn(dir.path(), SHOT_MIN_BYTES, SHOT_RETRY_MAX, Duration::from_millis(1), fake_capture(dir.path(), 4, false), hooks).await.unwrap();
        // 第 1~3 次截都太小、第 4 次才畫好：催發生在「重截前」，所以催 3 次，每次都是 toast-2-2；list 與畫好之後都不催
        assert_eq!(*nudged.lock().unwrap(), vec!["toast-2-2"; 3]);
    }

    /// #2033：只有 toast- 開頭的才催；對話視窗之類太小不催（只動提示視窗）
    #[tokio::test]
    async fn t2033_非提示視窗太小不催() {
        let dir = tempfile::tempdir().unwrap();
        let nudged: Log<String> = Default::default();
        let n2 = nudged.clone();
        let hooks = ShotHooks { nudge: move |name: &str| { n2.lock().unwrap().push(name.to_string()); Ok(()) }, diag: |_: &[String]| std::future::ready(()), budget: Duration::from_secs(60) };
        capture_until_drawn(dir.path(), SHOT_MIN_BYTES, 5, Duration::from_millis(1), fake_capture(dir.path(), 1, true), hooks).await.unwrap();
        assert!(nudged.lock().unwrap().is_empty(), "toast 一開始就畫好、chat 太小但不是提示視窗：一次都不該催");
    }

    /// #2033：催失敗（視窗剛好被收掉等）只記 log，照常重截、不讓截圖失敗
    #[tokio::test]
    async fn t2033_催失敗不中斷截圖() {
        let dir = tempfile::tempdir().unwrap();
        let hooks = ShotHooks { nudge: |_: &str| Err("視窗已不在".to_string()), diag: |_: &[String]| std::future::ready(()), budget: Duration::from_secs(60) };
        let r = capture_until_drawn(dir.path(), SHOT_MIN_BYTES, SHOT_RETRY_MAX, Duration::from_millis(1), fake_capture(dir.path(), 3, false), hooks).await;
        assert!(r.is_ok(), "{r:?}");
        assert_eq!(std::fs::metadata(dir.path().join("toast-2-2.png")).unwrap().len(), 9000, "催失敗仍繼續重截到畫好");
    }

    /// #2033：重截超過 SHOT_DIAG_AFTER 次仍太小才做診斷，而且一次截圖只做一次；很快畫好就不診斷
    #[tokio::test]
    async fn t2033_久久畫不好才做診斷且只做一次() {
        let dir = tempfile::tempdir().unwrap();
        let diags: Log<Vec<String>> = Default::default();
        let mk = |l: Log<Vec<String>>| ShotHooks { nudge: |_: &str| Ok(()), diag: move |small: &[String]| { l.lock().unwrap().push(small.to_vec()); std::future::ready(()) }, budget: Duration::from_secs(60) };
        capture_until_drawn(dir.path(), SHOT_MIN_BYTES, SHOT_RETRY_MAX, Duration::from_millis(1), fake_capture(dir.path(), 5, false), mk(diags.clone())).await.unwrap();
        assert!(diags.lock().unwrap().is_empty(), "很快就畫好：不診斷");
        capture_until_drawn(dir.path(), SHOT_MIN_BYTES, SHOT_RETRY_MAX, Duration::from_millis(1), fake_capture(dir.path(), u32::MAX, false), mk(diags.clone())).await.unwrap();
        assert_eq!(*diags.lock().unwrap(), vec![vec!["toast-2-2".to_string()]], "一直太小：診斷剛好一次，名單是仍太小的那扇");
    }

    /// #2033：重截超過總時間上限就停、照現狀交出，不吃光 e2e 的逾時
    #[tokio::test]
    async fn t2033_重截有總時間上限() {
        let dir = tempfile::tempdir().unwrap();
        let hooks = ShotHooks { nudge: |_: &str| Ok(()), diag: |_: &[String]| std::future::ready(()), budget: Duration::from_millis(50) };
        let t0 = std::time::Instant::now();
        let r = capture_until_drawn(dir.path(), SHOT_MIN_BYTES, 100_000, Duration::from_millis(10), fake_capture(dir.path(), u32::MAX, false), hooks).await;
        assert!(r.is_ok());
        assert!(t0.elapsed() < Duration::from_secs(5), "超過上限就要停：{:?}", t0.elapsed());
    }

    /// #1953 一審：重截時擷取失敗，不能把已截到的結果變成失敗
    #[tokio::test]
    async fn t1953_重截失敗仍交出已截到的圖() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().to_path_buf();
        let mut n = 0;
        let r = capture_until_drawn(dir.path(), SHOT_MIN_BYTES, SHOT_RETRY_MAX, Duration::from_millis(1), move |_| {
            n += 1;
            let res = if n == 1 {
                std::fs::write(d.join("list.png"), vec![1u8; 9000]).unwrap();
                std::fs::write(d.join("toast-2-2.png"), vec![1u8; 804]).unwrap();
                Ok(vec!["list".to_string(), "toast-2-2".to_string()])
            } else { Err("擷取失敗".to_string()) };
            async move { res }
        }, no_hooks())
        .await;
        assert!(r.is_ok(), "重截失敗不該讓整個截圖失敗：{r:?}");
        assert_eq!(std::fs::metadata(dir.path().join("list.png")).unwrap().len(), 9000);
        assert!(dir.path().join("toast-2-2.png").exists());
    }

    /// #1953：慢機器上提示視窗還沒畫完就截，只有 804 bytes；要重截到畫好為止，而且只重截還太小的那一扇
    #[tokio::test]
    async fn t1953_提示視窗沒畫完會重截_直到畫好() {
        let dir = tempfile::tempdir().unwrap();
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Option<Vec<String>>>::new()));
        let c2 = calls.clone();
        let d = dir.path().to_path_buf();
        let mut n = 0;
        capture_until_drawn(dir.path(), SHOT_MIN_BYTES, SHOT_RETRY_MAX, Duration::from_millis(1), move |only| {
            n += 1;
            c2.lock().unwrap().push(only.clone());
            let drawn = n >= 4;   // 第 4 次才畫好
            std::fs::write(d.join("list.png"), vec![1u8; 9000]).unwrap();
            std::fs::write(d.join("toast-2-2.png"), vec![1u8; if drawn { 9000 } else { 804 }]).unwrap();
            async move { Ok(vec!["list".to_string(), "toast-2-2".to_string()]) }
        }, no_hooks())
        .await
        .unwrap();
        assert_eq!(std::fs::metadata(dir.path().join("toast-2-2.png")).unwrap().len(), 9000, "最後要是畫好的那張");
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 4);
        assert_eq!(calls[1], Some(vec!["toast-2-2".to_string()]), "畫好的 list 不重截");
    }

    /// #1953：--shot 模式提示視窗不自動關（否則 5.5 秒就消失，重截拍不到）；正式路徑仍是 5500ms
    #[test]
    fn t1953_提示視窗只有shot模式不自動關() {
        assert_eq!(toast_auto_close_ms(true), None);
        assert_eq!(toast_auto_close_ms(false), Some(5500));
    }

    /// #1953：關提示視窗一定晚於截圖（含重截）做完，截圖失敗也照關
    #[tokio::test]
    async fn t1953_shot結束後才關提示視窗() {
        let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::<&'static str>::new()));
        let (l1, l2) = (log.clone(), log.clone());
        let r = capture_then_cleanup(
            async move { tokio::time::sleep(Duration::from_millis(20)).await; l1.lock().unwrap().push("截圖完成"); Ok(()) },
            move || l2.lock().unwrap().push("關提示"),
        ).await;
        assert!(r.is_ok());
        assert_eq!(*log.lock().unwrap(), vec!["截圖完成", "關提示"]);
        let l3 = std::sync::Arc::new(std::sync::Mutex::new(false));
        let l4 = l3.clone();
        let r = capture_then_cleanup(async { Err("擷取失敗".to_string()) }, move || *l4.lock().unwrap() = true).await;
        assert!(r.is_err() && *l3.lock().unwrap(), "截圖失敗也要關，且錯誤照原樣回傳");
    }

    /// #1953：已回報畫完的立刻放行；沒回報的等到上限，並回傳是哪一扇；中途回報了就放行
    #[tokio::test]
    async fn t1953_等提示視窗畫完() {
        let ms = Duration::from_millis;
        let open = || vec!["toast-0-0".to_string(), "toast-1-1".to_string()];
        let t = std::time::Instant::now();
        assert!(wait_all_painted(open, |_| true, ms(2000), ms(5)).await.is_empty());
        assert!(t.elapsed() < ms(500), "都畫好了就不該等");
        let t = std::time::Instant::now();
        let left = wait_all_painted(open, |l| l == "toast-0-0", ms(120), ms(10)).await;
        assert_eq!(left, vec!["toast-1-1".to_string()], "逾時要回傳沒畫好的那一扇");
        assert!(t.elapsed() >= ms(120), "沒回報就要等到上限");
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let f2 = flag.clone();
        tokio::spawn(async move { tokio::time::sleep(ms(60)).await; f2.store(true, Ordering::SeqCst); });
        let left = wait_all_painted(|| vec!["toast-2-2".to_string()], |_| flag.load(Ordering::SeqCst), ms(3000), ms(10)).await;
        assert!(left.is_empty(), "等待中回報了就放行");
        assert!(wait_all_painted(Vec::new, |_| false, ms(50), ms(5)).await.is_empty(), "沒有提示視窗就不用等");
    }

    /// #1953：回報記錄只認 toast 視窗；關窗後清掉
    #[test]
    fn t1953_關窗會清掉已畫完記錄() {
        let p = Painted::default();
        assert!(!p.has("toast-2-2"));
        p.mark("toast-2-2");
        assert!(p.has("toast-2-2"));
        p.forget("toast-2-2");
        assert!(!p.has("toast-2-2"));
    }

    #[test]
    fn 進度小窗疊在提示視窗上方不重疊且在工作區內() {
        for sf in [1.0, 1.5, 2.0] {
            let (wa_x, wa_y, wa_w, wa_h) = (0, 0, (1920.0 * sf) as i32, (1040.0 * sf) as i32);   // 工作區的物理像素跟著縮放比例
            let (x, y) = progress_origin(wa_x, wa_y, wa_w, wa_h, sf);
            let toast_top = wa_y + wa_h - ((TOAST_H + TOAST_GAP) * sf) as i32 * TOAST_MAX as i32;
            assert!(y + (PROG_H * sf) as i32 <= toast_top, "{sf}：不能壓到最上面那個提示位置");
            assert!(x >= 0 && x + (PROG_W * sf) as i32 <= wa_x + wa_w && y >= 0, "{sf}：要在工作區內");
        }
    }

    #[test]
    fn 結束後自動關窗只認自己那一輪() {
        let first = PROG_ROUND.fetch_add(1, Ordering::SeqCst) + 1;
        assert!(is_current_round(first));
        let second = PROG_ROUND.fetch_add(1, Ordering::SeqCst) + 1;
        assert!(!is_current_round(first), "新的一輪開始後，舊的一輪不能再關窗");
        assert!(is_current_round(second));
    }

    #[test]
    fn 進度事件只留最新一個且結果出來後不被晚到的進度蓋掉() {
        use serde_json::json;
        PROG_LAST.lock().unwrap().clear();
        record_progress(&json!({"phase": "a"}));
        record_progress(&json!({"phase": "b"}));
        assert_eq!(setup_progress_snapshot(), vec![json!({"phase": "b"})]);
        record_progress(&json!({"phase": "done", "ok": true}));
        record_progress(&json!({"phase": "late"}));
        assert_eq!(setup_progress_snapshot(), vec![json!({"phase": "done", "ok": true})]);
        PROG_LAST.lock().unwrap().clear();
    }

    #[test]
    fn 對話視窗標籤只含合法字元且互不相同() {
        let a = chat_label("W/W-政策");
        let b = chat_label("W/W-政第");
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'), "{a}");
        assert_ne!(a, b);
        assert_eq!(chat_label("A"), "chat-41");
    }

    #[test]
    fn 視窗標籤可以還原成好友_id() {
        for id in ["W/W-政策", "H/H-島作", "a/b"] {
            assert_eq!(chat_id_of(&chat_label(id)).as_deref(), Some(id));
        }
        for bad in ["list", "chat-", "chat-4", "chat-zz", "toast-0-1", "chat-ff"] {
            assert_eq!(chat_id_of(bad), None, "{bad}");
        }
    }

    #[test]
    fn 開著的視窗分成對話與面板() {
        let labels = ["list", "chat-6162", "panel-guide", "toast-0-1", "panel-x", "chat-6161"];
        let (c, p) = open_window_sets(labels.into_iter());
        assert_eq!(c, vec!["aa".to_string(), "ab".to_string()]);
        assert_eq!(p, vec!["guide".to_string()]);
    }

    #[test]
    fn 提示網址_大頭貼通過檢查才帶() {
        let mk = |av: Option<&str>| Toast { cid: "W/a".into(), title: "t".into(), line: "l".into(), status: "online".into(), hue: 10.0, dp: "W".into(), av: av.map(String::from) };
        let ok = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
        assert!(toast_url(&mk(Some(ok)), "online").contains("&av=data%3Aimage%2Fpng"));
        assert!(!toast_url(&mk(None), "online").contains("av="));
        for bad in ["javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,!!"] {
            assert!(!toast_url(&mk(Some(bad)), "online").contains("av="), "{bad}");
        }
    }

    #[test]
    fn 外框設定_沒欄位的舊存檔與壞值都是自訂() {
        assert!(native_from_saved(r#"{"frame":"native","sound":true}"#));
        for t in [r#"{"sound":true}"#, r#"{"frame":"custom"}"#, r#"{"frame":"Native"}"#, r#"{"frame":true}"#, r#"{"frame":null}"#, "{壞掉", ""] {
            assert!(!native_from_saved(t), "{t}");
        }
    }

    #[test]
    fn 指引與設定視窗標籤_只認兩種() {
        assert_eq!(panel_label("guide").as_deref(), Some("panel-guide"));
        assert_eq!(panel_label("setting").as_deref(), Some("panel-setting"));
        for bad in ["", "chat", "Guide", "guide ", "../x"] {
            assert_eq!(panel_label(bad), None, "{bad}");
        }
        assert!(is_panel_label("panel-guide") && is_panel_label("panel-setting"));
        for bad in ["panel-", "panel-x", "list", "chat-70616e656c2d", "toast-0-1", "panel-guide2"] {
            assert!(!is_panel_label(bad), "{bad}");
        }
        // 對話視窗與指引視窗的標籤互不相干（chat_id_of 不會把面板視窗當成好友）
        assert_eq!(chat_id_of("panel-guide"), None);
    }

    #[test]
    fn 截斷() {
        assert_eq!(clip("abcdef", 3), "abc…");
        assert_eq!(clip("ab", 3), "ab");
    }
}
