use super::profiles::{bootstrap_config, LaunchMode, Profile};
use crate::identity::relay_home;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

const HOUR_MS: u64 = 3_600_000;

pub fn launcher_config_path() -> PathBuf {
    std::env::var_os("IRORI_LAUNCHER_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| relay_home().join("launcher.json"))
}

pub fn valid_partner_name(name: &str) -> bool {
    if name.is_empty() || name.chars().count() > 40 {
        return false;
    }
    let mut chars = name.chars();
    let first = chars.next().unwrap();
    if first == '-' || first.is_control() {
        return false;
    }
    if !(first.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&first)) {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || ('\u{4e00}'..='\u{9fff}').contains(&c))
}

pub fn canonical_launch_cwd(p: &str) -> Result<PathBuf, String> {
    let resolved = PathBuf::from(p);
    let resolved = if resolved.is_absolute() {
        resolved
    } else {
        std::env::current_dir().map_err(|e| e.to_string())?.join(resolved)
    };
    match std::fs::canonicalize(&resolved) {
        Ok(p) => Ok(p),
        Err(_) => Ok(resolved),
    }
}

#[derive(Clone)]
pub struct LaunchConfig {
    pub profiles: HashMap<String, Profile>,
    pub cwd_allow: Vec<PathBuf>,
    pub max_per_hour: u32,
}

pub fn load_launch_config() -> Result<LaunchConfig, String> {
    let path = launcher_config_path();
    let bootstrap = bootstrap_config();
    let file_text = std::fs::read_to_string(&path).ok();
    let j: Value = file_text
        .as_ref()
        .map(|t| serde_json::from_str(t).map_err(|e| format!("launcher.json 不是合法 JSON：{e}")))
        .transpose()?
        .unwrap_or(Value::Null);

    if !j.is_null() && (!j.get("profiles").map(|p| p.is_object()).unwrap_or(false)) {
        return Err("launcher.json 缺 profiles".into());
    }

    let mut merged: HashMap<String, Profile> = HashMap::new();
    if let Some((boot_profiles, _, _)) = &bootstrap {
        merged.extend(boot_profiles.clone());
    }
    if let Some(obj) = j.get("profiles").and_then(Value::as_object) {
        for (id, p) in obj {
            if let Some(prof) = parse_one_profile(id, p)? {
                merged.insert(id.clone(), prof);
            }
        }
    }

    if merged.is_empty() {
        return Err(
            file_text
                .map(|_| "launcher.json 沒有任何 profile".to_string())
                .unwrap_or_else(|| "這台電腦還沒有可用的啟動設定（請安裝 CLI 或撰寫 launcher.json）".into()),
        );
    }

    let cwd_allow: Vec<PathBuf> = j
        .get("cwd_allow")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .filter_map(|s| canonical_launch_cwd(s.trim()).ok())
                .collect()
        })
        .or_else(|| bootstrap.as_ref().map(|(_, c, _)| c.clone()))
        .unwrap_or_default();

    if cwd_allow.is_empty() {
        return Err("工作資料夾白名單 cwd_allow 是空的".into());
    }

    let max_per_hour = j
        .get("max_per_hour")
        .and_then(Value::as_u64)
        .map(|n| n.clamp(1, 20) as u32)
        .or_else(|| bootstrap.as_ref().map(|(_, _, m)| *m))
        .unwrap_or(6);

    Ok(LaunchConfig {
        profiles: merged,
        cwd_allow,
        max_per_hour,
    })
}

fn parse_one_profile(id: &str, p: &Value) -> Result<Option<Profile>, String> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') || id.is_empty() || id.len() > 40 {
        return Err(format!("profile 名不合法：{id}"));
    }
    let mode = if p.get("mode").and_then(Value::as_str) == Some("background") {
        LaunchMode::Background
    } else {
        LaunchMode::Window
    };
    if p.get("disabled").and_then(Value::as_bool) == Some(true) {
        return Ok(Some(Profile {
            label: p.get("label").and_then(Value::as_str).unwrap_or(id).chars().take(60).collect(),
            command: String::new(),
            args: vec![],
            engine: p.get("engine").and_then(Value::as_str).unwrap_or("").into(),
            mode,
            disabled: true,
            disabled_reason: p.get("disabledReason").and_then(Value::as_str).unwrap_or("").into(),
        }));
    }
    let command = p.get("command").and_then(Value::as_str).ok_or_else(|| format!("profile {id} 要有 command"))?;
    if command.is_empty() {
        return Err(format!("profile {id} 要有 command"));
    }
    let args: Vec<String> = p
        .get("args")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if mode == LaunchMode::Window && args.is_empty() && !p.get("args").is_some() {
        return Err(format!("profile {id} 要有 args"));
    }
    Ok(Some(Profile {
        label: p.get("label").and_then(Value::as_str).unwrap_or(id).chars().take(60).collect(),
        command: command.into(),
        args,
        engine: p.get("engine").and_then(Value::as_str).unwrap_or("").into(),
        mode,
        disabled: false,
        disabled_reason: String::new(),
    }))
}

pub struct LaunchReq<'a> {
    pub profile: &'a str,
    pub name: &'a str,
    pub cwd: String,
}

pub fn check_launch(config: &LaunchConfig, req: &mut LaunchReq<'_>, recent: &[u64], now_ms: u64) -> Result<(), String> {
    if !valid_partner_name(req.name) {
        return Err("視窗名格式不對".into());
    }
    let prof = config.profiles.get(req.profile).ok_or_else(|| format!("沒有這個啟動設定：{}", req.profile))?;
    if prof.disabled {
        return Err(if prof.disabled_reason.is_empty() {
            "這個模型目前無法從這裡啟動".into()
        } else {
            prof.disabled_reason.clone()
        });
    }
    if req.cwd.trim().is_empty() {
        return Err("工作資料夾不在允許清單裡".into());
    }
    let cwd_canon = canonical_launch_cwd(&req.cwd)?;
    let allow: HashSet<PathBuf> = config.cwd_allow.iter().cloned().collect();
    if !allow.contains(&cwd_canon) {
        return Err("工作資料夾不在允許清單裡".into());
    }
    if !cwd_canon.is_dir() {
        return Err(format!("工作資料夾不存在：{}", req.cwd));
    }
    req.cwd = cwd_canon.to_string_lossy().into_owned();
    let hour_ago = now_ms.saturating_sub(HOUR_MS);
    let count = recent.iter().filter(|t| **t > hour_ago).count();
    if count >= config.max_per_hour as usize {
        return Err(format!("這個小時已經開了 {} 個視窗，超過上限", config.max_per_hour));
    }
    Ok(())
}

pub fn expand_vars(s: &str, env: &std::collections::HashMap<String, String>) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        rest = &rest[i + 1..];
        if let Some(j) = rest.find('%') {
            let key = &rest[..j];
            rest = &rest[j + 1..];
            let hit = env.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_str());
            out.push_str(hit.unwrap_or(&format!("%{key}%")));
        } else {
            out.push('%');
            break;
        }
    }
    out.push_str(rest);
    out
}

pub fn child_env() -> std::collections::HashMap<String, String> {
    std::env::vars()
        .filter(|(k, _)| {
            let u = k.to_ascii_uppercase();
            !(u.starts_with("CLAUDE") || u == "NO_COLOR" || k == "IRORI_RELAY_KEY" || k == "IRORI_RELAY_ANON_KEY")
        })
        .collect()
}

pub fn build_spawn_spec(config: &LaunchConfig, req: &LaunchReq<'_>) -> Result<(String, Vec<String>, PathBuf), String> {
    let p = config.profiles.get(req.profile).ok_or_else(|| "沒有這個啟動設定".to_string())?;
    let env = child_env();
    let command = expand_vars(&p.command, &env);
    let args: Vec<String> = p
        .args
        .iter()
        .map(|a| a.replace("{name}", req.name))
        .collect();
    Ok((command, args, PathBuf::from(&req.cwd)))
}
