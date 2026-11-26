//! 本機畫面直接讀型號清單的入口（#2355 P2）：Tauri 命令 `agent_models` 的核心。
//! 回應形狀與 launch 摘要裡的 `models` 每一家相同（`{vendor,status,code?,stale?,age_s?,models}`），外面包一層 `{ "models": [...] }`，
//! 好讓前端對「本機的回應」與「別台的 launcher」用同一個取法。`reason` 不序列化（`VendorModels` 的 `#[serde(skip)]`），原因原文只進 ui.log。
//! 回報上限（`limit_for_report` 的 24000 位元組總量）不套：那是給上雲的摘要省流量用的，本機畫面不需要；但每家筆數仍有上限（`LOCAL_MAX_MODELS`）。
use super::{probe, snapshot, Vendor, VendorModels, PI_REPORT_MAX_MODELS};
use serde_json::{json, Value};

/// 本機畫面每家最多給幾筆（與 pi 的回報上限、`pi_models` 的 200 筆一致）
pub const LOCAL_MAX_MODELS: usize = PI_REPORT_MAX_MODELS;

impl Vendor {
    /// 廠牌 id（`claude`／`codex`／`gemini`／`pi`）→ 廠牌；大小寫、空白都不放寬
    pub fn from_id(s: &str) -> Option<Vendor> {
        Vendor::ALL.iter().copied().find(|v| v.id() == s)
    }
}

/// 要查哪幾家：不帶＝全部；帶了就只那一家，不合法回白話錯誤
pub fn pick_vendors(vendor: Option<&str>) -> Result<Vec<Vendor>, String> {
    match vendor {
        None => Ok(Vendor::ALL.to_vec()),
        Some(s) => Vendor::from_id(s).map(|v| vec![v]).ok_or_else(|| "不認得的廠牌".to_string()),
    }
}

/// 每家最多 `LOCAL_MAX_MODELS` 筆（超過就從後面截掉，原因寫在不上傳的 reason）
pub fn cap_local(list: Vec<VendorModels>) -> Vec<VendorModels> {
    list.into_iter()
        .map(|mut v| {
            let total = v.models.len();
            if total > LOCAL_MAX_MODELS {
                v.models.truncate(LOCAL_MAX_MODELS);
                v.reason = format!("畫面只留前 {LOCAL_MAX_MODELS} 筆（共 {total} 筆）");
            }
            v
        })
        .collect()
}

/// 對外的 JSON：`{ "models": [...] }`
pub fn to_value(list: &[VendorModels]) -> Value {
    json!({ "models": serde_json::to_value(list).unwrap_or(Value::Null) })
}

/// 命令本體。不帶 `force`：只讀快取、不等（與摘要同一套 `snapshot`）；帶 `force`：略過快取真的重讀（`probe(v, true)`，一家一家讀）
pub async fn query(vendor: Option<&str>, force: bool) -> Result<Value, String> {
    let vendors = pick_vendors(vendor)?;
    let list = if force {
        read_all(&vendors, |v| probe(v, true)).await
    } else {
        vendors.iter().map(|v| snapshot(*v)).collect()
    };
    Ok(to_value(&cap_local(list)))
}

/// 各家「同時」讀（總時間約等於最慢那一家），回傳順序與 `vendors` 相同。
/// 同一家的單一飛行旗標在 `probe` 內，所以同一家仍不會同時跑兩個 CLI。
/// 每家各開一個背景工作，再照 `vendors` 的順序逐一等；某一家 panic 只讓那一家回 error，不拖垮整個命令
async fn read_all<F, Fut>(vendors: &[Vendor], fetch: F) -> Vec<VendorModels>
where
    F: Fn(Vendor) -> Fut,
    Fut: std::future::Future<Output = VendorModels> + Send + 'static,
{
    let handles: Vec<_> = vendors.iter().map(|v| crate::rt::spawn(fetch(*v))).collect();
    let mut out = Vec::with_capacity(handles.len());
    for (v, h) in vendors.iter().zip(handles) {
        out.push(match h.await {
            Ok(r) => r,
            Err(e) => VendorModels::error(*v, super::Code::SpawnFailed, format!("讀取工作中斷：{e}")),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::{Code, ModelEntry, Status};
    use super::*;

    fn many(v: Vendor, n: usize) -> VendorModels {
        VendorModels::from_list(v, (0..n).map(|i| ModelEntry { id: format!("m{i}"), name: format!("Model number {i} with a long display name") }).collect())
    }

    #[test]
    fn 重新讀取四家同時查_總時間接近單家_順序固定() {
        let delay = std::time::Duration::from_millis(300);
        let started = std::time::Instant::now();
        // 刻意讓排前面的家比較慢，確認回應順序不是照完成先後
        let got = crate::rt::block_on(read_all(&Vendor::ALL, |v| async move {
            let extra = (Vendor::ALL.len() - Vendor::ALL.iter().position(|x| *x == v).unwrap()) as u64;
            tokio::time::sleep(delay + std::time::Duration::from_millis(extra * 10)).await;
            many(v, 2)
        }));
        let took = started.elapsed();
        assert!(took < delay * 2, "四家應該同時查，實測 {took:?}（依序至少 {:?}）", delay * 4);
        let order: Vec<&str> = got.iter().map(|v| v.vendor.as_str()).collect();
        let want: Vec<&str> = Vendor::ALL.iter().map(|v| v.id()).collect();
        assert_eq!(order, want, "順序維持 Vendor 固定順序");
        assert!(got.iter().all(|v| v.models.len() == 2), "內容各家都在");
    }

    #[test]
    fn 某一家_panic_其他家照常回結果_那一家回_error() {
        let got = crate::rt::block_on(read_all(&Vendor::ALL, |v| async move {
            if v == Vendor::Codex {
                panic!("測試用：這一家讀到一半炸掉");
            }
            many(v, 2)
        }));
        assert_eq!(got.len(), Vendor::ALL.len());
        for (v, r) in Vendor::ALL.iter().zip(&got) {
            assert_eq!(r.vendor, v.id(), "順序不變");
            if *v == Vendor::Codex {
                assert_eq!((r.status, r.code), (Status::Error, Some(Code::SpawnFailed)));
                assert!(r.models.is_empty());
            } else {
                assert_eq!((r.status, r.models.len()), (Status::Ok, 2), "其他家照常");
            }
        }
    }

    #[test]
    fn 廠牌驗證_不帶是全部_帶了只一家_不合法回錯誤() {
        assert_eq!(pick_vendors(None).unwrap(), Vendor::ALL.to_vec());
        assert_eq!(pick_vendors(Some("gemini")).unwrap(), vec![Vendor::Gemini]);
        for bad in ["", "agy", "Claude", " pi", "pi ", "grok", "pi;rm", "../pi"] {
            assert_eq!(pick_vendors(Some(bad)).unwrap_err(), "不認得的廠牌", "{bad:?}");
        }
    }

    #[test]
    fn 每家筆數有上限_不受_24000_位元組總量限制() {
        let list = Vendor::ALL.iter().map(|v| many(*v, 250)).collect();
        let r = cap_local(list);
        assert!(r.iter().all(|v| v.models.len() == LOCAL_MAX_MODELS && v.status == Status::Ok), "每家都留到 200 筆");
        let json = serde_json::to_vec(&r).unwrap().len();
        assert!(json > super::super::REPORT_MAX_BYTES, "四家 200 筆會超過上雲的總量上限（{json}），本機不套那條");
        assert_eq!(cap_local(vec![many(Vendor::Codex, 3)])[0].models.len(), 3, "沒超過的不動");
    }

    #[test]
    fn 回應的_json_沒有_reason_也沒有原因原文() {
        let secret = r"C:\Users\someone\.pi\token=SECRET123";
        let all = vec![
            VendorModels::error(Vendor::Codex, Code::SpawnFailed, secret),
            VendorModels::unavailable(Vendor::Gemini, Code::NotInstalled, secret),
            VendorModels { stale: true, age_s: Some(9), reason: secret.into(), ..many(Vendor::Pi, 2) },
            many(Vendor::Claude, 300),
        ];
        let v = to_value(&cap_local(all));
        let text = serde_json::to_string(&v).unwrap();
        assert!(!text.contains("reason") && !text.contains("SECRET123") && !text.contains("someone"), "{text}");
        assert!(v["models"].is_array() && v["models"].as_array().unwrap().len() == 4);
        assert_eq!(v["models"][2]["stale"], true);
    }
}
