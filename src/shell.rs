//! A worker thread for calls that wait on Explorer or shell extensions (AppBar messages, icons,
//! thumbnails, the Recycle Bin). The UI thread never makes these calls: if one hangs, the caller
//! gets None after the timeout and the next call starts a fresh worker.
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

type Job = Box<dyn FnOnce() + Send>;
static WORKER: Mutex<Option<Sender<Job>>> = Mutex::new(None);

fn spawn() -> Sender<Job> {
    let (tx, rx) = channel::<Job>();
    std::thread::spawn(move || {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok().ok() };
        for job in rx {
            job();
        }
    });
    tx
}

pub fn run<T: Send + 'static>(secs: u64, f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = channel();
    let job: Job = Box::new(move || {
        let _ = tx.send(f());
    });
    {
        let mut w = WORKER.lock().unwrap();
        let s = w.get_or_insert_with(spawn);
        if let Err(e) = s.send(job) {
            *s = spawn();
            let _ = s.send(e.0);
        }
    }
    match rx.recv_timeout(Duration::from_secs(secs)) {
        Ok(v) => Some(v),
        Err(_) => {
            *WORKER.lock().unwrap() = None; // abandon the stuck thread
            None
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn times_out_and_recovers() {
        assert_eq!(super::run(2, || 7), Some(7));
        assert_eq!(super::run(1, || std::thread::sleep(std::time::Duration::from_secs(3))), None);
        assert_eq!(super::run(2, || 8), Some(8)); // a fresh worker took over
    }
}
