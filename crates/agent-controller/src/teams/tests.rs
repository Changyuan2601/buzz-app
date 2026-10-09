use super::*;
use crate::{AgentEdit, Credentials, LegacySource, NewAgent, Secret, Store};
use std::{collections::BTreeMap, sync::Arc};

struct NoCredentials;
impl Credentials for NoCredentials {
    fn read(&self, _: &str, _: &str) -> Result<Option<Secret>> {
        panic!("preview/export must not read keys")
    }
    fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret> {
        panic!("bundles must not import legacy identities")
    }
    fn add(&self, _: &str, _: &Secret) -> Result<()> {
        panic!("controller tests do not persist keys")
    }
    fn delete(&self, _: &str, _: &str) -> Result<()> {
        panic!("bundles must not delete keys")
    }
}
fn controller(root: &std::path::Path) -> Controller {
    Controller::new(
        Store::open(root.join("store")).unwrap(),
        Arc::new(NoCredentials),
        Err("No fixture runtime".into()),
        root.join("ownership"),
    )
}
fn member() -> MemberSnapshot {
    snapshot_member(
        &crate::store::tests::fixture(),
        &crate::agent_defaults::AgentDefaults::default(),
    )
    .unwrap()
}
fn edit(root: &std::path::Path) -> AgentEdit {
    AgentEdit {
        name: "Fixture".into(),
        system_prompt: "INDIVIDUAL_MARKER".into(),
        picture: None,
        session_policy: Some(Some(SessionPolicy::Thread)),
        workspace: root.display().to_string(),
        harness: crate::store::tests::fixture().harness,
        environment: BTreeMap::new(),
    }
}
fn owner() -> String {
    let tag: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(&"ab".repeat(32))).unwrap();
    tag[1].clone()
}
#[test]
fn independent_imports_keep_prompts_separate_and_receipts_survive_reload() {
    let root = tempfile::tempdir().unwrap();
    let mut control = controller(root.path());
    let owner = owner();
    let first = NewAgent::prepare("https://relay.example/", &owner).unwrap();
    let second = NewAgent::prepare("wss://relay.example", &owner).unwrap();
    let mut snapshot = member();
    snapshot.definition.source_is_builtin = true;
    snapshot.profile.about = Some("Fixture profile".into());
    snapshot.definition.respond_to = Some("allowlist".into());
    snapshot.definition.respond_to_allowlist = vec!["ab".repeat(32)];
    for (request, prepared) in [("request-one", &first), ("request-two", &second)] {
        control
            .create_bundle_member(
                prepared,
                edit(root.path()),
                &crate::secret::test_attestation(prepared.key.pubkey()),
                request,
                &BundleMember {
                    team: "team-a".into(),
                    member: snapshot.clone(),
                    instructions: "TEAM_MARKER".into(),
                    keep_allowlist: false,
                },
            )
            .unwrap();
    }
    assert_ne!(first.key.pubkey(), second.key.pubkey());
    let agents = control.store.agents().unwrap();
    assert_eq!(agents.len(), 2);
    for agent in agents {
        assert_eq!(agent.system_prompt, "INDIVIDUAL_MARKER");
        assert_eq!(agent.imported["teamInstructions"], "TEAM_MARKER");
        assert_eq!(agent.respond_to(false).unwrap(), "owner-only");
        assert_eq!(agent.imported["record"]["respond_to_allowlist"], json!([]));
        assert!(!agent.enabled);
        assert!(!agent.starts_on_launch());
        assert_eq!(agent.selected_session_policy(), Some(SessionPolicy::Thread));
    }
    let exported = control
        .export_team(
            TeamMeta {
                name: "Roundtrip".into(),
                description: None,
                instructions: None,
            },
            &[first.key.pubkey().to_owned()],
            "wss://relay.example",
        )
        .unwrap();
    assert!(exported.members[0].definition.source_is_builtin);
    let target = control.creation_profile(&first.id).unwrap();
    let initial = target.event(&first.key, &[]).unwrap();
    assert_eq!(initial["kind"], 0);
    let initial_content: serde_json::Value =
        serde_json::from_str(initial["content"].as_str().unwrap()).unwrap();
    assert_eq!(initial_content["about"], "Fixture profile");
    let prior = first
        .key
        .profile(
            "Fixture",
            Some("https://example.test/avatar.png"),
            Some("stale about"),
            &target.auth,
            &[],
        )
        .unwrap();
    let retried = target.event(&first.key, &[prior]).unwrap();
    let retried_content: serde_json::Value =
        serde_json::from_str(retried["content"].as_str().unwrap()).unwrap();
    assert_eq!(retried_content["about"], "Fixture profile");
    assert_eq!(
        retried_content["picture"],
        "https://example.test/avatar.png"
    );
    control
        .profile_published(&first.id, target.revision)
        .unwrap();
    // Subsequent avatar writes do not restore the original import description.
    let avatar = control.memory_target(&first.id).unwrap();
    assert!(avatar.about.is_none());
    assert!(control.creation_profile(&first.id).is_err());
    let external = first
        .key
        .profile(
            "Fixture",
            None,
            Some("Updated elsewhere"),
            &target.auth,
            &[retried],
        )
        .unwrap();
    let avatar_event = avatar.event(&first.key, &[external]).unwrap();
    let avatar_content: serde_json::Value =
        serde_json::from_str(avatar_event["content"].as_str().unwrap()).unwrap();
    assert_eq!(avatar_content["about"], "Updated elsewhere");
    assert_eq!(
        exported.members[0].profile.about.as_deref(),
        Some("Fixture profile")
    );
    drop(control);
    let mut control = controller(root.path());
    assert_eq!(
        control
            .created_request("request-one", "https://RELAY.example/", &owner)
            .unwrap()
            .unwrap()
            .id,
        first.id
    );
    assert!(control
        .created_request("request-one", "wss://other.example", &owner)
        .is_err());
    assert!(control
        .created_request("request-one", "wss://relay.example", &"ab".repeat(32))
        .is_err());
    // A retry with a new prepared identity still recovers the original saved receipt.
    control
        .create_bundle_member(
            &second,
            edit(root.path()),
            &crate::secret::test_attestation(second.key.pubkey()),
            "request-one",
            &BundleMember {
                team: "team-a".into(),
                member: snapshot.clone(),
                instructions: "TEAM_MARKER".into(),
                keep_allowlist: false,
            },
        )
        .unwrap();
    assert_eq!(control.store.agents().unwrap().len(), 2);
}
#[test]
fn export_uses_effective_workers_for_native_and_edited_imported_agents() {
    let root = tempfile::tempdir().unwrap();
    let mut control = controller(root.path());
    let mut native = crate::store::tests::fixture();
    native.harness.model.clear();
    native.harness.provider.clear();
    let defaults = crate::agent_defaults::AgentDefaults {
        model: "inherited-model".into(),
        provider: "inherited-provider".into(),
        session_policy: SessionPolicy::Channel,
        ..Default::default()
    };
    control.store.save_defaults(&defaults).unwrap();
    let mut imported = native.clone();
    imported.pubkey = "cd".repeat(32);
    imported.id = crate::config::agent_id(&imported.pubkey, &imported.relay_url);
    imported.imported = json!({"record": {"parallelism": 3}});
    control
        .store
        .insert(vec![native.clone(), imported.clone()])
        .unwrap();
    let export = |control: &Controller, key: &str| {
        control
            .export_team(
                TeamMeta {
                    name: "Workers".into(),
                    description: None,
                    instructions: None,
                },
                &[key.to_owned()],
                "wss://relay.example",
            )
            .unwrap()
            .members
            .remove(0)
            .definition
            .parallelism
    };
    assert_eq!(export(&control, &native.pubkey), Some(1));
    assert_eq!(export(&control, &imported.pubkey), Some(3));
    let inherited = control
        .export_team(
            TeamMeta {
                name: "Inherited".into(),
                description: None,
                instructions: None,
            },
            &[native.pubkey.clone()],
            &native.relay_url,
        )
        .unwrap();
    assert_eq!(
        inherited.members[0].definition.model.as_deref(),
        Some("inherited-model")
    );
    assert_eq!(
        inherited.members[0].definition.provider.as_deref(),
        Some("inherited-provider")
    );
    assert_eq!(
        inherited.members[0].definition.session_policy,
        SessionPolicy::Channel
    );
    native
        .environment
        .insert("BUZZ_ACP_AGENTS".into(), "7".into());
    imported
        .environment
        .insert("BUZZ_ACP_AGENTS".into(), "5".into());
    control.store.remove(&native.id, native.revision).unwrap();
    control
        .store
        .remove(&imported.id, imported.revision)
        .unwrap();
    control
        .store
        .insert(vec![native.clone(), imported.clone()])
        .unwrap();
    assert_eq!(export(&control, &native.pubkey), Some(7));
    assert_eq!(export(&control, &imported.pubkey), Some(5));
}

#[test]
fn export_is_portable_and_preview_does_not_create_or_start_agents() {
    let root = tempfile::tempdir().unwrap();
    let mut control = controller(root.path());
    let source = crate::store::tests::fixture();
    control.store.insert(vec![source.clone()]).unwrap();
    let exported = control
        .export_team(
            TeamMeta {
                name: "Fixture team".into(),
                description: Some("Safe fixtures".into()),
                instructions: Some("TEAM_MARKER".into()),
            },
            std::slice::from_ref(&source.pubkey),
            &source.relay_url,
        )
        .unwrap();
    let bytes = serde_json::to_vec(&exported).unwrap();
    let text = String::from_utf8(bytes.clone()).unwrap();
    for private in [
        &source.pubkey,
        &source.credential_id,
        &source.workspace,
        "secret-env-value",
        "private-attestation",
        "futureTopLevel",
    ] {
        assert!(!text.contains(private), "leaked {private}");
    }
    let decoded = TeamSnapshot::decode(&bytes).unwrap();
    assert_eq!(decoded.team.instructions.as_deref(), Some("TEAM_MARKER"));
    assert_eq!(
        decoded.members[0].definition.system_prompt.as_deref(),
        Some(source.system_prompt.as_str())
    );
    assert_eq!(decoded.members[0].memory.level, "none");
    assert_eq!(control.store.agents().unwrap().len(), 1);
    assert!(!control.store.agents().unwrap()[0].enabled);
}
#[test]
fn memory_preview_bounds_slugs_duplicates_and_selected_level() {
    let mut memory = Memory {
        level: "core".into(),
        entries: vec![MemoryEntry {
            slug: "core".into(),
            body: "safe fixture".into(),
        }],
    };
    memory.validate().unwrap();
    memory.entries.push(memory.entries[0].clone());
    assert!(memory.validate().is_err());
    memory.entries.pop();
    memory.entries[0].slug = "mem/note".into();
    assert!(memory.validate().is_err());
    memory.level = "everything".into();
    memory.validate().unwrap();
    for slug in ["mem/../note", "mem/Note", "mem/", "mem/a//b", "private"] {
        memory.entries[0].slug = slug.into();
        assert!(memory.validate().is_err(), "{slug}");
    }
    memory.entries[0].slug = "core".into();
    memory.entries[0].body = "x".repeat(1024 * 1024);
    assert!(memory.validate().is_err());
}

#[test]
fn malformed_snapshots_are_rejected_before_creation() {
    let mut snapshot = TeamSnapshot {
        format: "buzz-team-snapshot".into(),
        version: 1,
        team: TeamMeta {
            name: "Fixture".into(),
            description: None,
            instructions: None,
        },
        members: vec![member()],
    };
    snapshot.validate().unwrap();
    snapshot.members[0].memory.entries.push(MemoryEntry {
        slug: "core".into(),
        body: "Fixture".into(),
    });
    assert!(snapshot.validate().is_err());
    snapshot.members[0].memory.entries.clear();
    snapshot.members[0].definition.runtime = Some("/private/local/executable".into());
    assert!(snapshot.validate().is_err());
    snapshot.members[0].definition.runtime = None;
    snapshot.team.instructions = Some("bad\0instructions".into());
    assert!(snapshot.validate().is_err());
}

#[test]
fn deployment_instruction_updates_preserve_identity_and_individual_settings() {
    let root = tempfile::tempdir().unwrap();
    let mut control = controller(root.path());
    let prepared = NewAgent::prepare("https://relay.example/", &owner()).unwrap();
    control
        .create_bundle_member(
            &prepared,
            edit(root.path()),
            &crate::secret::test_attestation(prepared.key.pubkey()),
            "request",
            &BundleMember {
                team: "team-a".into(),
                member: member(),
                instructions: "OLD_TEAM".into(),
                keep_allowlist: false,
            },
        )
        .unwrap();
    let before = control.store.agents().unwrap().remove(0);
    for instructions in ["", "UNRELATED"] {
        assert!(control
            .apply_team_instructions(
                &before.id,
                before.revision,
                instructions,
                &owner(),
                ("team-b", "https://relay.example")
            )
            .is_err());
    }
    assert_eq!(
        control.store.agents().unwrap()[0].imported["teamInstructions"],
        "OLD_TEAM"
    );
    assert!(!control
        .apply_team_instructions(
            &before.id,
            before.revision,
            "OLD_TEAM",
            &owner(),
            ("team-a", "https://relay.example")
        )
        .unwrap());

    assert!(control
        .apply_team_instructions(
            &before.id,
            before.revision,
            "NEW_TEAM",
            &"ab".repeat(32),
            ("team-a", "https://relay.example")
        )
        .is_err());
    assert!(control
        .apply_team_instructions(
            &before.id,
            before.revision + 1,
            "NEW_TEAM",
            &owner(),
            ("team-a", "https://relay.example")
        )
        .is_err());
    assert!(control
        .apply_team_instructions(
            &before.id,
            before.revision,
            "NEW_TEAM",
            &owner(),
            ("team-a", "https://relay.example")
        )
        .unwrap());
    assert!(control
        .apply_team_instructions(
            &before.id,
            before.revision + 1,
            "OTHER_TEAM",
            &owner(),
            ("team-b", "https://relay.example")
        )
        .is_err());
    assert!(control
        .apply_team_instructions(
            &before.id,
            before.revision + 1,
            "NEW_TEAM",
            &owner(),
            ("team-a", "https://foreign.example")
        )
        .is_err());
    let after = control.store.agents().unwrap().remove(0);
    assert_eq!(after.pubkey, before.pubkey);
    assert_eq!(after.credential_id, before.credential_id);
    assert_eq!(after.system_prompt, before.system_prompt);
    assert_eq!(after.harness.command, before.harness.command);
    assert_eq!(after.environment, before.environment);
    assert_eq!(after.imported["record"], before.imported["record"]);
    assert_eq!(after.imported["teamInstructions"], "NEW_TEAM");
    assert_eq!(after.revision, before.revision + 1);
    assert!(!after.enabled);
    assert!(!control
        .apply_team_instructions(
            &after.id,
            after.revision,
            "  NEW_TEAM\n",
            &owner(),
            ("team-a", "https://relay.example")
        )
        .unwrap());
    assert!(control
        .apply_team_instructions(
            &after.id,
            after.revision,
            "OTHER_TEAM",
            &owner(),
            ("team-b", "https://relay.example")
        )
        .is_err());
    assert_eq!(
        control.store.agents().unwrap()[0].imported["teamInstructions"],
        "NEW_TEAM"
    );
    drop(control);
    let mut control = controller(root.path());
    assert!(control
        .apply_team_instructions(
            &after.id,
            after.revision,
            "OTHER_TEAM",
            &owner(),
            ("team-b", "https://relay.example")
        )
        .is_err());

    assert!(!control
        .apply_team_instructions(
            &after.id,
            after.revision,
            "NEW_TEAM",
            &owner(),
            ("team-a", "https://relay.example")
        )
        .unwrap());
    assert_eq!(control.store.agents().unwrap()[0].revision, after.revision);
}

#[test]
fn memory_authorization_requires_exact_saved_owner_and_valid_member_attestation() {
    let root = tempfile::tempdir().unwrap();
    let mut control = controller(root.path());
    let prepared = NewAgent::prepare("https://relay.example/", &owner()).unwrap();
    let auth = crate::secret::test_attestation(prepared.key.pubkey());
    control
        .create_bundle_member(
            &prepared,
            edit(root.path()),
            &auth,
            "memory-owner",
            &BundleMember {
                team: "team-a".into(),
                member: member(),
                instructions: "TEAM".into(),
                keep_allowlist: false,
            },
        )
        .unwrap();
    assert_eq!(
        control
            .team_member_authorization(&prepared.id, &owner())
            .unwrap(),
        auth
    );
    assert!(control
        .verify_team_member_owner(&prepared.id, &"ab".repeat(32))
        .is_err());
    assert!(control
        .team_member_authorization(&prepared.id, &"ab".repeat(32))
        .is_err());
    assert!(control
        .team_member_authorization("missing", &owner())
        .is_err());
    let mut saved = control.store.agents().unwrap();
    saved[0].auth_tag = Some(json!(["auth", owner(), "", "invalid-signature"]).to_string());
    std::fs::write(
        root.path().join("store/agents.json"),
        serde_json::to_vec(&json!({"version": 1, "agents": saved})).unwrap(),
    )
    .unwrap();
    drop(control);
    let control = controller(root.path());
    assert!(control
        .team_member_authorization(&prepared.id, &owner())
        .is_err());
}

#[test]
fn legacy_unbound_instructions_require_matching_adoption_before_changes() {
    let root = tempfile::tempdir().unwrap();
    let mut control = controller(root.path());
    let mut source = crate::store::tests::fixture();
    source.imported = serde_json::json!({"teamInstructions": "LEGACY"});
    control.store.insert(vec![source.clone()]).unwrap();
    assert!(control
        .store
        .team_instructions(&source.id, source.revision, "", "unrelated")
        .is_err());
    assert!(!control
        .store
        .team_instructions(&source.id, source.revision, " LEGACY ", "original")
        .unwrap());
    assert!(control
        .store
        .team_instructions(&source.id, source.revision, "UPDATED", "original")
        .unwrap());
}

#[test]
fn catalog_removal_releases_only_obsolete_bindings_and_preserves_pending_imports() {
    let root = tempfile::tempdir().unwrap();
    let mut control = controller(root.path());
    let prepared = NewAgent::prepare("https://relay.example", &owner()).unwrap();
    control
        .create_bundle_member(
            &prepared,
            edit(root.path()),
            &crate::secret::test_attestation(prepared.key.pubkey()),
            "lifecycle",
            &BundleMember {
                team: "team-a".into(),
                member: member(),
                instructions: "SHARED".into(),
                keep_allowlist: false,
            },
        )
        .unwrap();
    let agent = control.store.agents().unwrap().remove(0);
    let mut teams = std::collections::BTreeMap::new();
    control
        .reconcile_team_bindings("https://relay.example", &owner(), &teams)
        .unwrap();
    assert!(control
        .apply_team_instructions(
            &agent.id,
            agent.revision,
            "OTHER",
            &owner(),
            ("team-b", "https://relay.example")
        )
        .is_err());
    // A second active team sharing the same instructions retains protection.
    assert!(!control
        .apply_team_instructions(
            &agent.id,
            agent.revision,
            "SHARED",
            &owner(),
            ("team-c", "https://relay.example")
        )
        .unwrap());
    teams.insert("team-a".into(), catalog(1, vec![])); // deletion or removal
    teams.insert("team-c".into(), catalog(1, vec![agent.pubkey.clone()]));
    control
        .reconcile_team_bindings("https://relay.example", &owner(), &teams)
        .unwrap();
    assert!(control
        .apply_team_instructions(
            &agent.id,
            agent.revision,
            "OTHER",
            &owner(),
            ("team-b", "https://relay.example")
        )
        .is_err());
    teams.insert("team-c".into(), catalog(2, vec![]));
    control
        .reconcile_team_bindings("https://foreign.example", &owner(), &teams)
        .unwrap();
    control
        .reconcile_team_bindings("https://relay.example", &"ab".repeat(32), &teams)
        .unwrap();
    assert_eq!(
        control.store.agents().unwrap()[0].imported["teamBindings"],
        serde_json::json!(["team-c"])
    );
    control
        .reconcile_team_bindings("https://relay.example", &owner(), &teams)
        .unwrap();
    drop(control);
    let mut control = controller(root.path());
    assert!(control
        .apply_team_instructions(
            &agent.id,
            agent.revision,
            "RECREATED",
            &owner(),
            ("team-new", "https://relay.example")
        )
        .unwrap());
    assert_eq!(
        control.store.agents().unwrap()[0].imported["teamBindings"],
        serde_json::json!(["team-new"])
    );
}

fn catalog(created_at: u64, members: Vec<String>) -> crate::TeamCatalogEntry {
    crate::TeamCatalogEntry {
        created_at,
        event_id: format!("{created_at:064x}"),
        members,
    }
}

#[test]
fn late_catalog_removal_cannot_erase_a_newer_live_binding_even_after_reopen() {
    let root = tempfile::tempdir().unwrap();
    let mut control = controller(root.path());
    let prepared = NewAgent::prepare("https://relay.example", &owner()).unwrap();
    control
        .create_bundle_member(
            &prepared,
            edit(root.path()),
            &crate::secret::test_attestation(prepared.key.pubkey()),
            "ordering",
            &BundleMember {
                team: "team-a".into(),
                member: member(),
                instructions: "SHARED".into(),
                keep_allowlist: false,
            },
        )
        .unwrap();
    let agent = control.store.agents().unwrap().remove(0);
    let old = std::collections::BTreeMap::from([("team-a".into(), catalog(1, vec![]))]);
    let fresh = std::collections::BTreeMap::from([
        ("team-a".into(), catalog(2, vec![agent.pubkey.clone()])),
        ("team-b".into(), catalog(2, vec![agent.pubkey.clone()])),
    ]);
    control
        .reconcile_team_bindings("https://relay.example", &owner(), &fresh)
        .unwrap();
    control
        .apply_team_instructions(
            &agent.id,
            agent.revision,
            "SHARED",
            &owner(),
            ("team-a", "https://relay.example"),
        )
        .unwrap();
    drop(control);
    let mut control = controller(root.path());
    assert!(control
        .reconcile_team_bindings("https://relay.example", &owner(), &old)
        .is_err());
    control
        .reconcile_team_bindings("https://relay.example", &owner(), &fresh)
        .unwrap();
    assert!(control
        .apply_team_instructions(
            &agent.id,
            agent.revision,
            "OTHER",
            &owner(),
            ("team-b", "https://relay.example")
        )
        .is_err());
    assert_eq!(
        control.store.agents().unwrap()[0].imported["teamBindings"],
        serde_json::json!(["team-a"])
    );
    // Same timestamp uses the NIP-01 lower-event-ID winner; a late loser is refused.
    let mut winner = fresh.clone();
    winner.get_mut("team-a").unwrap().event_id = "00".repeat(32);
    control
        .reconcile_team_bindings("https://relay.example", &owner(), &winner)
        .unwrap();
    assert!(control
        .reconcile_team_bindings("https://relay.example", &owner(), &fresh)
        .is_err());
}

#[test]
fn maximal_native_member_settings_survive_the_creation_receipt_and_reopen() {
    let root = tempfile::tempdir().unwrap();
    let mut control = controller(root.path());
    let prepared = NewAgent::prepare("https://relay.example", &owner()).unwrap();
    let mut snapshot = member();
    snapshot.definition.name = "N".repeat(256);
    snapshot.profile.display_name = snapshot.definition.name.clone();
    snapshot.profile.about = Some("é\"\\\n".repeat(1024));
    snapshot.definition.system_prompt = Some("é".repeat(64 * 1024));
    snapshot.definition.respond_to = Some("allowlist".into());
    snapshot.definition.respond_to_allowlist = (0..2000).map(|n| format!("{n:064x}")).collect();
    snapshot.definition.name_pool = vec!["N".repeat(256); 256];
    snapshot.definition.parallelism = Some(32);
    snapshot.definition.idle_timeout_seconds = Some(86400);
    snapshot.definition.max_turn_duration_seconds = Some(86400);
    snapshot.definition.model = Some("M".repeat(512));
    snapshot.definition.provider = Some("P".repeat(128));
    snapshot.profile.avatar_url = Some("https://example.test/picture?size=2#avatar".into());
    let bundle = BundleMember {
        team: "maximal-team".into(),
        member: snapshot.clone(),
        instructions: "S".repeat(128 * 1024),
        keep_allowlist: true,
    };
    let mut mapped = edit(root.path());
    mapped.name = snapshot.profile.display_name.clone();
    mapped.system_prompt = snapshot.definition.system_prompt.clone().unwrap();
    mapped.harness.model = snapshot.definition.model.clone().unwrap();
    mapped.harness.provider = snapshot.definition.provider.clone().unwrap();
    mapped.picture = snapshot.profile.avatar_url.clone();
    control
        .create_bundle_member(
            &prepared,
            mapped,
            &crate::secret::test_attestation(prepared.key.pubkey()),
            "maximal-request",
            &bundle,
        )
        .unwrap();
    drop(control);
    let control = controller(root.path());
    let agent = control.store.agents().unwrap().remove(0);
    assert_eq!(
        agent.system_prompt,
        snapshot.definition.system_prompt.unwrap()
    );
    assert_eq!(agent.harness.model, snapshot.definition.model.unwrap());
    assert_eq!(
        agent.harness.provider,
        snapshot.definition.provider.unwrap()
    );
    assert_eq!(agent.picture, snapshot.profile.avatar_url);
    assert_eq!(agent.imported["teamInstructions"], bundle.instructions);
    let record = &agent.imported["record"];
    assert_eq!(record["respond_to"], "allowlist");
    assert_eq!(
        record["respond_to_allowlist"],
        json!(snapshot.definition.respond_to_allowlist)
    );
    assert_eq!(record["name_pool"], json!(snapshot.definition.name_pool));
    assert_eq!(record["parallelism"], 32);
    assert_eq!(record["idle_timeout_seconds"], 86400);
    assert_eq!(record["max_turn_duration_seconds"], 86400);
    assert_eq!(record["profile"]["about"], json!(snapshot.profile.about));
    assert_eq!(agent.extra["bundleRequest"], "maximal-request");
    assert!(!agent.enabled);
    assert!(!agent.starts_on_launch());
}

#[test]
fn profile_content_bound_preflights_every_member_and_roundtrips_at_boundary() {
    let root = tempfile::tempdir().unwrap();
    let mut control = controller(root.path());
    let mut snapshot = TeamSnapshot {
        format: "buzz-team-snapshot".into(),
        version: 1,
        team: TeamMeta {
            name: "Boundary".into(),
            description: None,
            instructions: None,
        },
        members: vec![member(), member()],
    };
    let name = snapshot.members[1].profile.display_name.clone();
    let empty_bytes = crate::profile::initial_content(&name, None, None)
        .unwrap()
        .len();
    // Escaped quotes cost two bytes each, unlike the raw about length.
    let about = format!(
        "{}a",
        "\"".repeat((crate::profile::MAX_PROFILE_CONTENT_BYTES - empty_bytes - 11) / 2)
    );
    snapshot.members[1].profile.about = Some(about);
    let content =
        crate::profile::initial_content(&name, snapshot.members[1].profile.about.as_deref(), None)
            .unwrap();
    assert_eq!(content.len(), crate::profile::MAX_PROFILE_CONTENT_BYTES);
    let bytes = serde_json::to_vec(&snapshot).unwrap();
    let decoded = TeamSnapshot::decode(&bytes).unwrap();
    let prepared = NewAgent::prepare("https://relay.example", &owner()).unwrap();
    let mut mapped = edit(root.path());
    mapped.name = name.clone();
    control
        .create_bundle_member(
            &prepared,
            mapped,
            &crate::secret::test_attestation(prepared.key.pubkey()),
            "boundary",
            &BundleMember {
                team: "boundary".into(),
                member: decoded.members[1].clone(),
                instructions: String::new(),
                keep_allowlist: false,
            },
        )
        .unwrap();
    let target = control.creation_profile(&prepared.id).unwrap();
    let event = target.event(&prepared.key, &[]).unwrap();
    assert_eq!(
        event["content"].as_str().unwrap().len(),
        crate::profile::MAX_PROFILE_CONTENT_BYTES
    );
    target
        .confirm(std::slice::from_ref(&event), event["id"].as_str().unwrap())
        .unwrap();
    control
        .profile_published(&prepared.id, target.revision)
        .unwrap();
    assert!(control.creation_profile(&prepared.id).is_err());

    snapshot.members[1]
        .profile
        .about
        .as_mut()
        .unwrap()
        .push('"');
    assert!(TeamSnapshot::decode(&serde_json::to_vec(&snapshot).unwrap()).is_err());
    let clean_root = tempfile::tempdir().unwrap();
    assert!(controller(clean_root.path())
        .store
        .agents()
        .unwrap()
        .is_empty());
    // Even a direct bundle create refuses the oversized member before insertion.
    let mut clean_control = controller(clean_root.path());
    let prepared = NewAgent::prepare("https://relay.example", &owner()).unwrap();
    assert!(clean_control
        .create_bundle_member(
            &prepared,
            edit(clean_root.path()),
            &crate::secret::test_attestation(prepared.key.pubkey()),
            "rejected",
            &BundleMember {
                team: "boundary".into(),
                member: snapshot.members[1].clone(),
                instructions: String::new(),
                keep_allowlist: false,
            },
        )
        .is_err());
    assert!(clean_control.store.agents().unwrap().is_empty());
}

#[test]
fn native_export_rejects_unrepresentable_runtime_settings_without_leaking_values() {
    let mut agent = crate::store::tests::fixture();
    let defaults = crate::agent_defaults::AgentDefaults::default();
    let exported = snapshot_member(&agent, &defaults).unwrap();
    let decoded = TeamSnapshot::decode(
        &serde_json::to_vec(&TeamSnapshot {
            format: "buzz-team-snapshot".into(),
            version: 1,
            team: TeamMeta {
                name: "Safe".into(),
                description: None,
                instructions: None,
            },
            members: vec![exported.clone()],
        })
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        decoded.members[0].definition.runtime.as_deref(),
        Some("buzz-agent")
    );
    assert_eq!(
        decoded.members[0].definition.model.as_deref(),
        Some("test-model")
    );
    agent.harness.command = "/opt/private/buzz-agent.exe".into();
    assert_eq!(
        snapshot_member(&agent, &defaults)
            .unwrap()
            .definition
            .runtime
            .as_deref(),
        Some("buzz-agent")
    );
    agent.harness.command = "/opt/private/local-worker".into();
    assert!(snapshot_member(&agent, &defaults)
        .unwrap_err()
        .contains("harness"));
    agent.harness.command = "buzz-agent".into();
    agent.imported["record"]["effort_level"] = json!("high");
    assert!(snapshot_member(&agent, &defaults)
        .unwrap_err()
        .contains("effort"));
    agent.imported["record"]["effort_level"] = serde_json::Value::Null;
    let mut inherited = defaults.clone();
    inherited.effort = "high".into();
    assert!(snapshot_member(&agent, &inherited)
        .unwrap_err()
        .contains("effort"));
    agent
        .environment
        .insert("BUZZ_AGENT_MODEL".into(), "synthetic-secret-model".into());
    let error = snapshot_member(&agent, &defaults).err().unwrap();
    assert!(error.contains("environment-selected"));
    assert!(!error.contains("synthetic-secret-model"));
    agent.environment.clear();
    agent.environment.insert(
        "BUZZ_AGENT_PROVIDER".into(),
        "synthetic-secret-provider".into(),
    );
    assert!(snapshot_member(&agent, &defaults)
        .unwrap_err()
        .contains("environment-selected"));
}

#[test]
fn native_export_rejects_effective_pi_goose_effort_without_leaking_values() {
    let mut agent = crate::store::tests::fixture();
    let mut defaults = crate::agent_defaults::AgentDefaults::default();
    for (harness, command) in [("pi", "buzz-pi-acp"), ("goose", "goose")] {
        agent.harness.command = command.into();
        agent.harness.model.clear();
        agent.harness.provider.clear();
        agent.environment.clear();
        defaults.environment.clear();
        let exported = snapshot_member(&agent, &defaults).unwrap();
        assert_eq!(exported.definition.runtime.as_deref(), Some(harness));

        agent.environment.insert(
            "BUZZ_ACP_EFFORT_LEVEL".into(),
            "private-agent-effort".into(),
        );
        let error = snapshot_member(&agent, &defaults).unwrap_err();
        assert!(error.contains("effort") && !error.contains("private-agent-effort"));

        agent.environment.clear();
        defaults.environment.insert(
            "BUZZ_ACP_EFFORT_LEVEL".into(),
            "private-inherited-effort".into(),
        );
        let error = snapshot_member(&agent, &defaults).unwrap_err();
        assert!(error.contains("effort") && !error.contains("private-inherited-effort"));
    }
}

#[test]
fn merged_existing_profile_overflow_keeps_import_about_pending() {
    let root = tempfile::tempdir().unwrap();
    let mut control = controller(root.path());
    let prepared = NewAgent::prepare("https://relay.example", &owner()).unwrap();
    let mut snapshot = member();
    snapshot.profile.about = Some("new about".into());
    control
        .create_bundle_member(
            &prepared,
            edit(root.path()),
            &crate::secret::test_attestation(prepared.key.pubkey()),
            "merged",
            &BundleMember {
                team: "merged".into(),
                member: snapshot,
                instructions: String::new(),
                keep_allowlist: false,
            },
        )
        .unwrap();
    let target = control.creation_profile(&prepared.id).unwrap();
    let existing = prepared
        .key
        .profile(
            "Fixture",
            None,
            Some(&"x".repeat(crate::profile::MAX_PROFILE_CONTENT_BYTES - 160)),
            &target.auth,
            &[],
        )
        .unwrap();
    // Updating about with escaped characters grows the full merged map while
    // retaining the verified existing profile's other fields.
    let target = crate::CreationProfile {
        about: Some("\"".repeat(crate::profile::MAX_PROFILE_CONTENT_BYTES / 2)),
        ..target
    };
    assert!(target
        .event(&prepared.key, &[existing])
        .unwrap_err()
        .contains("readable limit"));
    assert!(control.creation_profile(&prepared.id).is_ok());
}
