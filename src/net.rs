//! Outbound requests for account widgets, and the keys they use.
//! Keys are encrypted with DPAPI (only this Windows user can read them) and are never returned to the page:
//! the page writes `{{name}}` and the value is filled in here, just before the request goes out.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;
use std::mem::zeroed;
use std::path::PathBuf;
use std::ptr::{null, null_mut};
use std::sync::Mutex;
use std::time::Duration;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

/// Services a widget may talk to. A leading dot allows subdomains.
const HOSTS: &[&str] = &[
    "api.stripe.com", "api.polar.sh", "live.dodopayments.com", ".myshopify.com", "api.lemonsqueezy.com",
    "api.paddle.com", "api.gumroad.com", "plausible.io", "api.dub.co", "api.resend.com", "api.linear.app",
    "api.supabase.com", "api.github.com", "github.com", "leetcode.com", "api.deepseek.com",
    "query1.finance.yahoo.com", "query2.finance.yahoo.com", "www.googleapis.com", "www.bing.com",
    "api.coinbase.com", "api.frankfurter.dev",
];

fn dpapi(data: &[u8], protect: bool) -> Option<Vec<u8>> {
    unsafe {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out: CRYPT_INTEGER_BLOB = zeroed();
        let ok = if protect {
            CryptProtectData(&input, null(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        } else {
            CryptUnprotectData(&input, null_mut(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        if ok == 0 {
            return None;
        }
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as _);
        Some(v)
    }
}

pub struct Vault {
    path: PathBuf,
    keys: Mutex<BTreeMap<String, String>>,
}

impl Vault {
    pub fn load(path: PathBuf) -> Self {
        let keys = std::fs::read(&path)
            .ok()
            .and_then(|b| dpapi(&b, false))
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Vault { path, keys: Mutex::new(keys) }
    }

    /// An empty value removes the key.
    pub fn set(&self, name: &str, value: &str) -> Result<(), String> {
        let mut k = self.keys.lock().unwrap();
        if value.trim().is_empty() {
            k.remove(name);
        } else {
            k.insert(name.to_string(), value.trim().to_string());
        }
        let sealed = dpapi(&serde_json::to_vec(&*k).map_err(|e| e.to_string())?, true).ok_or("could not encrypt the key")?;
        std::fs::write(&self.path, sealed).map_err(|e| e.to_string())
    }

    pub fn names(&self) -> Vec<String> {
        self.keys.lock().unwrap().keys().cloned().collect()
    }

    fn fill(&self, s: &str) -> Result<String, String> {
        let keys = self.keys.lock().unwrap();
        let mut out = String::with_capacity(s.len());
        let mut rest = s;
        while let Some(i) = rest.find("{{") {
            let j = rest[i..].find("}}").ok_or("unclosed {{")? + i;
            let name = &rest[i + 2..j];
            out.push_str(&rest[..i]);
            out.push_str(keys.get(name).ok_or_else(|| format!("connect {name} first"))?);
            rest = &rest[j + 2..];
        }
        out.push_str(rest);
        Ok(out)
    }
}

fn allowed(url: &str) -> Result<(), String> {
    let host = url.strip_prefix("https://").ok_or("only https links")?.split(['/', '?', ':']).next().unwrap_or("");
    if HOSTS.iter().any(|h| host == *h || (h.starts_with('.') && host.ends_with(h))) {
        Ok(())
    } else {
        Err(format!("{host} is not one of leobar's services"))
    }
}

#[derive(Deserialize)]
pub struct Req {
    method: String,
    url: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    body: Option<String>,
}

#[derive(Serialize)]
pub struct Resp {
    status: u16,
    body: String,
}

fn request(vault: &Vault, r: &Req) -> Result<ureq::Response, String> {
    // Check the host before the key is filled in, so a key can never be sent to a host that is not allowed.
    allowed(&r.url)?;
    let url = vault.fill(&r.url)?;
    allowed(&url)?;
    let mut req = ureq::request(&r.method, &url)
        .timeout(Duration::from_secs(20))
        .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) leobar/0.1");
    for (k, v) in &r.headers {
        req = req.set(k, &vault.fill(v)?);
    }
    let res = match &r.body {
        Some(b) => req.send_string(&vault.fill(b)?),
        None => req.call(),
    };
    match res {
        Ok(resp) | Err(ureq::Error::Status(_, resp)) => Ok(resp),
        Err(e) => Err(e.kind().to_string()),
    }
}

pub fn send(vault: &Vault, r: Req) -> Result<Resp, String> {
    let resp = request(vault, &r)?;
    Ok(Resp { status: resp.status(), body: resp.into_string().map_err(|e| e.to_string())? })
}

/// The body of a GET (at most `limit` bytes) and its content type, from an allowed host.
pub fn fetch(vault: &Vault, url: &str, limit: u64) -> Result<(Vec<u8>, String), String> {
    let resp = request(vault, &Req { method: "GET".into(), url: url.into(), headers: vec![], body: None })?;
    if resp.status() != 200 {
        return Err(format!("download returned {}", resp.status()));
    }
    let mime = resp.content_type().to_string();
    let mut buf = Vec::new();
    resp.into_reader().take(limit).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok((buf, mime))
}

/// Downloads a file (up to 40 MB) to `dest`.
pub fn download(vault: &Vault, url: &str, dest: &PathBuf) -> Result<(), String> {
    let (buf, _) = fetch(vault, url, 40 << 20)?;
    std::fs::write(dest, buf).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_and_fill() {
        assert!(allowed("https://api.stripe.com/v1/balance").is_ok());
        assert!(allowed("https://shop.myshopify.com/admin").is_ok());
        assert!(allowed("https://evil.com/?x=api.stripe.com").is_err());
        assert!(allowed("http://api.stripe.com").is_err());
        let v = Vault { path: PathBuf::new(), keys: Mutex::new(BTreeMap::from([("stripe".into(), "rk_1".into())])) };
        assert_eq!(v.fill("Bearer {{stripe}}").unwrap(), "Bearer rk_1");
        assert!(v.fill("{{missing}}").is_err());
        assert_eq!(dpapi(&dpapi(b"secret", true).unwrap(), false).unwrap(), b"secret");
    }
}
