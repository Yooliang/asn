//! 非同步執行環境的薄薄一層：核心（bridge／engines／relay）一律用這裡的 `spawn`／`block_on`／`JoinHandle`，
//! 不直接碰 tauri。有視窗版（gui）轉呼叫 `tauri::async_runtime`（行為與以前完全相同）；
//! 無視窗版用自己的 tokio 多執行緒執行環境（第一次用到時才建立，整個行程共用一個）。

#[cfg(feature = "gui")]
pub use tauri::async_runtime::{block_on, spawn, JoinHandle};

#[cfg(not(feature = "gui"))]
mod headless {
    use std::future::Future;
    use std::sync::OnceLock;

    pub use tokio::task::JoinHandle;

    fn runtime() -> &'static tokio::runtime::Runtime {
        static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
        RT.get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_name("asn-rt")
                .build()
                .expect("無法建立非同步執行環境")
        })
    }

    pub fn spawn<F>(fut: F) -> JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        runtime().spawn(fut)
    }

    pub fn block_on<F: Future>(fut: F) -> F::Output {
        runtime().block_on(fut)
    }
}

#[cfg(not(feature = "gui"))]
pub use headless::{block_on, spawn, JoinHandle};
