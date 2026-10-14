use super::*;
use buzz_pairing::{crypto, PairingMessage};
use nostr_pairing::{EventBuilder, JsonUtil, Keys, Kind, Tag};

fn message(keys: &Keys, source: &PairingSession, value: PairingMessage) -> Event {
    let content = nostr_pairing::nips::nip44::encrypt(
        keys.secret_key(),
        &source.pubkey(),
        serde_json::to_string(&value).unwrap(),
        nostr_pairing::nips::nip44::Version::V2,
    )
    .unwrap();
    EventBuilder::new(Kind::Custom(buzz_pairing::session::KIND_PAIRING), content)
        .tags([Tag::public_key(source.pubkey())])
        .sign_with_keys(keys)
        .unwrap()
}
fn entry() -> (Exchange, Keys, buzz_pairing::QrPayload, String) {
    let (session, qr) = PairingSession::new_source("wss://relay.test".into());
    let target = Keys::generate();
    let mut exchange = Exchange {
        session,
        payload: Some(prepared()),
        code_entry: false,
    };
    let offer = message(
        &target,
        &exchange.session,
        PairingMessage::Offer {
            session_id: hex::encode(crypto::derive_session_id(&qr.session_secret)),
            version: 1,
            confirmation: Some("desktop-code-v1".into()),
        },
    );
    let output = exchange.receive(&offer).unwrap();
    assert!(matches!(
        output.status,
        Some(Status::Code {
            code_entry: true,
            ..
        })
    ));
    assert_eq!(output.events.len(), 1);
    let Some(Status::Code { code, .. }) = output.status else {
        panic!("missing code")
    };
    (exchange, target, qr, code)
}
fn proof(exchange: &Exchange, target: &Keys, qr: &buzz_pairing::QrPayload) -> Event {
    let shared =
        nostr_pairing::util::generate_shared_key(target.secret_key(), &qr.source_pubkey).unwrap();
    let (_, sas) = crypto::derive_sas(&shared, &qr.session_secret);
    let hash = crypto::derive_transcript_hash(
        &crypto::derive_session_id(&qr.session_secret),
        &qr.source_pubkey.to_bytes(),
        &target.public_key().to_bytes(),
        &sas,
        &qr.session_secret,
    );
    message(
        target,
        &exchange.session,
        PairingMessage::SasConfirm {
            transcript_hash: hex::encode(hash),
        },
    )
}
fn submission(exchange: &Exchange, target: &Keys, code: &str, attempt: u8) -> Event {
    message(
        target,
        &exchange.session,
        PairingMessage::CodeSubmit {
            code: code.into(),
            request_id: attempt.to_string(),
        },
    )
}
#[test]
fn transcript_alone_never_exports_and_guess_budget_cannot_be_reset() {
    let (mut exchange, target, qr, code) = entry();
    assert!(exchange
        .receive(&proof(&exchange, &target, &qr))
        .unwrap()
        .events
        .is_empty());
    assert!(exchange.payload.is_some());
    let wrong = if code == "000000" { "000001" } else { "000000" };
    for attempt in 1..=5 {
        let event = submission(&exchange, &target, wrong, attempt);
        let output = exchange.receive(&event).unwrap();
        assert_eq!(output.events.len(), 1);
        assert!(exchange.payload.is_some());
        if attempt == 5 {
            assert!(matches!(output.status, Some(Status::Error { .. })));
        }
        if attempt < 5 {
            assert!(exchange.receive(&event).unwrap().events.is_empty());
        } else {
            assert!(exchange.receive(&event).is_err());
        }
    }
    assert!(exchange
        .receive(&submission(&exchange, &target, &code, 6))
        .is_err());
    assert!(exchange.payload.is_some());
}
#[test]
fn timeout_preserves_possible_import_only_after_payload_publication() {
    for released in [false, true] {
        let manager = Pairing::default();
        let attempt = register(&manager, active("live", Status::Transferring));
        if released {
            grant(&manager, &attempt);
        }
        manager.expire(&attempt);
        assert_eq!(
            visible(&manager),
            if released {
                Status::Uncertain
            } else {
                Status::Expired
            }
        );
        assert!(
            try_grant(&manager, &attempt).is_none(),
            "terminal attempts cannot obtain a new grant"
        );
    }
}
#[test]
fn entry_requires_phone_proof_and_real_completion() {
    let (mut exchange, target, qr, code) = entry();
    assert!(
        exchange.confirm().is_err(),
        "desktop cannot bypass code entry"
    );
    let output = exchange
        .receive(&submission(&exchange, &target, &code, 1))
        .unwrap();
    assert_eq!(output.status, Some(Status::Transferring));
    assert_eq!(output.events.len(), 1);
    assert!(output.payload.is_some());
    let plain = Zeroizing::new(
        nostr_pairing::nips::nip44::decrypt(
            target.secret_key(),
            &qr.source_pubkey,
            &output.payload.as_ref().unwrap().event().content,
        )
        .unwrap(),
    );
    assert!(plain.contains("nsec"));
    assert!(!serde_json::to_string(&output.status)
        .unwrap()
        .contains("nsec"));
    let done = message(
        &target,
        &exchange.session,
        PairingMessage::Complete { success: true },
    );
    assert_eq!(
        exchange.receive(&done).unwrap().status,
        Some(Status::Complete)
    );
}
#[test]
fn mismatch_and_phone_import_failure_never_claim_success() {
    let (mut exchange, target, _, code) = entry();
    let wrong = message(
        &target,
        &exchange.session,
        PairingMessage::CodeSubmit {
            code: if code == "000000" { "000001" } else { "000000" }.into(),
            request_id: "wrong".into(),
        },
    );
    let rejection = exchange.receive(&wrong).unwrap();
    assert_eq!(rejection.events.len(), 1);
    assert_ne!(rejection.status, Some(Status::Transferring));
    assert!(exchange.payload.is_some());
    let (mut exchange, target, _qr, code) = entry();
    exchange
        .receive(&submission(&exchange, &target, &code, 1))
        .unwrap();
    let rejected = message(
        &target,
        &exchange.session,
        PairingMessage::Complete { success: false },
    );
    assert!(exchange.receive(&rejected).is_err());
}
#[test]
fn legacy_phone_still_needs_explicit_desktop_confirmation() {
    let (session, qr) = PairingSession::new_source("wss://relay.test".into());
    let (mut phone, offer) = PairingSession::new_target(&qr).unwrap();
    let mut exchange = Exchange {
        session,
        payload: Some(prepared()),
        code_entry: false,
    };
    assert!(matches!(
        exchange.receive(&offer).unwrap().status,
        Some(Status::Code {
            code_entry: false,
            ..
        })
    ));
    let output = exchange.confirm().unwrap();
    phone.handle_sas_confirm(&output.events[0]).unwrap();
    phone.confirm_target_sas().unwrap();
    let imported = phone
        .handle_payload(output.payload.as_ref().unwrap().event())
        .unwrap()
        .1;
    let imported: serde_json::Value = serde_json::from_str(&imported).unwrap();
    assert_eq!(imported["pubkey"], hex::encode(human()));
    assert_eq!(
        exchange
            .receive(&phone.send_complete().unwrap())
            .unwrap()
            .status,
        Some(Status::Complete)
    );
}
#[tokio::test]
async fn old_session_cleanup_cannot_cancel_or_overwrite_replacement() {
    let manager = Pairing::default();
    let old = register(&manager, active("same", Status::Transferring));
    let new = register(&manager, active("same", Status::Connecting));
    manager.update(&old, Status::Complete);
    manager.expire(&old);
    assert_eq!(visible(&manager), Status::Connecting);
    assert!(try_grant(&manager, &old).is_none());
    assert!(try_grant(&manager, &new).is_some());
    assert_eq!(manager.cancel("same").await.unwrap(), Status::Uncertain);
    manager.update(&new, Status::Complete);
    assert_eq!(visible(&manager), Status::Uncertain);
}

#[test]
fn window_reload_or_destruction_cancels_the_live_attempt() {
    let manager = Pairing::default();
    let attempt = register(&manager, active("live", Status::Connecting));
    let cancel = manager
        .0
        .lock()
        .unwrap()
        .active
        .as_ref()
        .unwrap()
        .cancel
        .clone();
    manager.cancel_all();
    assert!(cancel.is_cancelled());
    assert!(manager.0.lock().unwrap().active.is_none());
    assert!(try_grant(&manager, &attempt).is_none());
}

#[test]
fn cancellation_preserves_post_publication_outcomes() {
    for outcome in [Outcome::Pending, Outcome::Complete, Outcome::Rejected] {
        let manager = Pairing::default();
        let attempt = register(&manager, active("live", Status::Transferring));
        let (mut exchange, target, _, code) = entry();
        manager.bind_session(&attempt, &exchange.session);
        let output = exchange
            .receive(&submission(&exchange, &target, &code, 1))
            .unwrap();
        let payload = output.payload.unwrap();
        manager
            .release(&attempt, &payload, &exchange.session, future())
            .unwrap();
        let expected = match outcome {
            Outcome::Complete => {
                let done = message(
                    &target,
                    &exchange.session,
                    PairingMessage::Complete { success: true },
                );
                exchange.receive(&done).unwrap();
                assert!(manager.complete(&attempt, exchange.session.completion().unwrap()));
                Status::Complete
            }
            Outcome::Rejected => {
                let failure = Status::Error {
                    message: "phone rejected".into(),
                };
                manager.fail(&attempt, failure.clone(), false);
                failure
            }
            _ => Status::Uncertain,
        };
        manager.cancel_all();
        assert_eq!(visible(&manager), expected);
        assert!(try_grant(&manager, &attempt).is_none());
    }
}

#[tokio::test]
async fn replacement_retains_possible_delivery_for_the_retired_id() {
    let manager = Pairing::default();
    let old = register(&manager, active("old", Status::Transferring));
    grant(&manager, &old);
    register(&manager, active("new", Status::Connecting));
    assert_eq!(manager.cancel("old").await.unwrap(), Status::Uncertain);
    assert_eq!(visible(&manager), Status::Connecting);
}

#[test]
fn cancellation_before_publication_blocks_the_payload() {
    let manager = Pairing::default();
    let attempt = register(&manager, active("live", Status::Transferring));
    manager.cancel_all();
    assert!(try_grant(&manager, &attempt).is_none());
}
#[tokio::test]
async fn unexpected_connection_failure_becomes_a_visible_error() {
    let result = guard(async { panic!("simulated connection setup failure") }).await;
    assert_eq!(
        match result.unwrap_err() {
            Failure::Transport(message) => message,
            other => panic!("{other:?}"),
        },
        "Pairing stopped unexpectedly. Create a new code and try again."
    );
}

#[test]
fn transport_failure_is_uncertain_after_publication_but_phone_rejection_is_definite() {
    for released in [false, true] {
        let manager = Pairing::default();
        let attempt = register(&manager, active("live", Status::Transferring));
        if released {
            grant(&manager, &attempt);
        }
        let error = Status::Error {
            message: "connection lost".into(),
        };
        manager.fail(&attempt, error.clone(), true);
        assert_eq!(
            visible(&manager),
            if released { Status::Uncertain } else { error }
        );
        manager.update(&attempt, Status::Complete);
        assert_ne!(visible(&manager), Status::Complete);
    }
}
#[test]
fn mismatched_legacy_code_sends_user_denied_without_exporting() {
    let (session, qr) = PairingSession::new_source("wss://relay.test".into());
    let (mut phone, offer) = PairingSession::new_target(&qr).unwrap();
    let mut exchange = Exchange {
        session,
        payload: Some(prepared()),
        code_entry: false,
    };
    exchange.receive(&offer).unwrap();
    let event = exchange
        .session
        .abort(AbortReason::UserDenied)
        .unwrap()
        .expect("legacy peer is known");
    assert_eq!(phone.handle_abort(&event).unwrap(), AbortReason::UserDenied);
    assert_eq!(exchange.session.state(), SessionState::Aborted);
    assert!(
        exchange.payload.is_some(),
        "denial must not release the identity"
    );
    assert!(exchange.confirm().is_err());
    let (mut code_entry, _, _, _) = entry();
    assert!(code_entry
        .session
        .abort(AbortReason::UserDenied)
        .unwrap()
        .is_some());
    assert_eq!(code_entry.session.state(), SessionState::Aborted);
    assert!(code_entry.payload.is_some());
}

// Exercise the actual post-setup owner, not just PairingSession::abort.
async fn local_sockets() -> (
    relay::Socket,
    tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        tokio_tungstenite::accept_async(listener.accept().await.unwrap().0)
            .await
            .unwrap()
    });
    let (client, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
        .await
        .unwrap();
    (client, server.await.unwrap())
}

#[tokio::test]
async fn cancellation_notifies_a_known_peer_before_transfer_and_waits_for_teardown() {
    use futures_util::StreamExt;
    let (exchange, target, _, _) = entry();
    let (mut socket, mut server) = local_sockets().await;
    let (tx, mut rx) = mpsc::channel(1);
    let manager = Pairing::default();
    let cancel = CancellationToken::new();
    let finished = CancellationToken::new();
    let attempt = register(
        &manager,
        Active {
            id: "live".into(),
            cancel: cancel.clone(),
            finished: finished.clone(),
            confirm: tx,
            status: Status::Code {
                code: "000000".into(),
                code_entry: true,
            },
        },
    );
    assert!(manager.bind_session(&attempt, &exchange.session));
    let owner = manager.clone();
    let task = tokio::spawn(async move {
        let mut exchange = exchange;
        let mut auth = relay::Authentication::default();
        let result = exchange_until_deadline(
            ExchangeContext {
                pairing: &owner,
                attempt: &attempt,
                deadline: tokio::time::Instant::now() + Duration::from_secs(120),
                relay_url: &url::Url::parse("wss://relay.test").unwrap(),
                pending: vec![],
            },
            &mut exchange,
            &mut socket,
            &mut auth,
            &mut rx,
            &cancel,
        )
        .await;
        finished.cancel();
        result
    });
    manager.cancel("live").await.unwrap();
    assert!(task.is_finished(), "cancel returned before owner teardown");
    assert!(task.await.unwrap().is_ok());
    let frame = tokio::time::timeout(Duration::from_secs(2), server.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let json: serde_json::Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
    assert_eq!(json[0], "EVENT");
    let event = Event::from_json(json[1].to_string()).unwrap();
    let plaintext =
        nostr_pairing::nips::nip44::decrypt(target.secret_key(), &event.pubkey, &event.content)
            .unwrap();
    assert!(matches!(
        serde_json::from_str::<PairingMessage>(&plaintext).unwrap(),
        PairingMessage::Abort {
            reason: AbortReason::UserDenied
        }
    ));
}

#[tokio::test]
async fn cancellation_after_transfer_closes_without_aborting_the_importing_phone() {
    use futures_util::{SinkExt, StreamExt};
    let (exchange, target, _, code) = entry();
    let request = submission(&exchange, &target, &code, 1);
    let (socket, mut server) = local_sockets().await;
    let (tx, mut rx) = mpsc::channel(1);
    let manager = Pairing::default();
    let cancel = CancellationToken::new();
    let finished = CancellationToken::new();
    let attempt = register(
        &manager,
        Active {
            id: "live".into(),
            cancel: cancel.clone(),
            finished: finished.clone(),
            confirm: tx,
            status: Status::Code {
                code: code.clone(),
                code_entry: true,
            },
        },
    );
    assert!(manager.bind_session(&attempt, &exchange.session));
    let owner = manager.clone();
    let owner_cancel = cancel.clone();
    let task = tokio::spawn(async move {
        let mut exchange = exchange;
        let mut socket = socket;
        let mut auth = relay::Authentication::default();
        let result = exchange_until_deadline(
            ExchangeContext {
                pairing: &owner,
                attempt: &attempt,
                deadline: tokio::time::Instant::now() + Duration::from_secs(120),
                relay_url: &url::Url::parse("wss://relay.test").unwrap(),
                pending: vec![],
            },
            &mut exchange,
            &mut socket,
            &mut auth,
            &mut rx,
            &owner_cancel,
        )
        .await;
        finished.cancel();
        result
    });
    server
        .send(tokio_tungstenite::tungstenite::Message::Text(
            serde_json::json!(["EVENT", "pair", request])
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let mut messages = vec![];
    for _ in 0..2 {
        let frame = tokio::time::timeout(Duration::from_secs(2), server.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let json: serde_json::Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
        assert_eq!(json[0], "EVENT");
        let event = Event::from_json(json[1].to_string()).unwrap();
        let plaintext =
            nostr_pairing::nips::nip44::decrypt(target.secret_key(), &event.pubkey, &event.content)
                .unwrap();
        messages.push(serde_json::from_str::<PairingMessage>(&plaintext).unwrap());
    }
    assert!(matches!(messages[1], PairingMessage::Payload { .. }));
    // Cancel before any status poll observes the transfer.
    assert_eq!(manager.cancel("live").await.unwrap(), Status::Uncertain);
    assert!(task.await.unwrap().is_ok());
    assert_eq!(
        manager.0.lock().unwrap().active.as_ref().unwrap().status,
        Status::Uncertain,
        "a later status read must not report an unsent cancellation"
    );
    assert!(
        !matches!(
            server.next().await,
            Some(Ok(tokio_tungstenite::tungstenite::Message::Text(_)))
        ),
        "post-publication abort was sent"
    );
}

#[tokio::test]
async fn native_deadline_expires_without_a_peer_or_an_abort() {
    use futures_util::StreamExt;
    let (mut exchange, _, _, _) = entry();
    let (mut socket, mut server) = local_sockets().await;
    let (_tx, mut rx) = mpsc::channel(1);
    let mut auth = relay::Authentication::default();
    let manager = Pairing::default();
    let attempt = register(&manager, active("live", Status::Connecting));
    let result = exchange_until_deadline(
        ExchangeContext {
            pairing: &manager,
            attempt: &attempt,
            deadline: tokio::time::Instant::now(),
            relay_url: &url::Url::parse("wss://relay.test").unwrap(),
            pending: vec![],
        },
        &mut exchange,
        &mut socket,
        &mut auth,
        &mut rx,
        &CancellationToken::new(),
    )
    .await;
    assert!(matches!(result, Err(Failure::Expired)));
    drop(socket);
    assert!(!matches!(
        server.next().await,
        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(_)))
    ));
}

#[test]
fn denial_keeps_native_code_until_abort_has_finished() {
    let manager = Pairing::default();
    let (tx, mut rx) = mpsc::channel(1);
    let attempt = register(
        &manager,
        Active {
            id: "live".into(),
            cancel: CancellationToken::new(),
            finished: CancellationToken::new(),
            confirm: tx,
            status: Status::Code {
                code: "123456".into(),
                code_entry: false,
            },
        },
    );
    decide(&manager, "live", Decision::Deny).unwrap();
    assert!(matches!(rx.try_recv(), Ok(Decision::Deny)));
    assert!(matches!(
        manager.0.lock().unwrap().active.as_ref().unwrap().status,
        Status::Code { .. }
    ));
    manager.fail(
        &attempt,
        Status::Error {
            message: "Pairing was canceled.".into(),
        },
        false,
    );
    assert!(matches!(
        manager.0.lock().unwrap().active.as_ref().unwrap().status,
        Status::Error { .. }
    ));
}

#[tokio::test]
async fn delayed_subscription_expires_before_sidecar_connection_cap() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let (mut socket, mut server) = local_sockets().await;
    let relay_url = url::Url::parse("wss://relay.test/pair").unwrap();
    let (session, _) = PairingSession::new_source(relay_url.to_string());
    let subscription = tokio::spawn(async move {
        let (pending, auth) = relay::subscribe(&mut socket, &session, &relay_url)
            .await
            .unwrap();
        (socket, session, relay_url, pending, auth)
    });
    assert!(server
        .next()
        .await
        .unwrap()
        .unwrap()
        .to_text()
        .unwrap()
        .contains("REQ"));
    assert!(!subscription.is_finished(), "QR must wait for EOSE");
    server
        .send(Message::Text(r#"["EOSE","pair"]"#.into()))
        .await
        .unwrap();
    let (mut socket, mut session, relay_url, pending, mut auth) = subscription.await.unwrap();
    session.start_source_lifetime();
    // Model five seconds consumed by the held EOSE without waiting on wall time.
    // Pause only after real subscription I/O, avoiding auto-advance during I/O.
    tokio::time::pause();
    let connection_started = tokio::time::Instant::now() - Duration::from_secs(5);
    let deadline = exchange_deadline(&session, connection_started);
    assert_eq!(
        deadline - tokio::time::Instant::now(),
        Duration::from_secs(110)
    );
    let task = tokio::spawn(async move {
        let mut exchange = Exchange {
            session,
            payload: Some(prepared()),
            code_entry: false,
        };
        let (_tx, mut rx) = mpsc::channel(1);
        let manager = Pairing::default();
        let attempt = register(&manager, active("live", Status::Connecting));
        exchange_until_deadline(
            ExchangeContext {
                pairing: &manager,
                attempt: &attempt,
                deadline,
                relay_url: &relay_url,
                pending,
            },
            &mut exchange,
            &mut socket,
            &mut auth,
            &mut rx,
            &CancellationToken::new(),
        )
        .await
    });
    tokio::time::advance(Duration::from_secs(109)).await;
    assert!(!task.is_finished());
    tokio::time::advance(Duration::from_secs(1)).await;
    assert!(matches!(task.await.unwrap(), Err(Failure::Expired)));
    // The native expiry maps to Expired (covered above), which the existing UI
    // renewal regression consumes. The sidecar cap has not arrived yet.
    assert!(tokio::time::Instant::now() < connection_started + Duration::from_secs(120));
    tokio::time::advance(Duration::from_secs(5)).await;
    drop(server);
}

#[tokio::test]
async fn early_connection_loss_is_error_before_publication_and_uncertain_after() {
    for payload_sent in [false, true] {
        let (mut socket, server) = local_sockets().await;
        let (session, _) = PairingSession::new_source("wss://relay.test".into());
        let manager = Pairing::default();
        let (tx, mut rx) = mpsc::channel(1);
        let cancel = CancellationToken::new();
        let attempt = register(
            &manager,
            Active {
                id: "live".into(),
                cancel: cancel.clone(),
                finished: CancellationToken::new(),
                confirm: tx,
                status: Status::Qr {
                    svg: "fixture".into(),
                    uri: "fixture".into(),
                },
            },
        );
        if payload_sent {
            grant(&manager, &attempt);
        }
        let deadline = exchange_deadline(&session, tokio::time::Instant::now());
        let mut exchange = Exchange {
            session,
            payload: Some(prepared()),
            code_entry: false,
        };
        drop(server);
        let result = exchange_until_deadline(
            ExchangeContext {
                pairing: &manager,
                attempt: &attempt,
                deadline,
                relay_url: &url::Url::parse("wss://relay.test").unwrap(),
                pending: vec![],
            },
            &mut exchange,
            &mut socket,
            &mut relay::Authentication::default(),
            &mut rx,
            &cancel,
        )
        .await;
        let Err(Failure::Transport(message)) = result else {
            panic!("unexpected result: {result:?}");
        };
        manager.fail(&attempt, Status::Error { message }, true);
        let active = manager.0.lock().unwrap();
        let status = &active.active.as_ref().unwrap().status;
        if payload_sent {
            assert_eq!(status, &Status::Uncertain);
        } else {
            assert!(matches!(status, Status::Error { .. }));
        }
    }
}

#[tokio::test]
async fn sign_out_blocks_a_prepared_payload_and_any_later_attempt() {
    use futures_util::{SinkExt, StreamExt};
    let (exchange, target, _, code) = entry();
    let request = submission(&exchange, &target, &code, 1);
    let (socket, mut server) = local_sockets().await;
    let (tx, mut rx) = mpsc::channel(1);
    let manager = Pairing::default();
    let cancel = CancellationToken::new();
    let finished = CancellationToken::new();
    let make_active = |id: &str, cancel: CancellationToken, finished, confirm| Active {
        id: id.into(),
        cancel,
        finished,
        confirm,
        status: Status::Code {
            code: code.clone(),
            code_entry: true,
        },
    };
    let attempt = register(
        &manager,
        make_active("live", cancel.clone(), finished.clone(), tx),
    );
    // The payload is prepared and waits only for the phone's code.
    assert!(manager.bind_session(&attempt, &exchange.session));
    manager.close();
    let owner = manager.clone();
    let task = tokio::spawn(async move {
        let mut exchange = exchange;
        let mut socket = socket;
        let mut auth = relay::Authentication::default();
        let result = exchange_loop(
            ExchangeContext {
                pairing: &owner,
                attempt: &attempt,
                deadline: future(),
                relay_url: &url::Url::parse("wss://relay.test").unwrap(),
                pending: vec![],
            },
            &mut exchange,
            &mut socket,
            &mut auth,
            &mut rx,
        )
        .await;
        finished.cancel();
        result
    });
    server
        .send(tokio_tungstenite::tungstenite::Message::Text(
            serde_json::json!(["EVENT", "pair", request])
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    while let Some(Ok(frame)) = server.next().await {
        let Ok(text) = frame.to_text() else { continue };
        let json: serde_json::Value = serde_json::from_str(text).unwrap();
        let event = Event::from_json(json[1].to_string()).unwrap();
        let plaintext =
            nostr_pairing::nips::nip44::decrypt(target.secret_key(), &event.pubkey, &event.content)
                .unwrap();
        assert!(
            !matches!(
                serde_json::from_str::<PairingMessage>(&plaintext).unwrap(),
                PairingMessage::Payload { .. }
            ),
            "the key was published after sign-out"
        );
    }
    let ended = tokio::time::timeout(Duration::from_secs(2), task).await;
    assert!(ended.unwrap().unwrap().is_ok());
    // A start raced past the close is refused, not registered.
    let (tx, _) = mpsc::channel(1);
    let late = CancellationToken::new();
    assert!(manager
        .admit(
            make_active("late", late.clone(), CancellationToken::new(), tx),
            human(),
            b"https://relay.test".to_vec()
        )
        .is_err());
    assert!(manager.0.lock().unwrap().policy.outcome() == Outcome::Cancelled);
}

fn human() -> [u8; 32] {
    Keys::new(nostr_pairing::SecretKey::from_slice(&[1; 32]).unwrap())
        .public_key()
        .to_bytes()
}
fn prepared() -> identity::Prepared {
    let keys = Keys::new(nostr_pairing::SecretKey::from_slice(&[1; 32]).unwrap());
    let binding = buzz_pairing_policy::Custody::Ready(())
        .pairing_binding(human(), human(), b"https://relay.test".to_vec())
        .unwrap();
    identity::payload(
        &keys,
        &keys.public_key().to_hex(),
        "https://relay.test",
        binding,
    )
    .unwrap()
}

fn future() -> tokio::time::Instant {
    tokio::time::Instant::now() + Duration::from_secs(120)
}
fn active(id: &str, status: Status) -> Active {
    let (tx, _) = mpsc::channel(1);
    let finished = CancellationToken::new();
    finished.cancel();
    Active {
        id: id.into(),
        cancel: CancellationToken::new(),
        finished,
        confirm: tx,
        status,
    }
}
fn register(manager: &Pairing, active: Active) -> Attempt {
    manager
        .admit(active, human(), b"https://relay.test".to_vec())
        .unwrap()
}
fn visible(manager: &Pairing) -> Status {
    manager
        .0
        .lock()
        .unwrap()
        .active
        .as_ref()
        .unwrap()
        .status
        .clone()
}
fn try_grant(manager: &Pairing, attempt: &Attempt) -> Option<Release> {
    let (mut exchange, target, _, code) = entry();
    manager.bind_session(attempt, &exchange.session);
    let output = exchange
        .receive(&submission(&exchange, &target, &code, 1))
        .unwrap();
    let payload = output.payload.unwrap();
    manager.release(attempt, &payload, &exchange.session, future())
}
fn grant(manager: &Pairing, attempt: &Attempt) {
    assert!(try_grant(manager, attempt).is_some());
}

// The release clock is checked under the registry lock, independently of the
// protocol timer. Reusing the same proposal isolates each provenance guard.
#[tokio::test(start_paused = true)]
async fn release_checks_pinned_provenance_deadline_and_single_transfer() {
    for denial in [
        "human",
        "community",
        "session",
        "deadline",
        "revoked",
        "closed",
        "second",
    ] {
        let manager = Pairing::default();
        let (mut exchange, target, _, code) = entry();
        let pinned = if denial == "human" { [2; 32] } else { human() };
        let community = if denial == "community" {
            b"https://other.test".to_vec()
        } else {
            b"https://relay.test".to_vec()
        };
        let attempt = manager
            .admit(
                active("same-renderer-id", Status::Transferring),
                pinned,
                community,
            )
            .unwrap();
        if denial == "session" {
            let (other, _) = PairingSession::new_source("wss://relay.test".into());
            assert!(manager.bind_session(&attempt, &other));
        } else {
            assert!(manager.bind_session(&attempt, &exchange.session));
        }
        let output = exchange
            .receive(&submission(&exchange, &target, &code, 1))
            .unwrap();
        let payload = output.payload.unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        match denial {
            "deadline" => tokio::time::advance(Duration::from_secs(1)).await,
            "revoked" => manager.cancel_all(),
            "closed" => manager.close(),
            "second" => {
                assert!(manager
                    .release(&attempt, &payload, &exchange.session, deadline)
                    .is_some());
            }
            _ => {}
        }
        assert!(
            manager
                .release(&attempt, &payload, &exchange.session, deadline)
                .is_none(),
            "{denial} admitted a payload"
        );
    }
}

// Real TCP/WebSocket frames exercise the production custody -> crypto -> native
// grant -> AUTH replay -> authenticated success boundary in both product modes.
#[tokio::test]
async fn native_identity_socket_flow_replays_exact_ciphertext_and_requires_peer_success() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    for code_entry in [true, false] {
        let host = crate::identity::IdentityHost::fixture();
        let viewer = host.viewer().await.unwrap();
        let payload = identity::prepare(&host, viewer.clone(), "https://relay.test".into())
            .await
            .unwrap();
        let (session, qr) = PairingSession::new_source("wss://relay.test".into());
        let mut exchange = Exchange {
            session,
            payload: Some(payload),
            code_entry: false,
        };
        let target = Keys::generate();
        let offer = message(
            &target,
            &exchange.session,
            PairingMessage::Offer {
                session_id: hex::encode(crypto::derive_session_id(&qr.session_secret)),
                version: 1,
                confirmation: code_entry.then(|| "desktop-code-v1".into()),
            },
        );
        let output = exchange.receive(&offer).unwrap();
        let Some(Status::Code { code, .. }) = output.status else {
            panic!("missing code");
        };
        let request = submission(&exchange, &target, &code, 1);
        let completion = message(
            &target,
            &exchange.session,
            PairingMessage::Complete { success: true },
        );
        let ephemeral = exchange.session.pubkey();
        let (mut socket, mut server) = local_sockets().await;
        let (tx, mut rx) = mpsc::channel(1);
        let manager = Pairing::default();
        let attempt = register(
            &manager,
            Active {
                id: "socket-flow".into(),
                cancel: CancellationToken::new(),
                finished: CancellationToken::new(),
                confirm: tx.clone(),
                status: Status::Code { code, code_entry },
            },
        );
        assert!(manager.bind_session(&attempt, &exchange.session));
        let owner = manager.clone();
        let task = tokio::spawn(async move {
            exchange_loop(
                ExchangeContext {
                    pairing: &owner,
                    attempt: &attempt,
                    deadline: future(),
                    relay_url: &url::Url::parse("wss://relay.test").unwrap(),
                    pending: vec![],
                },
                &mut exchange,
                &mut socket,
                &mut relay::Authentication::default(),
                &mut rx,
            )
            .await
        });
        if code_entry {
            server
                .send(Message::Text(
                    serde_json::json!(["EVENT", "pair", request])
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
        } else {
            decide(&manager, "socket-flow", Decision::Confirm).unwrap();
        }
        let proof_frame = server.next().await.unwrap().unwrap();
        let proof_json: serde_json::Value =
            serde_json::from_str(proof_frame.to_text().unwrap()).unwrap();
        let proof = Event::from_json(proof_json[1].to_string()).unwrap();
        let first = server.next().await.unwrap().unwrap().into_text().unwrap();
        let frame: serde_json::Value = serde_json::from_str(&first).unwrap();
        assert_eq!(frame[0], "EVENT");
        let event = Event::from_json(frame[1].to_string()).unwrap();
        assert!(event.verify().is_ok());
        assert_eq!(event.pubkey, ephemeral);
        assert_ne!(event.pubkey.to_hex(), viewer);
        let plain = Zeroizing::new(
            nostr_pairing::nips::nip44::decrypt(target.secret_key(), &ephemeral, &event.content)
                .unwrap(),
        );
        let PairingMessage::Payload { payload: data, .. } = serde_json::from_str(&plain).unwrap()
        else {
            panic!("missing identity");
        };
        let identity: serde_json::Value = serde_json::from_str(&data).unwrap();
        assert_eq!(identity["pubkey"], viewer);
        assert_eq!(identity["relayUrl"], "https://relay.test");
        assert_eq!(
            Keys::parse(identity["nsec"].as_str().unwrap())
                .unwrap()
                .public_key()
                .to_hex(),
            viewer
        );
        // Retire the control proof, leaving the original admitted payload unacked.
        for value in [
            serde_json::json!(["OK", proof.id.to_hex(), true, ""]),
            serde_json::json!(["AUTH", "late-challenge"]),
        ] {
            server
                .send(Message::Text(value.to_string().into()))
                .await
                .unwrap();
        }
        let authentication = server.next().await.unwrap().unwrap();
        let authentication: serde_json::Value =
            serde_json::from_str(authentication.to_text().unwrap()).unwrap();
        assert_eq!(authentication[0], "AUTH");
        let authentication = Event::from_json(authentication[1].to_string()).unwrap();
        assert!(authentication.verify().is_ok());
        assert_eq!(authentication.pubkey, ephemeral);
        server
            .send(Message::Text(
                serde_json::json!(["OK", authentication.id.to_hex(), true, ""])
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let req = server.next().await.unwrap().unwrap();
        let req: serde_json::Value = serde_json::from_str(req.to_text().unwrap()).unwrap();
        assert_eq!(req[0], "REQ");
        assert_eq!(
            server.next().await.unwrap().unwrap().into_text().unwrap(),
            first
        );
        assert_ne!(
            visible(&manager),
            Status::Complete,
            "delivery receipt is not peer success"
        );
        server
            .send(Message::Text(
                serde_json::json!(["OK", event.id.to_hex(), true, ""])
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        server
            .send(Message::Text(
                serde_json::json!(["EVENT", "pair", completion])
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        assert!(task.await.unwrap().is_ok());
        assert_eq!(visible(&manager), Status::Complete);
    }
}

#[tokio::test]
async fn renderer_id_reuse_cannot_alias_a_retained_delivery_outcome() {
    let manager = Pairing::default();
    let attempt = register(&manager, active("retained", Status::Transferring));
    grant(&manager, &attempt);
    assert!(manager
        .admit(
            active("retained", Status::Connecting),
            human(),
            b"https://relay.test".to_vec()
        )
        .is_err());
    assert_eq!(manager.cancel("retained").await.unwrap(), Status::Uncertain);
    register(&manager, active("new", Status::Connecting));
    assert!(manager
        .admit(
            active("retained", Status::Connecting),
            human(),
            b"https://relay.test".to_vec()
        )
        .is_err());
    assert_eq!(manager.cancel("retained").await.unwrap(), Status::Uncertain);
    assert_eq!(
        manager.0.lock().unwrap().retired.get("retained"),
        Some(&Status::Uncertain)
    );
}
