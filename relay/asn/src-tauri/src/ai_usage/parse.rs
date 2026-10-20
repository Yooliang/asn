//! 各服務用量回應的純解析（可單元測試，不打外部網路）。

use super::types::{AuthState, ProviderUsage, UsageWindow};
use serde_json::Value;

pub fn claude_from_usage_json(body: &str) -> Result<Vec<UsageWindow>, String> {
    let v: Value = serde_json::from_str(body).map_err(|_| "回應格式無法解析".to_string())?;
    let mut out = Vec::new();
    if let Some(w) = v.get("five_hour") {
        out.push(window_from_obj("五小時", w));
    }
    if let Some(w) = v.get("seven_day") {
        out.push(window_from_obj("一週", w));
    }
    if let Some(w) = v.get("seven_day_opus") {
        out.push(window_from_obj("一週（Opus）", w));
    }
    if let Some(extra) = v.get("extra_usage").and_then(Value::as_object) {
        if extra.get("is_enabled").and_then(Value::as_bool) == Some(true) {
            let used = extra.get("used_credits").and_then(Value::as_u64).unwrap_or(0);
            let limit = extra.get("monthly_limit").and_then(Value::as_u64).unwrap_or(0);
            let cur = extra.get("currency").and_then(Value::as_str).unwrap_or("USD");
            let detail = if limit == 0 {
                format!("額外用量已用 {used}（{cur}，無上限）")
            } else {
                format!("額外用量已用 {used}／{limit}（{cur}）")
            };
            out.push(UsageWindow {
                label: "額外用量".into(),
                used_percent: None,
                remaining_percent: None,
                reset_at: None,
                detail: Some(detail),
            });
        }
    }
    if out.is_empty() {
        return Err("回應裡沒有額度欄位".into());
    }
    Ok(out)
}

fn window_from_obj(label: &str, w: &Value) -> UsageWindow {
    let util = w.get("utilization").and_then(|x| x.as_f64().or_else(|| x.as_u64().map(|n| n as f64)));
    UsageWindow {
        label: label.to_string(),
        used_percent: util,
        remaining_percent: util.map(|u| (100.0 - u).max(0.0)),
        reset_at: w.get("resets_at").and_then(Value::as_str).map(String::from),
        detail: None,
    }
}

pub fn codex_from_usage_json(body: &str) -> Result<(Option<String>, Vec<UsageWindow>), String> {
    let v: Value = serde_json::from_str(body).map_err(|_| "回應格式無法解析".to_string())?;
    let plan = v.get("plan_type").and_then(Value::as_str).map(String::from);
    let mut out = Vec::new();
    if let Some(rl) = v.get("rate_limit") {
        if let Some(p) = rl.get("primary_window") {
            out.push(codex_window("主要視窗", p));
        }
        if let Some(s) = rl.get("secondary_window") {
            out.push(codex_window("次要視窗", s));
        }
    }
    if let Some(c) = v.get("credits") {
        if c.get("has_credits").and_then(Value::as_bool) == Some(true) {
            let bal = c.get("balance").and_then(|x| x.as_f64());
            out.push(UsageWindow {
                label: "點數餘額".into(),
                used_percent: None,
                remaining_percent: None,
                reset_at: None,
                detail: bal.map(|b| format!("{b:.2}")),
            });
        }
    }
    if out.is_empty() {
        return Err("回應裡沒有額度欄位".into());
    }
    Ok((plan, out))
}

fn codex_window(label: &str, w: &Value) -> UsageWindow {
    let used = w.get("used_percent").and_then(|x| x.as_f64().or_else(|| x.as_u64().map(|n| n as f64)));
    let reset = w
        .get("reset_at")
        .and_then(|x| x.as_i64().or_else(|| x.as_u64().map(|n| n as i64)))
        .and_then(epoch_rfc3339);
    let secs = w.get("limit_window_seconds").and_then(Value::as_u64);
    let lbl = if let Some(s) = secs {
        format!("{label}（約 {} 小時）", (s + 1800) / 3600)
    } else {
        label.to_string()
    };
    UsageWindow {
        label: lbl,
        used_percent: used,
        remaining_percent: used.map(|u| (100.0 - u).max(0.0)),
        reset_at: reset,
        detail: None,
    }
}

fn epoch_rfc3339(secs: i64) -> Option<String> {
    if secs <= 0 {
        return None;
    }
    Some(format!("{secs}"))
}

pub fn grok_from_billing_json(body: &str) -> Result<(Vec<UsageWindow>, Option<String>), String> {
    let v: Value = serde_json::from_str(body).map_err(|_| "回應格式無法解析".to_string())?;
    let cfg = v.get("config").ok_or_else(|| "回應裡沒有 config".to_string())?;
    let used = cfg.pointer("/used/val").and_then(|x| x.as_f64().or_else(|| x.as_u64().map(|n| n as f64)));
    let limit = cfg.pointer("/monthlyLimit/val").and_then(|x| x.as_f64().or_else(|| x.as_u64().map(|n| n as f64)));
    let pct = cfg.get("creditUsagePercent").and_then(as_f64);
    let used_pct = pct.or_else(|| match (used, limit) {
        (Some(u), Some(l)) if l > 0.0 => Some((u / l) * 100.0),
        _ => None,
    });
    let reset = cfg
        .get("billingPeriodEnd")
        .and_then(Value::as_str)
        .map(String::from);
    let cap = cfg.pointer("/onDemandCap/val").and_then(|x| x.as_u64());
    let mut note = None;
    if let Some(c) = cap {
        note = Some(if c == 0 {
            "隨用隨付：關閉".into()
        } else {
            format!("隨用隨付上限：{c}")
        });
    }
    let w = UsageWindow {
        label: "訂閱額度".into(),
        used_percent: used_pct,
        remaining_percent: used_pct.map(|u| (100.0 - u).max(0.0)),
        reset_at: reset,
        detail: match (used, limit) {
            (Some(u), Some(l)) => Some(format!("已用 {u:.0}／{l:.0}")),
            _ => None,
        },
    };
    Ok((vec![w], note))
}

fn as_f64(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_u64().map(|n| n as f64))
}

pub fn gemini_from_buckets(buckets: &[Value]) -> Vec<UsageWindow> {
    let mut out = Vec::new();
    for b in buckets.iter().take(6) {
        let model = b.get("modelId").or_else(|| b.get("tokenType")).and_then(Value::as_str).unwrap_or("配額");
        let frac = b.get("remainingFraction").and_then(as_f64);
        let used = frac.map(|f| ((1.0 - f).max(0.0).min(1.0)) * 100.0);
        out.push(UsageWindow {
            label: model.to_string(),
            used_percent: used,
            remaining_percent: frac.map(|f| (f * 100.0).max(0.0).min(100.0)),
            reset_at: b.get("resetTime").and_then(Value::as_str).map(String::from),
            detail: b.get("remainingAmount").and_then(Value::as_str).map(|s| format!("剩餘 {s}")),
        });
    }
    out
}

pub fn stub_provider(id: &str, label: &str, auth: AuthState, note: Option<&str>, install_available: bool, binary_found: bool) -> ProviderUsage {
    ProviderUsage {
        id: id.into(),
        label: label.into(),
        auth,
        plan: None,
        windows: vec![],
        note: note.map(String::from),
        install_available,
        binary_found,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析_claude_用量() {
        let body = r#"{"five_hour":{"utilization":25,"resets_at":"2026-10-21T00:00:00Z"},"seven_day":{"utilization":40,"resets_at":"2026-10-28T00:00:00Z"}}"#;
        let w = claude_from_usage_json(body).unwrap();
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].label, "五小時");
        assert_eq!(w[0].used_percent, Some(25.0));
    }

    #[test]
    fn 解析_codex_用量() {
        let body = r#"{"plan_type":"pro","rate_limit":{"primary_window":{"used_percent":12,"reset_at":1735401600,"limit_window_seconds":18000}}}"#;
        let (plan, w) = codex_from_usage_json(body).unwrap();
        assert_eq!(plan.as_deref(), Some("pro"));
        assert_eq!(w[0].used_percent, Some(12.0));
    }

    #[test]
    fn 解析_grok_用量() {
        let body = r#"{"config":{"used":{"val":30},"monthlyLimit":{"val":100},"billingPeriodEnd":"2026-11-01T00:00:00Z","onDemandCap":{"val":0}}}"#;
        let (w, _) = grok_from_billing_json(body).unwrap();
        assert_eq!(w[0].used_percent, Some(30.0));
    }
}
