use super::*;
use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Notify, Semaphore},
};

fn pubkey(secret: [u8; 32]) -> String {
    PublicKey::from_secret_key(
        &Secp256k1::signing_only(),
        &SecretKey::from_byte_array(secret).unwrap(),
    )
    .x_only_public_key()
    .0
    .to_string()
}
fn recovery(keys: &[[u8; 32]], failed: usize) -> serde_json::Value {
    serde_json::json!({"backups":keys.iter().map(|key| serde_json::json!({
        "backup_id":uuid::Uuid::new_v4().to_string(), "nostr_pubkey":pubkey(*key), "secret_key":URL_SAFE_NO_PAD.encode(key)
    })).collect::<Vec<_>>(), "failed_backup_ids":(0..failed).map(|_|uuid::Uuid::new_v4().to_string()).collect::<Vec<_>>()})
}
struct FixtureState {
    mapping: Option<String>,
    mapping_status: u16,
    mapping_body: Option<serde_json::Value>,
    recovery_status: u16,
    recovery: serde_json::Value,
    requests: HashMap<String, usize>,
}
struct Service {
    root: String,
    state: Arc<Mutex<FixtureState>>,
    pause_recovery: Arc<AtomicBool>,
    pause_current: Arc<AtomicBool>,
    response_started: Arc<Notify>,
    release_response: Arc<Semaphore>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Service {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Service {
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(FixtureState {
            mapping: Some(pubkey([1; 32])),
            mapping_status: 200,
            mapping_body: None,
            recovery_status: 200,
            recovery: recovery(&[[1; 32]], 0),
            requests: HashMap::new(),
        }));
        let pause_recovery = Arc::new(AtomicBool::new(false));
        let pause_current = Arc::new(AtomicBool::new(false));
        let response_started = Arc::new(Notify::new());
        let release_response = Arc::new(Semaphore::new(0));
        let current = pause_current.clone();
        let (shared, pause, started, release) = (
            state.clone(),
            pause_recovery.clone(),
            response_started.clone(),
            release_response.clone(),
        );
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let current = current.clone();
                let (shared, pause, started, release) = (
                    shared.clone(),
                    pause.clone(),
                    started.clone(),
                    release.clone(),
                );
                tokio::spawn(async move {
                    serve(stream, shared, pause, current, started, release).await;
                });
            }
        });
        Self {
            root,
            state,
            pause_recovery,
            pause_current,
            response_started,
            release_response,
            task,
        }
    }
    fn host(&self) -> NsecBackupHost {
        NsecBackupHost {
            state: Default::default(),
            config: Arc::new(Some(Config {
                service_url: self.root.clone(),
                namespace: "backup/staging".into(),
            })),
        }
    }
    fn assert_recovery_only(&self) {
        let requests = &self.state.lock().unwrap().requests;
        assert_eq!(requests.get("/v1/auth/login/exchange"), Some(&1));
        assert_eq!(requests.get("/v1/auth/me"), Some(&1));
        assert!(requests.contains_key("/v1/buzz/nostr-identities/current"));
        assert_eq!(requests.get("/v1/buzz/nsec-backups/recovery"), Some(&1));
        assert_eq!(requests.len(), 4, "enrollment and uploads are forbidden");
    }
}
async fn serve(
    mut stream: TcpStream,
    shared: Arc<Mutex<FixtureState>>,
    pause: Arc<AtomicBool>,
    pause_current: Arc<AtomicBool>,
    started: Arc<Notify>,
    release: Arc<Semaphore>,
) {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 1024];
    let header_end = loop {
        let count = stream.read(&mut chunk).await.unwrap();
        if count == 0 {
            return;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(index) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let header = std::str::from_utf8(&bytes[..header_end])
        .unwrap()
        .to_owned();
    let path = header
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .to_owned();
    let length = header
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    while bytes.len() < header_end + length {
        let count = stream.read(&mut chunk).await.unwrap();
        if count == 0 {
            return;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    assert!(
        path.ends_with("/exchange")
            || header
                .to_ascii_lowercase()
                .contains("x-bb-session-credential: synthetic-cli-credential")
    );
    let (status, response) = {
        let mut state = shared.lock().unwrap();
        *state.requests.entry(path.clone()).or_default() += 1;
        match path.as_str() {
            "/v1/auth/login/exchange" => (200, serde_json::json!({"session_credential":"synthetic-cli-credential"})),
            "/v1/auth/me" => (200, serde_json::json!({"subject":"synthetic-account","expires_at":"2999-01-01T00:00:00Z"})),
            "/v1/buzz/nostr-identities/current" => (state.mapping_status,state.mapping_body.clone().unwrap_or_else(||serde_json::json!({"correlation_id":"synthetic-correlation","identity":state.mapping.as_ref().map(|key|serde_json::json!({"pubkey_hex":key}))}))),
            "/v1/buzz/nsec-backups/recovery" => (state.recovery_status,state.recovery.clone()),
            // Count forbidden calls, then fail them without accepting any key material.
            _ => (500, serde_json::json!({"error":"unexpected synthetic route"})),
        }
    };
    if path == "/v1/buzz/nsec-backups/recovery" && pause.load(Ordering::SeqCst)
        || path == "/v1/buzz/nostr-identities/current" && pause_current.load(Ordering::SeqCst)
    {
        started.notify_one();
        release.acquire().await.unwrap().forget();
    }
    let response = serde_json::to_vec(&response).unwrap();
    let header = format!("HTTP/1.1 {status} Synthetic\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",response.len());
    stream.write_all(header.as_bytes()).await.unwrap();
    let _ = stream.write_all(&response).await;
}

#[test]
fn recovery_validates_scalars_and_metadata_and_deduplicates_public_choices() {
    let mut value = recovery(&[[1; 32], [2; 32], [1; 32]], 2);
    value["backups"].as_array_mut().unwrap().push(serde_json::json!({"backup_id":uuid::Uuid::new_v4().to_string(),"nostr_pubkey":pubkey([3;32]),"secret_key":URL_SAFE_NO_PAD.encode([1;32])}));
    value["backups"].as_array_mut().unwrap().push(serde_json::json!({"backup_id":uuid::Uuid::new_v4().to_string(),"nostr_pubkey":pubkey([1;32]),"secret_key":URL_SAFE_NO_PAD.encode([0;32])}));
    let (keys, failed) = candidates(serde_json::from_value(value).unwrap());
    assert_eq!(
        keys.iter()
            .map(|key| key.pubkey.clone())
            .collect::<Vec<_>>(),
        vec![pubkey([1; 32]), pubkey([2; 32])]
    );
    assert_ne!(keys[0].handle, keys[1].handle);
    assert_eq!(failed, 4);
}

async fn recover_with(service: &Service, host: &NsecBackupHost) -> Result<RestoreResult> {
    let callback = OAuthCallbackHost::default();
    let authorization = Arc::new(Mutex::new(String::new()));
    let capture = authorization.clone();
    let oauth = callback
        .begin(
            OAuthRequest {
                authorization_url: "https://signin.example/login".into(),
                callback_path: "/synthetic".into(),
                use_state: Some(true),
            },
            move |url| {
                *capture.lock().unwrap() = url.into();
                Ok(())
            },
        )
        .unwrap();
    let callback_url = oauth.callback_url.clone();
    let state = url::Url::parse(&authorization.lock().unwrap())
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .to_string();
    let id = "synthetic-attempt";
    let (_send, receive) = oneshot::channel();
    host.state.lock().unwrap().restore = Some(Restore {
        id: id.into(),
        admission: Arc::new(Mutex::new(true)),
        callback: callback.clone(),
        callback_id: oauth.id.clone(),
        task: tauri::async_runtime::spawn(std::future::pending()),
        result: Some(receive),
        candidates: Vec::new(),
        current: None,
        credential: None,
        installing: false,
    });
    let task_host = host.clone();
    let task = tokio::spawn(async move {
        task_host
            .recover(
                0,
                id,
                callback,
                oauth.id,
                callback_url,
                Zeroizing::new("synthetic-verifier".into()),
            )
            .await
    });
    let callback_url = url::Url::parse(&oauth.callback_url).unwrap();
    let authority = format!("127.0.0.1:{}", callback_url.port().unwrap());
    let mut stream = TcpStream::connect(&authority).await.unwrap();
    stream.write_all(format!("GET /synthetic?state={state}&code=synthetic-code HTTP/1.1\r\nHost: {authority}\r\n\r\n").as_bytes()).await.unwrap();
    let result = task.await.unwrap();
    // Keep the service borrowed through completion; no OS credential store is involved.
    assert_eq!(
        service.state.lock().unwrap().requests.get("/v1/auth/me"),
        Some(&1)
    );
    result
}

#[tokio::test]
async fn native_recovery_preserves_empty_partial_all_failed_and_unavailable_distinctions() {
    for (keys, failed, status) in [
        (vec![], 0, 200),
        (vec![], 2, 200),
        (vec![[1; 32], [2; 32]], 1, 200),
        (vec![], 0, 404),
    ] {
        let service = Service::new().await;
        let host = service.host();
        service.state.lock().unwrap().recovery = recovery(&keys, failed);
        service.state.lock().unwrap().recovery_status = status;
        let result = recover_with(&service, &host).await;
        if status == 404 {
            assert_eq!(result.err().as_deref(), Some(UNAVAILABLE));
        } else {
            let result = result.unwrap();
            assert_eq!(result.candidates.len(), keys.len());
            assert_eq!(result.failed_count, failed);
            assert_eq!(result.current_pubkey, Some(pubkey([1; 32])));
        }
        host.cancel("synthetic-attempt");
        host.cancel("synthetic-attempt");
    }
}

#[tokio::test]
async fn mapping_failure_never_becomes_a_missing_binding() {
    let service = Service::new().await;
    service.state.lock().unwrap().mapping_status = 404;
    let result = recover_with(&service, &service.host()).await;
    assert_eq!(result.err().as_deref(), Some(RETRY));
    assert!(!service
        .state
        .lock()
        .unwrap()
        .requests
        .contains_key("/v1/buzz/nsec-backups/recovery"));
}

#[tokio::test]
async fn known_missing_mapping_accepts_omitted_identity_but_malformed_success_is_retryable() {
    for response in [
        serde_json::json!({"correlation_id":"synthetic-correlation"}),
        serde_json::json!({}),
    ] {
        let service = Service::new().await;
        service.state.lock().unwrap().mapping_body = Some(response.clone());
        let result = Api::new(&service.root, "synthetic-cli-credential")
            .unwrap()
            .current()
            .await;
        if response.get("correlation_id").is_some() {
            assert_eq!(result.unwrap(), None);
        } else {
            assert!(result.is_err());
        }
    }
}

#[tokio::test]
async fn canceled_recovery_drops_candidates_and_a_late_response_cannot_publish_them() {
    let service = Service::new().await;
    let host = service.host();
    service.pause_recovery.store(true, Ordering::SeqCst);
    let recovering = recover_with(&service, &host);
    tokio::pin!(recovering);
    tokio::select! {
        _ = service.response_started.notified() => {},
        _ = &mut recovering => panic!("recovery completed before the fixture released it"),
    }
    host.cancel("synthetic-attempt");
    service.release_response.add_permits(1);
    assert_eq!(recovering.await.err().as_deref(), Some(CANCELED));
    assert!(host.state.lock().unwrap().restore.is_none());
}

#[tokio::test]
async fn explicit_current_and_historical_install_commit_selected_key_without_uploading() {
    for selected in [[1; 32], [2; 32]] {
        let service = Service::new().await;
        service.state.lock().unwrap().recovery = recovery(&[[2; 32], [1; 32], [1; 32]], 0);
        let host = service.host();
        let identity = crate::identity::tests::missing_fixture();
        let recovered = recover_with(&service, &host).await.unwrap();
        let chosen = recovered
            .candidates
            .iter()
            .find(|key| key.pubkey == pubkey(selected))
            .unwrap();
        assert_eq!(
            host.install(identity.clone(), "synthetic-attempt", &chosen.handle)
                .await
                .unwrap(),
            pubkey(selected)
        );
        assert_eq!(identity.viewer().await.unwrap(), pubkey(selected));
        assert_eq!(
            host.wait("synthetic-attempt").await.err().as_deref(),
            Some(CANCELED)
        );
        service.assert_recovery_only();
        assert_eq!(service.state.lock().unwrap().mapping, Some(pubkey([1; 32])));
    }
}

#[tokio::test]
async fn creating_or_importing_an_identity_cancels_recovery_without_uploading() {
    use tauri::Manager;

    for imported in [false, true] {
        let service = Service::new().await;
        let host = service.host();
        let identity = crate::identity::tests::missing_fixture();
        let recovered = recover_with(&service, &host).await.unwrap();
        let handle = recovered.candidates[0].handle.clone();
        let app = tauri::test::mock_builder()
            .manage(identity.clone())
            .manage(host.clone())
            .build(crate::app_context())
            .unwrap();
        let public = if imported {
            let nsec =
                bech32::encode::<bech32::Bech32>(bech32::Hrp::parse("nsec").unwrap(), &[2; 32])
                    .unwrap();
            crate::identity::identity_import(app.state(), app.state(), nsec)
                .await
                .unwrap()
        } else {
            crate::identity::identity_create(app.state(), app.state())
                .await
                .unwrap()
        };
        assert_eq!(identity.viewer().await.unwrap(), public);
        if imported {
            assert_eq!(public, pubkey([2; 32]));
        }
        assert!(host.state.lock().unwrap().restore.is_none());
        assert_eq!(
            host.install(identity, "synthetic-attempt", &handle)
                .await
                .err()
                .as_deref(),
            Some(CANCELED)
        );
        service.assert_recovery_only();
    }
}

#[tokio::test]
async fn document_reload_and_close_retire_recovery_credentials_and_handles() {
    for closing in [false, true] {
        let service = Service::new().await;
        let host = service.host();
        let recovered = recover_with(&service, &host).await.unwrap();
        let (epoch, admission) = {
            let state = host.state.lock().unwrap();
            (
                state.epoch,
                state.restore.as_ref().unwrap().admission.clone(),
            )
        };
        if closing {
            host.close();
        } else {
            host.document_load();
        }
        assert!(host.valid(epoch).is_err());
        assert!(!*admission.lock().unwrap());
        assert!(host.state.lock().unwrap().restore.is_none());
        assert_eq!(
            host.install(
                crate::identity::tests::missing_fixture(),
                "synthetic-attempt",
                &recovered.candidates[0].handle,
            )
            .await
            .err()
            .as_deref(),
            Some(CANCELED)
        );
        service.assert_recovery_only();
    }
}

#[test]
fn former_backup_session_and_retry_commands_are_unavailable_through_production_ipc() {
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};

    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .manage(NsecBackupHost::default())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    for (command, body) in [
        (
            "nsec_backup_session",
            serde_json::json!({
                "source": "hosted", "generation": 1,
                "credential": "synthetic-cli-credential"
            }),
        ),
        (
            "nsec_backup_retry",
            serde_json::json!({ "source": "hosted" }),
        ),
    ] {
        assert!(
            get_ipc_response(
                &view,
                tauri::webview::InvokeRequest {
                    cmd: command.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: view.url().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.into(),
                },
            )
            .is_err(),
            "{command} must not accept a login credential or trigger an upload"
        );
    }
}

#[tokio::test]
async fn install_mapping_change_leaves_candidate_retryable_without_key_adoption() {
    let service = Service::new().await;
    let host = service.host();
    let identity = crate::identity::tests::missing_fixture();
    let recovered = recover_with(&service, &host).await.unwrap();
    let handle = &recovered.candidates[0].handle;
    service.state.lock().unwrap().mapping = Some(pubkey([2; 32]));
    assert!(host
        .install(identity.clone(), "synthetic-attempt", handle)
        .await
        .is_err());
    identity.require_missing().await.unwrap();
    service.state.lock().unwrap().mapping = Some(pubkey([1; 32]));
    assert_eq!(
        host.install(identity.clone(), "synthetic-attempt", handle)
            .await
            .unwrap(),
        pubkey([1; 32])
    );
    assert_eq!(identity.viewer().await.unwrap(), pubkey([1; 32]));
}

#[tokio::test]
async fn secure_store_write_failure_keeps_native_candidate_for_retry_after_access_recovers() {
    let service = Service::new().await;
    let host = service.host();
    let (identity, allow_writes) = crate::identity::tests::write_denied_fixture();
    let recovered = recover_with(&service, &host).await.unwrap();
    let handle = &recovered.candidates[0].handle;
    assert!(host
        .install(identity.clone(), "synthetic-attempt", handle)
        .await
        .is_err());
    identity.require_missing().await.unwrap();
    allow_writes();
    assert_eq!(
        host.install(identity.clone(), "synthetic-attempt", handle)
            .await
            .unwrap(),
        pubkey([1; 32])
    );
    assert_eq!(identity.viewer().await.unwrap(), pubkey([1; 32]));
}

#[tokio::test]
async fn cancel_during_install_mapping_wait_fences_a_late_response_and_invalidates_handle() {
    let service = Service::new().await;
    let host = service.host();
    let identity = crate::identity::tests::missing_fixture();
    let recovered = recover_with(&service, &host).await.unwrap();
    let handle = recovered.candidates[0].handle.clone();
    service.pause_current.store(true, Ordering::SeqCst);
    let task_host = host.clone();
    let task_identity = identity.clone();
    let task_handle = handle.clone();
    let installing = tokio::spawn(async move {
        task_host
            .install(task_identity, "synthetic-attempt", &task_handle)
            .await
    });
    service.response_started.notified().await;
    host.cancel("synthetic-attempt");
    service.release_response.add_permits(1);
    assert_eq!(installing.await.unwrap().err().as_deref(), Some(CANCELED));
    identity.require_missing().await.unwrap();
    assert_eq!(
        host.install(identity, "synthetic-attempt", &handle)
            .await
            .err()
            .as_deref(),
        Some(CANCELED)
    );
}
