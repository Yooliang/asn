//! 時間換算：西曆日期 ↔ 自 1970-01-01 起的天數、ISO 8601 → 毫秒。純函式、不依賴視窗版（gui）或電腦版（desktop），
//! 無畫面版的收發室（bridge）與視窗版的用量統計共用同一份。

/// 西曆日期 → 自 1970-01-01 起的天數
pub(crate) fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}
/// 自 1970-01-01 起的天數 → (年, 月, 日)
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
pub(crate) fn civil_from_days(z: i64) -> (i64, i64, i64) {
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
pub(crate) fn parse_ts_ms(s: &str) -> Option<i64> {
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
