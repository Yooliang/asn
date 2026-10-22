//! 用量估算（#52）：直接讀本機 Claude Code 的對話記錄（`<家目錄>\.claude\projects\**\*.jsonl`），
//! 把 assistant 訊息的 `message.usage`（input／output／cache 寫入／cache 讀取）依日、依模型加總，
//! 再用內建價目表估成本。不執行任何外部程式、不下載任何東西、不上傳；記錄檔含對話內容，這裡只取數字與模型名。
//!
//! 效能：只看近期修改的檔案（超過統計範圍的整檔略過）；每個檔案的解析結果快取在記憶體，
//! 檔案沒變就不重讀，只增長就只讀新增的部分（記錄檔是附加寫入）。掃描在背景執行緒（`spawn_blocking`）。
//!
//! 重複訊息：Claude Code 會把同一則 assistant 訊息寫成好幾行（串流每個區塊一行），續接的對話也會
//! 複製舊紀錄；以 `message.id` ＋ `requestId` 去重，同一則留 output 最大的那一行（最終值）。
//!
//! 價目表（`PRICES`）：只是估算——依 Anthropic 官方公開定價頁，不含批次折扣、快速模式、工具費用等；
//! 查不到價目的模型不計入成本，介面會列出來。日期以本機時區的日曆日切分（由前端傳入時差）。
//!
//! 紅線：函式一律吃路徑參數；只有 Tauri 指令 `usage_summary` 會決定真實家目錄，測試不得呼叫它。
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// 價目表的來源與抓取日期（介面與說明用）
pub const PRICE_SOURCE: &str = "https://platform.claude.com/docs/en/about-claude/pricing";
pub const PRICE_DATE: &str = "2026-10-22";

/// 一列價目：每百萬 token 的美元。`minor` 為 None 表示該主版本只有一種。
/// 比對規則見 `price_for`；同家族（family）取版本完全相同的那列。
struct Price {
    family: &'static str,
    major: u32,
    minor: u32,
    input: f64,
    write_5m: f64,
    write_1h: f64,
    read: f64,
    output: f64,
}
const fn p(family: &'static str, major: u32, minor: u32, input: f64, write_5m: f64, write_1h: f64, read: f64, output: f64) -> Price {
    Price { family, major, minor, input, write_5m, write_1h, read, output }
}
const PRICES: &[Price] = &[
    p("fable", 5, 1, 10.0, 12.5, 20.0, 0.25, 50.0),
    p("fable", 5, 0, 10.0, 12.5, 20.0, 1.0, 50.0),
    p("mythos", 5, 1, 10.0, 12.5, 20.0, 0.25, 50.0),
    p("mythos", 5, 0, 10.0, 12.5, 20.0, 1.0, 50.0),
    p("opus", 5, 5, 4.0, 5.0, 8.0, 0.2, 20.0),
    p("opus", 5, 0, 5.0, 6.25, 10.0, 0.5, 25.0),
    p("opus", 4, 8, 5.0, 6.25, 10.0, 0.5, 25.0),
    p("opus", 4, 7, 5.0, 6.25, 10.0, 0.5, 25.0),
    p("opus", 4, 6, 5.0, 6.25, 10.0, 0.5, 25.0),
    p("opus", 4, 5, 5.0, 6.25, 10.0, 0.5, 25.0),
    p("opus", 4, 1, 15.0, 18.75, 30.0, 1.5, 75.0),
    p("opus", 4, 0, 15.0, 18.75, 30.0, 1.5, 75.0),
    p("sonnet", 5, 5, 2.0, 2.5, 4.0, 0.1, 10.0),
    p("sonnet", 5, 0, 2.0, 2.5, 4.0, 0.2, 10.0),
    p("sonnet", 4, 6, 3.0, 3.75, 6.0, 0.3, 15.0),
    p("sonnet", 4, 5, 3.0, 3.75, 6.0, 0.3, 15.0),
    p("sonnet", 4, 0, 3.0, 3.75, 6.0, 0.3, 15.0),
    // Haiku 5.5 依單次提示長度分兩檔（見 `HAIKU55_LONG`），這列是 100,000 token 以內
    p("haiku", 5, 5, 0.10, 0.125, 0.20, 0.01, 0.50),
    p("haiku", 4, 5, 1.0, 1.25, 2.0, 0.1, 5.0),
    p("haiku", 3, 5, 0.8, 1.0, 1.6, 0.08, 4.0),
];
/// Haiku 5.5 提示超過 100,000 token 的那一檔
const HAIKU55_LONG: Price = p("haiku", 5, 5, 0.50, 0.625, 1.0, 0.05, 2.50);
const HAIKU55_LIMIT: u64 = 100_000;

/// 從模型名取出（家族, 主版本, 次版本）。吃得下 `claude-opus-4-5-20251101`、`claude-opus-4.5`、
/// `claude-3-5-haiku-20241022`、`us.anthropic.claude-sonnet-4-20250514-v1:0` 這類寫法；認不得回 None。
pub fn parse_model(model: &str) -> Option<(&'static str, u32, u32)> {
    let m = model.to_ascii_lowercase();
    let family = ["fable", "mythos", "opus", "sonnet", "haiku"].into_iter().find(|f| m.contains(f))?;
    // 版本數字：以 - . : _ 切開，只收 1～2 位數；碰到日期（3 位數以上）或 v1 這類版次就停
    let mut nums: Vec<u32> = Vec::new();
    for t in m.split(|c: char| matches!(c, '-' | '.' | ':' | '_' | '/')).filter(|t| !t.is_empty()) {
        let digits = t.bytes().all(|b| b.is_ascii_digit());
        if (digits && t.len() >= 3) || (t.starts_with('v') && t[1..].bytes().all(|b| b.is_ascii_digit()) && t.len() > 1) {
            break;
        }
        if digits {
            if let Ok(n) = t.parse() {
                nums.push(n);
            }
        }
    }
    let major = *nums.first()?;
    let minor = nums.get(1).copied().unwrap_or(0);
    Some((family, major, minor))
}

fn price_for(model: &str, prompt_tokens: u64) -> Option<&'static Price> {
    let (family, major, minor) = parse_model(model)?;
    if family == "haiku" && major == 5 && minor == 5 && prompt_tokens > HAIKU55_LIMIT {
        return Some(&HAIKU55_LONG);
    }
    PRICES.iter().find(|r| r.family == family && r.major == major && r.minor == minor)
}

// ---------- 時間 ----------
/// 西曆日期 → 自 1970-01-01 起的天數
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}
/// 自 1970-01-01 起的天數 → (年, 月, 日)
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 解析 ISO 8601（`2026-10-21T08:12:33.123Z`、`...+08:00`）→ 毫秒（UTC）；格式不對回 None
pub fn parse_ts_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !(b[10] == b'T' || b[10] == b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |a: usize, z: usize| -> Option<i64> { s.get(a..z)?.parse().ok() };
    let (y, mo, d, h, mi, se) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut i = 19;
    let mut ms = 0i64;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let mut scale = 100;
        while let Some(c) = b.get(i).filter(|c| c.is_ascii_digit()) {
            ms += (*c - b'0') as i64 * scale;
            scale /= 10;
            i += 1;
        }
    }
    let off_min = match b.get(i) {
        None | Some(b'Z') | Some(b'z') => 0,
        Some(&sign @ (b'+' | b'-')) => {
            let oh = num(i + 1, i + 3)?;
            let om = if b.get(i + 3) == Some(&b':') { num(i + 4, i + 6)? } else { num(i + 3, i + 5).unwrap_or(0) };
            let v = oh * 60 + om;
            if sign == b'+' { v } else { -v }
        }
        _ => return None,
    };
    Some(((days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se - off_min * 60) * 1000) + ms)
}

const BUCKET_MS: i64 = 15 * 60 * 1000; // 15 分鐘一格：任何真實時區的日界線都落在格線上

/// 本機日曆日編號（自 1970-01-01 起）；tz_offset_min＝瀏覽器的 getTimezoneOffset（UTC 減本機，分鐘）
fn local_day(ms: i64, tz_offset_min: i32) -> i64 {
    (ms / 60_000 - tz_offset_min as i64).div_euclid(1440)
}

// ---------- 解析 ----------
#[derive(Deserialize)]
struct Line {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    #[serde(rename = "isApiErrorMessage")]
    is_api_error: Option<bool>,
    message: Option<Msg>,
}
#[derive(Deserialize)]
struct Msg {
    id: Option<String>,
    model: Option<String>,
    usage: Option<Usage>,
}
#[derive(Deserialize, Default)]
struct Usage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation: Option<CacheCreation>,
}
#[derive(Deserialize, Default)]
struct CacheCreation {
    ephemeral_5m_input_tokens: Option<u64>,
    ephemeral_1h_input_tokens: Option<u64>,
}

#[derive(Clone)]
struct Rec {
    key: u64, // 0＝沒有訊息 id，不去重
    bucket: i64,
    model: Arc<str>,
    input: u64,
    output: u64,
    write_5m: u64,
    write_1h: u64,
    read: u64,
}

/// 解析一行；不是有用量的 assistant 訊息回 None（不丟錯：壞行、別種行一律略過）
fn parse_line(line: &str, models: &mut HashMap<String, Arc<str>>) -> Option<Rec> {
    // 先用字串快速篩掉絕大多數行（使用者訊息、工具結果都很長）
    if !line.contains("\"usage\"") {
        return None;
    }
    let l: Line = serde_json::from_str(line).ok()?;
    if l.kind.as_deref() != Some("assistant") || l.is_api_error == Some(true) {
        return None;
    }
    let ms = parse_ts_ms(l.timestamp.as_deref()?)?;
    let msg = l.message?;
    let model = msg.model?;
    if model.starts_with('<') {
        return None; // <synthetic> 等非真實呼叫
    }
    let u = msg.usage?;
    let input = u.input_tokens.unwrap_or(0);
    let output = u.output_tokens.unwrap_or(0);
    let write_all = u.cache_creation_input_tokens.unwrap_or(0);
    let read = u.cache_read_input_tokens.unwrap_or(0);
    // 有分 5 分鐘／1 小時就照分；沒分（或加起來對不上）全算 5 分鐘
    let (w5, w1) = match u.cache_creation {
        Some(c) => {
            let (a, b) = (c.ephemeral_5m_input_tokens.unwrap_or(0), c.ephemeral_1h_input_tokens.unwrap_or(0));
            if a + b == write_all { (a, b) } else { (write_all, 0) }
        }
        None => (write_all, 0),
    };
    if input + output + w5 + w1 + read == 0 {
        return None;
    }
    let key = match msg.id {
        Some(id) => {
            let mut h = DefaultHasher::new();
            id.hash(&mut h);
            l.request_id.hash(&mut h);
            h.finish().max(1)
        }
        None => 0,
    };
    let model: Arc<str> = models.entry(model.clone()).or_insert_with(|| Arc::from(model.as_str())).clone();
    Some(Rec { key, bucket: ms.div_euclid(BUCKET_MS), model, input, output, write_5m: w5, write_1h: w1, read })
}

// ---------- 掃描與快取 ----------
struct FileEntry {
    len: u64,
    mtime_ms: i64,
    offset: u64, // 已解析到的位置（最後一個換行之後）
    recs: Vec<Rec>,
}

#[derive(Default)]
pub struct Scanner {
    files: HashMap<PathBuf, FileEntry>,
    models: HashMap<String, Arc<str>>,
}

fn mtime_ms(md: &std::fs::Metadata) -> i64 {
    md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// 遞迴找 *.jsonl（含子資料夾；不跟符號連結；深度上限避免意外迴圈）
fn walk(dir: &Path, depth: u32, out: &mut Vec<(PathBuf, std::fs::Metadata)>) {
    if depth > 6 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let path = e.path();
        if ft.is_dir() {
            walk(&path, depth + 1, out);
        } else if ft.is_file() && path.extension().is_some_and(|x| x == "jsonl") {
            if let Ok(md) = e.metadata() {
                out.push((path, md));
            }
        }
    }
}

impl Scanner {
    /// 更新單一檔案的快取：沒變不讀、只增長就只讀新增部分、變短或換掉就重讀
    fn refresh_file(&mut self, path: &Path, md: &std::fs::Metadata) {
        let (len, mt) = (md.len(), mtime_ms(md));
        let entry = self.files.entry(path.to_path_buf()).or_insert(FileEntry { len: 0, mtime_ms: 0, offset: 0, recs: Vec::new() });
        if entry.len == len && entry.mtime_ms == mt {
            return;
        }
        if len < entry.offset {
            entry.offset = 0;
            entry.recs.clear();
        }
        let Ok(mut f) = std::fs::File::open(path) else { return };
        if f.seek(SeekFrom::Start(entry.offset)).is_err() {
            return;
        }
        let mut buf = Vec::new();
        if f.take(len.saturating_sub(entry.offset)).read_to_end(&mut buf).is_err() {
            return;
        }
        let end = buf.iter().rposition(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
        for raw in buf[..end].split(|&b| b == b'\n') {
            if let Ok(s) = std::str::from_utf8(raw) {
                if let Some(r) = parse_line(s, &mut self.models) {
                    entry.recs.push(r);
                }
            }
        }
        entry.offset += end as u64;
        entry.len = len;
        entry.mtime_ms = mt;
    }

    /// 掃描 roots 底下的記錄檔並算出統計。now_ms＝現在（UTC 毫秒）、tz_offset_min＝本機時差。
    pub fn summarize(&mut self, roots: &[PathBuf], now_ms: i64, tz_offset_min: i32) -> Summary {
        let today = local_day(now_ms, tz_offset_min);
        let (y, m, _) = civil_from_days(today);
        let month_start = days_from_civil(y, m, 1);
        let week_start = today - 6;
        let earliest_day = month_start.min(week_start);
        // 本機日界線 → UTC 毫秒；再多留一天當檔案修改時間的餘裕
        let earliest_ms = (earliest_day * 1440 + tz_offset_min as i64) * 60_000;
        let mtime_floor = earliest_ms - 86_400_000;

        let mut found: Vec<(PathBuf, std::fs::Metadata)> = Vec::new();
        let mut roots_found = false;
        for r in roots {
            let proj = r.join("projects");
            if proj.is_dir() {
                roots_found = true;
                walk(&proj, 0, &mut found);
            }
        }
        found.retain(|(_, md)| mtime_ms(md) >= mtime_floor);
        let live: std::collections::HashSet<&PathBuf> = found.iter().map(|(p, _)| p).collect();
        self.files.retain(|p, _| live.contains(p)); // 太舊或已刪的檔從快取丟掉
        for (p, md) in &found {
            self.refresh_file(p, md);
        }

        // 去重：同一則訊息留 output 最大的一行
        let mut best: HashMap<u64, &Rec> = HashMap::new();
        let mut all: Vec<&Rec> = Vec::new();
        for (p, _) in &found {
            if let Some(e) = self.files.get(p) {
                for r in &e.recs {
                    if r.key == 0 {
                        all.push(r);
                    } else {
                        best.entry(r.key).and_modify(|o| if r.output > o.output { *o = r }).or_insert(r);
                    }
                }
            }
        }
        all.extend(best.into_values());

        let h5_from = now_ms - 5 * 3600 * 1000;
        let mut periods: Vec<PeriodAcc> = vec![PeriodAcc::new("today", "今天"), PeriodAcc::new("week", "近 7 天"), PeriodAcc::new("month", "本月"), PeriodAcc::new("hours5", "近 5 小時")];
        let mut unpriced: std::collections::BTreeSet<String> = Default::default();
        for r in all {
            let bucket_ms = r.bucket * BUCKET_MS;
            let day = local_day(bucket_ms, tz_offset_min);
            let (cost, priced) = cost_of(r);
            if !priced {
                unpriced.insert(r.model.to_string());
            }
            let hit = [day == today, day >= week_start && day <= today, day >= month_start && day <= today, bucket_ms + BUCKET_MS > h5_from && bucket_ms <= now_ms];
            for (acc, h) in periods.iter_mut().zip(hit) {
                if h {
                    acc.add(r, cost, priced);
                }
            }
        }
        Summary {
            generated_ms: now_ms,
            roots_found,
            files: found.len(),
            periods: periods.into_iter().map(PeriodAcc::finish).collect(),
            unpriced_models: unpriced.into_iter().collect(),
            price_source: PRICE_SOURCE,
            price_date: PRICE_DATE,
        }
    }
}

/// 一則訊息的估算成本（美元）與是否查得到價目
fn cost_of(r: &Rec) -> (f64, bool) {
    let prompt = r.input + r.write_5m + r.write_1h + r.read;
    let Some(pr) = price_for(&r.model, prompt) else { return (0.0, false) };
    let c = r.input as f64 * pr.input + r.write_5m as f64 * pr.write_5m + r.write_1h as f64 * pr.write_1h + r.read as f64 * pr.read + r.output as f64 * pr.output;
    (c / 1_000_000.0, true)
}

// ---------- 輸出結構 ----------
#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
    pub messages: u64,
    /// 只加總查得到價目的訊息
    pub cost_usd: f64,
}
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelRow {
    pub model: String,
    pub priced: bool,
    #[serde(flatten)]
    pub totals: Totals,
}
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Period {
    pub key: &'static str,
    pub label: &'static str,
    #[serde(flatten)]
    pub totals: Totals,
    pub models: Vec<ModelRow>,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub generated_ms: i64,
    pub roots_found: bool,
    pub files: usize,
    pub periods: Vec<Period>,
    pub unpriced_models: Vec<String>,
    pub price_source: &'static str,
    pub price_date: &'static str,
}

struct PeriodAcc {
    key: &'static str,
    label: &'static str,
    totals: Totals,
    models: HashMap<Arc<str>, (Totals, bool)>,
}
impl PeriodAcc {
    fn new(key: &'static str, label: &'static str) -> Self {
        PeriodAcc { key, label, totals: Totals::default(), models: HashMap::new() }
    }
    fn add(&mut self, r: &Rec, cost: f64, priced: bool) {
        let e = self.models.entry(r.model.clone()).or_insert((Totals::default(), priced));
        for t in [&mut self.totals, &mut e.0] {
            t.input += r.input;
            t.output += r.output;
            t.cache_write += r.write_5m + r.write_1h;
            t.cache_read += r.read;
            t.messages += 1;
            t.cost_usd += cost;
        }
    }
    fn finish(self) -> Period {
        let mut models: Vec<ModelRow> = self.models.into_iter().map(|(m, (totals, priced))| ModelRow { model: m.to_string(), priced, totals }).collect();
        // 成本高的在前；沒價目的（成本 0）依總 token 排
        let tok = |t: &Totals| t.input + t.output + t.cache_write + t.cache_read;
        models.sort_by(|a, b| b.totals.cost_usd.partial_cmp(&a.totals.cost_usd).unwrap_or(std::cmp::Ordering::Equal).then(tok(&b.totals).cmp(&tok(&a.totals))).then(a.model.cmp(&b.model)));
        Period { key: self.key, label: self.label, totals: self.totals, models }
    }
}

// ---------- Tauri 指令 ----------
static SCANNER: Mutex<Option<Scanner>> = Mutex::new(None);

/// 真實的 Claude 設定資料夾：`CLAUDE_CONFIG_DIR`（可用逗號列多個）；沒設就 `<家目錄>\.claude` 與 `<家目錄>\.config\claude`
fn real_roots() -> Vec<PathBuf> {
    if let Some(v) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        let v = v.to_string_lossy().into_owned();
        let l: Vec<PathBuf> = v.split(',').map(str::trim).filter(|s| !s.is_empty()).map(PathBuf::from).collect();
        if !l.is_empty() {
            return l;
        }
    }
    let home = crate::claude_accounts::claude_home();
    vec![home.join(".claude"), home.join(".config").join("claude")]
}

#[tauri::command]
pub async fn usage_summary(tz_offset_min: i32) -> Result<Summary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let mut g = SCANNER.lock().unwrap_or_else(|e| e.into_inner());
        Ok(g.get_or_insert_with(Scanner::default).summarize(&real_roots(), now_ms, tz_offset_min))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn line(ts: &str, id: &str, model: &str, i: u64, o: u64, cw: u64, cr: u64) -> String {
        format!(r#"{{"type":"assistant","timestamp":"{ts}","requestId":"req_{id}","message":{{"id":"msg_{id}","model":"{model}","content":[{{"type":"text","text":"x"}}],"usage":{{"input_tokens":{i},"output_tokens":{o},"cache_creation_input_tokens":{cw},"cache_read_input_tokens":{cr}}}}}}}"#)
    }
    fn write(root: &Path, rel: &str, lines: &[String]) -> PathBuf {
        let p = root.join("projects").join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let mut f = std::fs::File::create(&p).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        p
    }
    // 2026-10-22 12:00:00 UTC
    const NOW: &str = "2026-10-22T12:00:00.000Z";
    fn now() -> i64 {
        parse_ts_ms(NOW).unwrap()
    }
    fn period<'a>(s: &'a Summary, k: &str) -> &'a Period {
        s.periods.iter().find(|p| p.key == k).unwrap()
    }

    #[test]
    fn 時間解析與日曆互轉() {
        assert_eq!(parse_ts_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_ts_ms("1970-01-02T00:00:00.500Z"), Some(86_400_500));
        assert_eq!(parse_ts_ms("1970-01-01T08:00:00+08:00"), Some(0));
        assert_eq!(parse_ts_ms("2026-10-22T12:00:00Z"), Some(1_792_670_400_000));
        assert_eq!(parse_ts_ms("壞的"), None);
        assert_eq!(parse_ts_ms("2026-13-01T00:00:00Z"), None);
        for d in [-800, 0, 59, 11000, 20748] {
            let (y, m, dd) = civil_from_days(d);
            assert_eq!(days_from_civil(y, m, dd), d);
        }
        assert_eq!(civil_from_days(days_from_civil(2026, 10, 22)), (2026, 10, 22));
    }

    #[test]
    fn 模型名解析各種寫法() {
        assert_eq!(parse_model("claude-opus-4-5-20251101"), Some(("opus", 4, 5)));
        assert_eq!(parse_model("claude-opus-4.5"), Some(("opus", 4, 5)));
        assert_eq!(parse_model("claude-opus-4-20250514"), Some(("opus", 4, 0)));
        assert_eq!(parse_model("claude-3-5-haiku-20241022"), Some(("haiku", 3, 5)));
        assert_eq!(parse_model("claude-sonnet-5-5"), Some(("sonnet", 5, 5)));
        assert_eq!(parse_model("claude-opus-5"), Some(("opus", 5, 0)));
        assert_eq!(parse_model("us.anthropic.claude-sonnet-4-20250514-v1:0"), Some(("sonnet", 4, 0)));
        assert_eq!(parse_model("gpt-5"), None);
        assert_eq!(parse_model("claude-opus"), None);
    }

    #[test]
    fn 價目與成本計算() {
        // sonnet 4.5：input 3、write 3.75、read 0.3、output 15（每百萬）；各用 100 萬 token
        let r = Rec { key: 1, bucket: 0, model: Arc::from("claude-sonnet-4-5-20250929"), input: 1_000_000, output: 1_000_000, write_5m: 1_000_000, write_1h: 0, read: 1_000_000 };
        let (c, ok) = cost_of(&r);
        assert!(ok);
        assert!((c - (3.0 + 15.0 + 3.75 + 0.3)).abs() < 1e-9, "{c}");
        // 1 小時寫入 sonnet 4.5 ＝ 6
        let r1 = Rec { write_5m: 0, write_1h: 1_000_000, input: 0, output: 0, read: 0, ..r.clone() };
        assert!((cost_of(&r1).0 - 6.0).abs() < 1e-9);
        // Haiku 5.5 兩檔
        let short = Rec { model: Arc::from("claude-haiku-5-5"), input: 1000, output: 0, write_5m: 0, write_1h: 0, read: 0, ..r.clone() };
        let long = Rec { input: 200_000, ..short.clone() };
        assert!((cost_of(&short).0 - 1000.0 * 0.10 / 1e6).abs() < 1e-12);
        assert!((cost_of(&long).0 - 200_000.0 * 0.50 / 1e6).abs() < 1e-12);
        // 沒價目：不計成本、標沒價目
        let u = Rec { model: Arc::from("claude-opus-9-9"), ..r };
        assert_eq!(cost_of(&u), (0.0, false));
    }

    #[test]
    fn 依日依模型加總並去重() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        write(
            root,
            "proj-a/s1.jsonl",
            &[
                // 同一則訊息寫三行（串流），只該算 output 最大的那一行
                line("2026-10-22T01:00:00Z", "m1", "claude-sonnet-4-5", 10, 1, 100, 1000),
                line("2026-10-22T01:00:01Z", "m1", "claude-sonnet-4-5", 10, 50, 100, 1000),
                line("2026-10-22T01:00:02Z", "m1", "claude-sonnet-4-5", 10, 30, 100, 1000),
                line("2026-10-22T02:00:00Z", "m2", "claude-opus-4-5", 5, 5, 0, 0),
                // 不是 assistant、沒 usage、壞行、<synthetic>、全 0：都略過
                r#"{"type":"user","timestamp":"2026-10-22T02:00:00Z","message":{"content":"hi"}}"#.to_string(),
                "不是 json".to_string(),
                r#"{"type":"assistant","timestamp":"2026-10-22T02:00:00Z","message":{"id":"x","model":"<synthetic>","usage":{"input_tokens":9,"output_tokens":9}}}"#.to_string(),
                line("2026-10-22T03:00:00Z", "m0", "claude-opus-4-5", 0, 0, 0, 0),
                // 本週但不是今天
                line("2026-10-18T03:00:00Z", "m3", "claude-sonnet-4-5", 100, 100, 0, 0),
                // 本月但超過 7 天
                line("2026-10-02T03:00:00Z", "m4", "claude-sonnet-4-5", 1000, 0, 0, 0),
                // 上個月：不算
                line("2026-09-30T03:00:00Z", "m5", "claude-sonnet-4-5", 7, 7, 0, 0),
            ],
        );
        // 續接的對話複製了 m2：跨檔去重
        write(root, "proj-b/sub/agent.jsonl", &[line("2026-10-22T02:00:00Z", "m2", "claude-opus-4-5", 5, 5, 0, 0)]);
        let mut sc = Scanner::default();
        let s = sc.summarize(&[root.to_path_buf()], now(), 0);
        assert!(s.roots_found);
        let today = period(&s, "today");
        assert_eq!(today.totals.messages, 2);
        assert_eq!((today.totals.input, today.totals.output, today.totals.cache_write, today.totals.cache_read), (15, 55, 100, 1000));
        let sonnet = today.models.iter().find(|m| m.model == "claude-sonnet-4-5").unwrap();
        // 10*3 + 50*15 + 100*3.75 + 1000*0.3 = 30+750+375+300 = 1455 (微美元)
        assert!((sonnet.totals.cost_usd - 1455.0 / 1e6).abs() < 1e-12, "{}", sonnet.totals.cost_usd);
        assert_eq!(period(&s, "week").totals.messages, 3);
        assert_eq!(period(&s, "month").totals.messages, 4);
        assert_eq!(period(&s, "month").totals.input, 15 + 100 + 1000);
        assert!(s.unpriced_models.is_empty());
        assert_eq!(s.files, 2);
    }

    #[test]
    fn 本機時區決定哪天() {
        let t = tempfile::tempdir().unwrap();
        // UTC 10-21 20:00 在台灣（UTC+8，getTimezoneOffset＝-480）已經是 10-22 04:00 ＝ 今天
        write(t.path(), "p/a.jsonl", &[line("2026-10-21T20:00:00Z", "a", "claude-opus-4-5", 1, 1, 0, 0)]);
        let mut sc = Scanner::default();
        assert_eq!(period(&sc.summarize(&[t.path().to_path_buf()], now(), -480), "today").totals.messages, 1);
        assert_eq!(period(&sc.summarize(&[t.path().to_path_buf()], now(), 0), "today").totals.messages, 0);
    }

    #[test]
    fn 近五小時是滾動視窗() {
        let t = tempfile::tempdir().unwrap();
        write(t.path(), "p/a.jsonl", &[line("2026-10-22T09:00:00Z", "a", "claude-opus-4-5", 1, 1, 0, 0), line("2026-10-22T05:00:00Z", "b", "claude-opus-4-5", 1, 1, 0, 0)]);
        let s = Scanner::default().summarize(&[t.path().to_path_buf()], now(), 0);
        assert_eq!(period(&s, "hours5").totals.messages, 1);
        assert_eq!(period(&s, "today").totals.messages, 2);
    }

    #[test]
    fn 沒價目的模型列出來且不計成本() {
        let t = tempfile::tempdir().unwrap();
        write(t.path(), "p/a.jsonl", &[line("2026-10-22T09:00:00Z", "a", "claude-opus-9-9", 1000, 1000, 0, 0)]);
        let s = Scanner::default().summarize(&[t.path().to_path_buf()], now(), 0);
        assert_eq!(s.unpriced_models, vec!["claude-opus-9-9".to_string()]);
        let p = period(&s, "today");
        assert_eq!(p.totals.cost_usd, 0.0);
        assert_eq!(p.totals.output, 1000);
        assert!(!p.models[0].priced);
    }

    #[test]
    fn 增量讀取與快取() {
        let t = tempfile::tempdir().unwrap();
        let p = write(t.path(), "p/a.jsonl", &[line("2026-10-22T09:00:00Z", "a", "claude-opus-4-5", 1, 1, 0, 0)]);
        let mut sc = Scanner::default();
        let roots = [t.path().to_path_buf()];
        assert_eq!(period(&sc.summarize(&roots, now(), 0), "today").totals.messages, 1);
        let off1 = sc.files.get(&p).unwrap().offset;
        // 沒變：快取原樣
        assert_eq!(period(&sc.summarize(&roots, now(), 0), "today").totals.messages, 1);
        assert_eq!(sc.files.get(&p).unwrap().offset, off1);
        // 附加一行完整的＋一行寫到一半（沒換行）：只算完整的；之後補完才算
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        writeln!(f, "{}", line("2026-10-22T10:00:00Z", "b", "claude-opus-4-5", 1, 1, 0, 0)).unwrap();
        let half = line("2026-10-22T11:00:00Z", "c", "claude-opus-4-5", 1, 1, 0, 0);
        write!(f, "{}", &half[..40]).unwrap();
        drop(f);
        assert_eq!(period(&sc.summarize(&roots, now(), 0), "today").totals.messages, 2);
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        writeln!(f, "{}", &half[40..]).unwrap();
        drop(f);
        assert_eq!(period(&sc.summarize(&roots, now(), 0), "today").totals.messages, 3);
        // 檔案被換成更短的內容：重讀
        std::fs::write(&p, format!("{}\n", line("2026-10-22T09:00:00Z", "z", "claude-opus-4-5", 1, 1, 0, 0))).unwrap();
        assert_eq!(period(&sc.summarize(&roots, now(), 0), "today").totals.messages, 1);
    }

    #[test]
    fn 太舊的檔案不讀也不留快取() {
        let t = tempfile::tempdir().unwrap();
        let p = write(t.path(), "p/old.jsonl", &[line("2026-01-01T00:00:00Z", "o", "claude-opus-4-5", 1, 1, 0, 0)]);
        // 把檔案修改時間設成很久以前
        let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        std::fs::File::options().write(true).open(&p).unwrap().set_modified(old).unwrap();
        let mut sc = Scanner::default();
        let s = sc.summarize(&[t.path().to_path_buf()], now(), 0);
        assert_eq!(s.files, 0);
        assert!(sc.files.is_empty());
    }

    #[test]
    fn 資料夾不存在不丟錯() {
        let s = Scanner::default().summarize(&[PathBuf::from("Z:/不存在的資料夾")], now(), 0);
        assert!(!s.roots_found);
        assert_eq!(period(&s, "month").totals.messages, 0);
    }

    #[test]
    fn 輸出欄位名稱固定() {
        let s = Scanner::default().summarize(&[], now(), 0);
        let v = serde_json::to_value(&s).unwrap();
        assert!(v["periods"][0]["costUsd"].is_number());
        assert!(v["periods"][0]["cacheRead"].is_number());
        assert!(v["priceDate"].is_string());
    }
}
