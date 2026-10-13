//! Explicit opt-in SDK smoke. No Tauri app, IdentityHost or saved agents are initialized.
use super::MeshHost;
use buzz_mesh_compute::{config::ClientConfig, identity::ensure_owner_at, lifecycle::Phase};
use std::time::Duration;

fn request(owner: &str, path: &std::path::Path) -> ClientConfig {
    ClientConfig {
        api_port: 19337,
        console_port: 13131,
        owner_key: path.to_owned(),
        owner_id: owner.to_owned(),
        trusted_owners: vec![owner.to_owned()],
        join_token: None,
        mesh_name: Some("buzz-native-smoke".into()),
    }
}

#[tokio::test]
#[ignore = "native smoke: requires dedicated HOME/runtime cache and free 19337/13131"]
async fn native_mesh_host_start_stop_restart() {
    let home = std::env::var("BUZZ_MESH_SMOKE_HOME").expect("explicit smoke HOME required");
    assert_eq!(std::env::var("HOME").unwrap(), home);
    assert!(std::path::Path::new(&home).join("SMOKE_ONLY").is_file());
    for port in [19337, 13131] {
        std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .expect("smoke port already occupied");
    }
    let temp = tempfile::tempdir_in(&home).unwrap();
    let path = temp.path().join("owner.json");
    let owner = ensure_owner_at(&path).unwrap();
    let host = MeshHost::default();
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    println!("smoke_pid={}", std::process::id());
    for round in 1..=2 {
        host.lifecycle.start(request(&owner, &path)).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(90), async {
            loop {
                if let Phase::Failed(reason) = host.lifecycle.phase() {
                    panic!("startup: {reason}");
                }
                if host.lifecycle.phase() == Phase::Ready {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            let response = http
                .get("http://127.0.0.1:19337/v1/models")
                .send()
                .await
                .unwrap();
            let status = response.status();
            let body = response.text().await.unwrap();
            println!("round={round} models_status={status} models_body={body}");
            assert!(status.is_success() || status.as_u16() == 503);
            let ps = std::process::Command::new("ps")
                .args(["-p", &std::process::id().to_string(), "-o", "pid,ppid,comm"])
                .output()
                .unwrap();
            println!(
                "round={round} before_stop_ps={}",
                String::from_utf8_lossy(&ps.stdout)
            );
        })
        .await;
        // Always request stop, including when the readiness deadline expires.
        host.lifecycle.stop();
        assert!(host.lifecycle.start(request(&owner, &path)).is_err());
        let stopped = host.lifecycle.stop_and_wait().await;
        println!(
            "round={round} stop={stopped:?} phase={:?}",
            host.lifecycle.phase()
        );
        stopped.unwrap();
        let ps = std::process::Command::new("ps")
            .args(["-p", &std::process::id().to_string(), "-o", "pid,ppid,comm"])
            .output()
            .unwrap();
        println!(
            "round={round} after_stop_ps={}",
            String::from_utf8_lossy(&ps.stdout)
        );
        result.expect("native startup deadline expired");
        for port in [19337, 13131] {
            std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
                .expect("listener remained after confirmed stop");
        }
        assert_eq!(ensure_owner_at(&path).unwrap(), owner);
    }
}
