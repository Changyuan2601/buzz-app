//! Opt-in macOS USB display for the compute widget. The firmware handshake is
//! required before sending pixels; this owns no Mesh state or animation logic.
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(target_os = "macos")]
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct UsbDisplay {
    #[cfg(target_os = "macos")]
    session: Arc<Mutex<Option<std::fs::File>>>,
    #[cfg(target_os = "macos")]
    epoch: Arc<AtomicU64>,
}

impl UsbDisplay {
    pub fn disconnect(&self) {
        #[cfg(target_os = "macos")]
        {
            // Defer guaranteed, generation-aware cleanup if an operation owns
            // the lock, including cancellation after its final epoch check.
            self.disconnect_task();
        }
    }

    #[cfg(target_os = "macos")]
    fn disconnect_task(&self) -> tauri::async_runtime::JoinHandle<()> {
        let current = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        let epoch = self.epoch.clone();
        let session = self.session.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Ok(mut owned) = session.lock() {
                if epoch.load(Ordering::SeqCst) == current {
                    owned.take();
                }
            }
        })
    }
}

fn widget_only<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    if window.label() != "compute-widget" {
        return Err("USB display is only available to the compute widget".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn mesh_compute_widget_usb_connect<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    display: tauri::State<'_, UsbDisplay>,
) -> Result<String, String> {
    widget_only(&window)?;
    #[cfg(target_os = "macos")]
    {
        let session = display.session.clone();
        let epoch = display.epoch.clone();
        let current = epoch.fetch_add(1, Ordering::SeqCst) + 1;
        tauri::async_runtime::spawn_blocking(move || {
            let mut owned = session.lock().map_err(|_| "USB display unavailable")?;
            if current != epoch.load(Ordering::SeqCst) {
                return Err("USB connection cancelled".into());
            }
            owned.take();
            let ports: Vec<_> = std::fs::read_dir("/dev")
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .filter(|entry| port_name(&entry.file_name().to_string_lossy()))
                .map(|entry| entry.path())
                .collect();
            if ports.len() != 1 {
                return Err("Connect one ESP32 USB serial device, then try again".into());
            }
            let file = open(&ports[0]).map_err(|e| format!("USB display: {e}"))?;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            exchange(&file, b"BUZZ?\n", b"BUZZ128/1\n", deadline)
                .map_err(|_| "Install Buzz display firmware on the ESP32, then try again")?;
            if current != epoch.load(Ordering::SeqCst) {
                return Err("USB connection cancelled".into());
            }
            let name = ports[0].to_string_lossy().into_owned();
            *owned = Some(file);
            Ok(name)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = display;
        Err("USB compute display currently supports macOS".into())
    }
}

#[tauri::command]
pub async fn mesh_compute_widget_usb_frame<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    display: tauri::State<'_, UsbDisplay>,
    pixels: String,
) -> Result<(), String> {
    widget_only(&window)?;
    #[cfg(target_os = "macos")]
    {
        use base64::Engine;
        if pixels.len() != 43692 {
            return Err("Expected a 128×128 RGB565 frame".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(pixels)
            .map_err(|_| "Invalid USB frame encoding")?;
        if bytes.len() != 32768 {
            return Err("Expected a 128×128 RGB565 frame".into());
        }
        let session = display.session.clone();
        let epoch = display.epoch.clone();
        let current = epoch.load(Ordering::SeqCst);
        tauri::async_runtime::spawn_blocking(move || {
            let mut owned = session.try_lock().map_err(|_| "USB display busy")?;
            if current != epoch.load(Ordering::SeqCst) {
                return Err("USB frame cancelled".into());
            }
            let file = owned.as_ref().ok_or("USB display disconnected")?;
            let mut packet = Vec::with_capacity(32780);
            packet.extend_from_slice(b"BUZZ128\n");
            packet.extend_from_slice(&bytes);
            packet.extend_from_slice(&checksum(&bytes).to_le_bytes());
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
            if let Err(error) = exchange(file, &packet, &[6], deadline) {
                owned.take();
                return Err(format!("USB display disconnected: {error}"));
            }
            if current != epoch.load(Ordering::SeqCst) {
                owned.take();
                return Err("USB frame cancelled".into());
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (display, pixels);
        Err("USB compute display currently supports macOS".into())
    }
}

#[tauri::command]
pub fn mesh_compute_widget_usb_disconnect<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    display: tauri::State<'_, UsbDisplay>,
) -> Result<(), String> {
    widget_only(&window)?;
    display.disconnect();
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        os::{
            fd::{FromRawFd, IntoRawFd},
            unix::net::UnixStream,
        },
        time::{Duration, Instant},
    };

    fn pair() -> (std::fs::File, UnixStream) {
        let (client, peer) = UnixStream::pair().unwrap();
        client.set_nonblocking(true).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        peer.set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        (
            unsafe { std::fs::File::from_raw_fd(client.into_raw_fd()) },
            peer,
        )
    }

    #[test]
    fn handshake_then_large_frame_with_fragmented_acknowledgement() {
        let (file, mut peer) = pair();
        let pixels: Vec<u8> = (0..32768).map(|n| n as u8).collect();
        let expected = pixels.clone();
        let worker = std::thread::spawn(move || {
            let mut hello = [0; 6];
            peer.read_exact(&mut hello).unwrap();
            assert_eq!(&hello, b"BUZZ?\n");
            for byte in b"BUZZ128/1\n" {
                peer.write_all(&[*byte]).unwrap();
            }
            let mut packet = vec![0; 32780];
            peer.read_exact(&mut packet).unwrap();
            assert_eq!(&packet[..8], b"BUZZ128\n");
            assert_eq!(&packet[8..32776], expected.as_slice());
            assert_eq!(&packet[32776..], checksum(&expected).to_le_bytes());
            peer.write_all(&[6]).unwrap();
            // Keep the peer alive until the client observes the ACK.
            let mut done = [0];
            peer.read_exact(&mut done).unwrap();
        });
        exchange(
            &file,
            b"BUZZ?\n",
            b"BUZZ128/1\n",
            Instant::now() + Duration::from_secs(2),
        )
        .unwrap();
        let mut packet = b"BUZZ128\n".to_vec();
        packet.extend_from_slice(&pixels);
        packet.extend_from_slice(&checksum(&pixels).to_le_bytes());
        exchange(
            &file,
            &packet,
            &[6],
            Instant::now() + Duration::from_secs(2),
        )
        .unwrap();
        (&file).write_all(&[0]).unwrap();
        worker.join().unwrap();
    }

    #[test]
    fn refuses_wrong_firmware_and_expired_deadlines() {
        let (file, mut peer) = pair();
        peer.write_all(b"WRONG128/1").unwrap();
        assert_eq!(
            exchange(
                &file,
                b"BUZZ?\n",
                b"BUZZ128/1\n",
                Instant::now() + Duration::from_secs(1)
            )
            .unwrap_err()
            .kind(),
            std::io::ErrorKind::InvalidData
        );
        assert_eq!(
            exchange(&file, b"x", &[6], Instant::now())
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::TimedOut
        );
        drop(peer);
        assert!(exchange(&file, b"x", &[6], Instant::now() + Duration::from_secs(1)).is_err());
    }

    #[test]
    fn disconnect_invalidates_pending_connections_without_blocking() {
        let display = UsbDisplay::default();
        let owned = display.session.lock().unwrap();
        let before = display.epoch.load(Ordering::SeqCst);
        let task = display.disconnect_task();
        assert_ne!(before, display.epoch.load(Ordering::SeqCst));
        drop(owned);
        tauri::async_runtime::block_on(task).unwrap();
        assert!(display.session.lock().unwrap().is_none());
        assert!(port_name("cu.usbmodem101"));
        assert!(!port_name("cu.usbmodem"));
        assert!(!port_name("cu.Bluetooth-Incoming-Port"));
        assert!(!port_name("cu.usbmodem/../../file"));
    }

    #[test]
    fn late_cleanup_closes_published_handle_but_preserves_a_newer_connection() {
        let display = UsbDisplay::default();
        let (file, _peer) = pair();
        let mut owned = display.session.lock().unwrap();
        let task = display.disconnect_task();
        *owned = Some(file); // Cancellation after the final connect check.
        drop(owned);
        tauri::async_runtime::block_on(task).unwrap();
        assert!(display.session.lock().unwrap().is_none());

        let (file, _peer) = pair();
        let mut owned = display.session.lock().unwrap();
        let task = display.disconnect_task();
        display.epoch.fetch_add(1, Ordering::SeqCst); // A later Connect wins.
        *owned = Some(file);
        drop(owned);
        tauri::async_runtime::block_on(task).unwrap();
        assert!(display.session.lock().unwrap().is_some());
    }

    #[test]
    #[ignore = "requires the explicitly selected physical ESP32 display"]
    fn physical_firmware_accepts_widget_frames_and_reconnects() {
        let path = std::env::var("BUZZ_USB_HARDWARE_PORT").expect("set BUZZ_USB_HARDWARE_PORT");
        assert!(path.starts_with("/dev/") && port_name(&path[5..]));
        let frame_path =
            std::env::var("BUZZ_USB_HARDWARE_FRAME").expect("set BUZZ_USB_HARDWARE_FRAME");
        let bytes = std::fs::read(frame_path).unwrap();
        assert_eq!(bytes.len(), 32768);
        let file = open(std::path::Path::new(&path)).unwrap();
        exchange(
            &file,
            b"BUZZ?\n",
            b"BUZZ128/1\n",
            Instant::now() + Duration::from_secs(2),
        )
        .unwrap();
        let mut packet = b"BUZZ128\n".to_vec();
        packet.extend_from_slice(&bytes);
        packet.extend_from_slice(&checksum(&bytes).to_le_bytes());
        let started = Instant::now();
        for _ in 0..30 {
            exchange(
                &file,
                &packet,
                &[6],
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap();
        }
        eprintln!(
            "30 displayed frames acknowledged in {:?}",
            started.elapsed()
        );
        // Deliberately abandon a frame, then reconnect through the real quiet-period boundary.
        (&file).write_all(b"BUZZ128\npartial").unwrap();
        drop(file);
        let file = open(std::path::Path::new(&path)).unwrap();
        exchange(
            &file,
            b"BUZZ?\n",
            b"BUZZ128/1\n",
            Instant::now() + Duration::from_secs(2),
        )
        .unwrap();
        exchange(
            &file,
            &packet,
            &[6],
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
    }
}

#[cfg(target_os = "macos")]
fn port_name(name: &str) -> bool {
    name.strip_prefix("cu.usbmodem").is_some_and(|suffix| {
        !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_alphanumeric())
    })
}

#[cfg(target_os = "macos")]
fn open(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOCTTY | libc::O_NONBLOCK | libc::O_NOFOLLOW)
        .open(path)?;
    let fd = file.as_raw_fd();
    // The path is a kernel serial device; exclusive access prevents a second
    // monitor or uploader from interleaving bytes with this session.
    unsafe {
        let mut options = std::mem::zeroed();
        if libc::ioctl(fd, libc::TIOCEXCL as libc::c_ulong) < 0
            || libc::tcgetattr(fd, &mut options) < 0
        {
            return Err(std::io::Error::last_os_error());
        }
        libc::cfmakeraw(&mut options);
        options.c_cflag |= libc::CLOCAL | libc::CREAD;
        libc::cfsetspeed(&mut options, libc::B115200);
        if libc::tcsetattr(fd, libc::TCSANOW, &options) < 0
            || libc::tcflush(fd, libc::TCIOFLUSH) < 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    // Firmware abandons partial packets after 1000 ms without input. Establish
    // that boundary before sending a hello, then discard a prior ACK/NAK.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    if unsafe { libc::tcflush(fd, libc::TCIOFLUSH) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(file)
}

#[cfg(target_os = "macos")]
fn checksum(bytes: &[u8]) -> u32 {
    bytes.iter().fold(2166136261u32, |hash, byte| {
        (hash ^ u32::from(*byte)).wrapping_mul(16777619)
    })
}

#[cfg(target_os = "macos")]
fn exchange(
    mut file: &std::fs::File,
    packet: &[u8],
    reply: &[u8],
    deadline: std::time::Instant,
) -> std::io::Result<()> {
    use std::{
        io::{Read, Write},
        os::fd::AsRawFd,
    };
    let fd = file.as_raw_fd();
    let wait = |events| -> std::io::Result<()> {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        let mut descriptor = libc::pollfd {
            fd,
            events,
            revents: 0,
        };
        let result = unsafe { libc::poll(&mut descriptor, 1, remaining.as_millis().max(1) as i32) };
        if result < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if result == 0 {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        if descriptor.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
            return Err(std::io::ErrorKind::BrokenPipe.into());
        }
        Ok(())
    };
    let mut offset = 0;
    while offset < packet.len() {
        wait(libc::POLLOUT)?;
        match file.write(&packet[offset..]) {
            Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
            Ok(count) => offset += count,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) => {}
            Err(e) => return Err(e),
        }
    }
    let mut received = vec![0; reply.len()];
    offset = 0;
    while offset < received.len() {
        wait(libc::POLLIN)?;
        match file.read(&mut received[offset..]) {
            Ok(0) => return Err(std::io::ErrorKind::UnexpectedEof.into()),
            Ok(count) => offset += count,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) => {}
            Err(e) => return Err(e),
        }
    }
    if received != reply {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    Ok(())
}
