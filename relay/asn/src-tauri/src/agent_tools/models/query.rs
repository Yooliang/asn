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

/// 命令本體：只負責把真的 `probe`／`snapshot` 交給 `query_with`
pub async fn query(vendor: Option<&str>, force: bool) -> Result<Value, String> {
    query_with(vendor, force, probe, snapshot).await
}

/// 命令的實際流程，兩個取資料的函式由呼叫端傳入（測試用假的，才測得到下面三件事）。
/// 不帶 `force`：只讀快取、不等（`snapshot_fn`，與摘要同一套）；
/// 帶 `force`：略過快取真的重讀（`probe_fn(v, true)`，各家同時讀，見 `read_all`）。
/// 兩條路最後都要套每家筆數上限（`cap_local`）。
pub async fn query_with<P, Fut, S>(vendor: Option<&str>, force: bool, probe_fn: P, snapshot_fn: S) -> Result<Value, String>
where
    P: Fn(Vendor, bool) -> Fut,
    Fut: std::future::Future<Output = VendorModels> + Send + 'static,
    S: Fn(Vendor) -> VendorModels,
{
    let vendors = pick_vendors(vendor)?;
    let list = if force {
        read_all(&vendors, |v| probe_fn(v, true)).await
    } else {
        vendors.iter().map(|v| snapshot_fn(*v)).collect()
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
    fn 重新讀取四家同時查_順序固定() {
        // 不看時間：四家都等同一個 Barrier(4)，四家同時在讀才過得了；依序讀第一家會永遠等不到其他三家，直到逾時
        let gate = std::sync::Arc::new(tokio::sync::Barrier::new(Vendor::ALL.len()));
        let got = crate::rt::block_on(async {
            tokio::time::timeout(
                std::time::Duration::from_secs(10),
                read_all(&Vendor::ALL, |v| {
                    let gate = gate.clone();
                    async move {
                        gate.wait().await;
                        many(v, 2)
                    }
                }),
            )
            .await
        })
        .expect("四家沒有同時在讀（依序讀會卡在第一家，逾時）");
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

    type Calls = std::sync::Arc<std::sync::Mutex<Vec<(Vendor, bool)>>>;

    /// 用假的 probe／snapshot 跑 `query_with`；回傳 (結果, probe 被呼叫的記錄(廠牌, force), snapshot 被呼叫的廠牌)
    fn run(vendor: Option<&str>, force: bool, n: usize) -> (Result<Value, String>, Vec<(Vendor, bool)>, Vec<Vendor>) {
        let probed: Calls = Default::default();
        let snapped: std::sync::Arc<std::sync::Mutex<Vec<Vendor>>> = Default::default();
        let (p, s) = (probed.clone(), snapped.clone());
        let r = crate::rt::block_on(query_with(
            vendor,
            force,
            move |v, f| {
                p.lock().unwrap().push((v, f));
                async move { many(v, n) }
            },
            move |v| {
                s.lock().unwrap().push(v);
                many(v, n)
            },
        ));
        let (a, b) = (probed.lock().unwrap().clone(), snapped.lock().unwrap().clone());
        (r, a, b)
    }

    #[test]
    fn 按重新讀取_每家都走真讀取且帶_force_不碰快取() {
        let (r, probed, snapped) = run(None, true, 2);
        assert!(r.is_ok());
        assert_eq!(probed.len(), Vendor::ALL.len(), "每家都讀一次");
        assert!(probed.iter().all(|(_, f)| *f), "按重新讀取＝probe(v, true)，不能是快取：{probed:?}");
        assert!(snapped.is_empty(), "force 時不該走快取快照：{snapped:?}");
    }

    #[test]
    fn 不帶_force_只讀快取_不啟動真讀取() {
        let (r, probed, snapped) = run(None, false, 2);
        assert!(r.is_ok());
        assert!(probed.is_empty(), "沒按重新讀取就不該讀：{probed:?}");
        assert_eq!(snapped, Vendor::ALL.to_vec(), "照固定順序各取一次快照");
    }

    #[test]
    fn 指定一家時只動那一家_兩條路都是() {
        let (_, probed, _) = run(Some("codex"), true, 1);
        assert_eq!(probed, vec![(Vendor::Codex, true)]);
        let (_, _, snapped) = run(Some("pi"), false, 1);
        assert_eq!(snapped, vec![Vendor::Pi]);
        assert_eq!(run(Some("nope"), true, 1).0.unwrap_err(), "不認得的廠牌");
    }

    #[test]
    fn 兩條路回應都套每家筆數上限() {
        for force in [true, false] {
            let (r, _, _) = run(None, force, 250);
            let v = r.unwrap();
            let arr = v["models"].as_array().unwrap();
            assert_eq!(arr.len(), Vendor::ALL.len());
            for item in arr {
                assert_eq!(item["models"].as_array().unwrap().len(), LOCAL_MAX_MODELS, "force={force}：每家只留 200 筆");
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
