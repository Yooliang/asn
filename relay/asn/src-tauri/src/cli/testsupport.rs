//! 測試用的本機假後端（只連 127.0.0.1）：記下每個請求，依處理函式回應。
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
pub struct Req {
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}
impl Req {
    pub fn param(&self, k: &str) -> Option<String> {
        self.query.split('&').find_map(|kv| kv.split_once('=').filter(|(a, _)| *a == k).map(|(_, v)| decode(v)))
    }
    pub fn action(&self) -> String {
        self.param("action").unwrap_or_default()
    }
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 3 <= b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

pub struct Resp {
    pub status: u16,
    pub ctype: &'static str,
    pub body: Vec<u8>,
}
impl Resp {
    pub fn json(status: u16, v: Value) -> Resp {
        Resp { status, ctype: "application/json", body: v.to_string().into_bytes() }
    }
    pub fn ok(v: Value) -> Resp {
        Resp::json(200, v)
    }
    pub fn bytes(status: u16, b: Vec<u8>) -> Resp {
        Resp { status, ctype: "application/octet-stream", body: b }
    }
}

pub struct Fake {
    pub port: u16,
    pub reqs: Arc<Mutex<Vec<Req>>>,
}
impl Fake {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/relay", self.port)
    }
    pub fn start(handler: impl Fn(&Req, u16) -> Resp + Send + Sync + 'static) -> Fake {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let reqs: Arc<Mutex<Vec<Req>>> = Arc::new(Mutex::new(vec![]));
        let (r2, h) = (reqs.clone(), Arc::new(handler));
        std::thread::spawn(move || {
            for c in l.incoming() {
                let Ok(c) = c else { break };
                let (r3, h3) = (r2.clone(), h.clone());
                std::thread::spawn(move || serve(c, port, r3, h3));
            }
        });
        Fake { port, reqs }
    }
    /// 後端動作（action）的請求，依到達順序
    pub fn actions(&self) -> Vec<String> {
        self.reqs.lock().unwrap().iter().filter(|r| r.path.ends_with("/relay")).map(|r| r.action()).collect()
    }
    pub fn of(&self, action: &str) -> Vec<Req> {
        self.reqs.lock().unwrap().iter().filter(|r| r.path.ends_with("/relay") && r.action() == action).cloned().collect()
    }
    pub fn count(&self) -> usize {
        self.reqs.lock().unwrap().len()
    }
}

fn serve(mut c: TcpStream, port: u16, reqs: Arc<Mutex<Vec<Req>>>, h: Arc<impl Fn(&Req, u16) -> Resp>) {
    let mut buf: Vec<u8> = vec![];
    let mut tmp = [0u8; 8192];
    let head_end = loop {
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break p;
        }
        match c.read(&mut tmp) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or("");
    let mut p = first.split(' ');
    let (method, target) = (p.next().unwrap_or("").to_string(), p.next().unwrap_or("").to_string());
    let headers: HashMap<String, String> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string())).collect();
    let want: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < want {
        match c.read(&mut tmp) {
            Ok(0) | Err(_) => break,
            Ok(n) => body.extend_from_slice(&tmp[..n]),
        }
    }
    let (path, query) = target.split_once('?').map(|(a, b)| (a.to_string(), b.to_string())).unwrap_or((target.clone(), String::new()));
    let req = Req { method, path, query, headers, body };
    reqs.lock().unwrap().push(req.clone());
    let r = h(&req, port);
    let _ = write!(c, "HTTP/1.1 {} X\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", r.status, r.ctype, r.body.len());
    let _ = c.write_all(&r.body);
    let _ = c.flush();
}
