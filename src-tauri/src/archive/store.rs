use super::Result;
use crate::relay::agent::AgentEvent;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::PathBuf;

pub(super) struct Store(Connection, i64, PathBuf);
pub(super) struct CaptureSettings {
    pub observer: bool,
    pub metrics: bool,
    pub days: u32,
    /// 0 keeps metrics until a byte cap or clear removes them.
    pub metrics_days: u32,
    pub revision: i64,
}
type StoredRow = (i64, i64, String);
/// Metrics kept for a year of a busy agent; see docs/agents.md for the sizing.
const METRICS_BUDGET: i64 = 1024 * 1024 * 1024;
pub(super) const BACKFILL_BATCH: i64 = 64;
fn database<T>(result: rusqlite::Result<T>) -> Result<T> {
    result.map_err(|_| "Local archive storage failed; retry without deleting the archive".into())
}
fn valid_kind(kind: u16) -> Result<()> {
    if matches!(kind, 24200 | 44200) {
        Ok(())
    } else {
        Err("Unsupported archive kind".into())
    }
}
impl Store {
    pub(super) fn open(path: PathBuf) -> Result<Self> {
        let parent = path.parent().ok_or("Archive location unavailable")?;
        std::fs::create_dir_all(parent).map_err(|_| "Archive directory unavailable")?;
        let connection = database(Connection::open(&path))?;
        database(connection.busy_timeout(std::time::Duration::from_secs(2)))?;
        // On a new database auto-vacuum must be configured before BEGIN creates
        // its header. Switching from NONE only sets a connection flag: existing
        // databases cannot change mode without VACUUM, which we never run here.
        let vacuum: u32 = database(connection.query_row("PRAGMA auto_vacuum", [], |r| r.get(0)))?;
        if vacuum == 0 {
            database(connection.execute_batch("PRAGMA auto_vacuum=INCREMENTAL"))?;
        }
        // Lock before checking the version. An older process may wait behind a
        // migration, but must never downgrade or otherwise mutate a newer file.
        database(connection.execute_batch("BEGIN IMMEDIATE"))?;
        let version: u32 = database(connection.query_row("PRAGMA user_version", [], |r| r.get(0)))?;
        if version > 3 {
            database(connection.execute_batch("ROLLBACK"))?;
            return Err("Archive was created by a newer app".into());
        }
        // schema.sql is the v2 baseline; every older file then gains v3.
        if version == 0 {
            database(
                connection.execute_batch(include_str!("../../../src/features/archive/schema.sql")),
            )?;
        } else if version == 1 {
            database(
                connection
                    .execute_batch(include_str!("../../../src/features/archive/migrate-v2.sql")),
            )?;
        }
        if version < 3 {
            database(
                connection
                    .execute_batch(include_str!("../../../src/features/archive/migrate-v3.sql")),
            )?;
        }
        database(connection.execute_batch(
            "PRAGMA user_version=3; COMMIT; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;",
        ))?;
        Ok(Self(connection, 0, path))
    }

    pub(super) fn seed(&self, viewer: &str, community: &str) -> Result<()> {
        database(self.0.execute(
            "INSERT OR IGNORE INTO archive_partitions(viewer,community) VALUES (?1,?2)",
            params![viewer, community],
        ))?;
        for (name, days, budget) in [
            ("observer", 30, 512 * 1024 * 1024),
            ("metrics", 365, METRICS_BUDGET),
        ] {
            database(self.0.execute("INSERT OR IGNORE INTO archive_subscriptions(viewer,community,name,days,budget) VALUES (?1,?2,?3,?4,?5)",params![viewer,community,name,days,budget]))?;
        }
        Ok(())
    }
    fn revision(&self, viewer: &str, community: &str) -> Result<i64> {
        database(self.0.query_row(
            "SELECT revision FROM archive_partitions WHERE viewer=?1 AND community=?2",
            params![viewer, community],
            |r| r.get(0),
        ))
    }
    pub(super) fn settings(&self, viewer: &str, community: &str) -> Result<Value> {
        // One statement is one SQLite snapshot: values and CAS revision cannot tear.
        database(self.0.query_row(
            "SELECT o.enabled,o.days,m.enabled,m.days,p.revision,(SELECT COALESCE(SUM(bytes),0) FROM archive_usage WHERE viewer=p.viewer AND community=p.community AND agent='') FROM archive_partitions p JOIN archive_subscriptions o USING(viewer,community) JOIN archive_subscriptions m USING(viewer,community) WHERE p.viewer=?1 AND p.community=?2 AND o.name='observer' AND m.name='metrics'",
            params![viewer, community],
            |r| Ok(json!({"observer":r.get::<_,bool>(0)?,"observerDays":r.get::<_,u32>(1)?,"metrics":r.get::<_,bool>(2)?,"metricsDays":r.get::<_,u32>(3)?,"revision":r.get::<_,i64>(4)?,"location":"device","path":self.2.to_string_lossy(),"bytes":r.get::<_,i64>(5)?})),
        ))
    }
    pub(super) fn configure(
        &mut self,
        viewer: &str,
        community: &str,
        settings: CaptureSettings,
        now: i64,
    ) -> Result<Value> {
        let CaptureSettings {
            observer,
            metrics,
            days,
            metrics_days,
            revision,
        } = settings;
        if !(1..=90).contains(&days) {
            return Err("Observer retention must be 1 to 90 days".into());
        }
        if !matches!(metrics_days, 0 | 90 | 365) {
            return Err("Metrics retention must be 90 days, 1 year or forever".into());
        }
        let tx = database(
            self.0
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate),
        )?;
        let changed = database(tx.execute("UPDATE archive_partitions SET revision=revision+1 WHERE viewer=?1 AND community=?2 AND revision=?3",params![viewer,community,revision]))?;
        if changed != 1 {
            return Err("Archive settings changed; reload and retry".into());
        }
        database(tx.execute("UPDATE archive_subscriptions SET enabled=?3, days=?4 WHERE viewer=?1 AND community=?2 AND name='observer'", params![viewer,community,observer,days]))?;
        database(tx.execute("UPDATE archive_subscriptions SET enabled=?3, days=?4 WHERE viewer=?1 AND community=?2 AND name='metrics'",params![viewer,community,metrics,metrics_days]))?;
        database(tx.commit())?;
        self.1 = 0;
        self.prune(now)?;
        self.settings(viewer, community)
    }
    fn vacuum(&self, pages: u32) -> Result<()> {
        // This pragma yields one row per reclaimed page. execute_batch steps it
        // only once; drain it or a large clear reclaims just a single page.
        let mut statement = database(
            self.0
                .prepare(&format!("PRAGMA incremental_vacuum({pages})")),
        )?;
        let mut rows = database(statement.query([]))?;
        while database(rows.next())?.is_some() {}
        Ok(())
    }
    pub(super) fn prune(&mut self, now: i64) -> Result<()> {
        if now < self.1 + 60 {
            return Ok(());
        }
        // Across inactive partitions too. Indexed expiry, enforced on every host operation.
        database(self.0.execute("DELETE FROM archive_events WHERE seq IN (SELECT e.seq FROM archive_events e JOIN archive_subscriptions s ON s.viewer=e.viewer AND s.community=e.community AND s.name=e.subscription WHERE s.days>0 AND e.created <= ?1-s.days*86400)",[now]))?;
        let _ = self.vacuum(64);
        self.1 = now;
        Ok(())
    }
    pub(super) fn ingest(
        &mut self,
        viewer: &str,
        community: &str,
        event: &AgentEvent,
        content: Option<&str>,
        revision: i64,
        now: i64,
    ) -> Result<()> {
        let raw = serde_json::to_string(event).map_err(|_| "Invalid archive envelope")?;
        // Only NIP-AM metrics are kept in plaintext; observer frames stay ciphertext.
        let content = content.filter(|_| event.kind == 44200);
        let bytes = (raw.len() + content.map_or(0, str::len)) as i64;
        let name = if event.kind == 24200 {
            "observer"
        } else {
            "metrics"
        };
        let tx = database(
            self.0
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate),
        )?;
        let current: i64 = database(tx.query_row(
            "SELECT revision FROM archive_partitions WHERE viewer=?1 AND community=?2",
            params![viewer, community],
            |r| r.get(0),
        ))?;
        if current != revision {
            return Err("Archive revision changed".into());
        }
        let (enabled, budget): (bool,i64) = database(tx.query_row("SELECT enabled,budget FROM archive_subscriptions WHERE viewer=?1 AND community=?2 AND name=?3",params![viewer,community,name],|r|Ok((r.get(0)?,r.get(1)?))))?;
        if enabled {
            database(tx.execute("INSERT OR IGNORE INTO archive_events(viewer,community,subscription,id,agent,kind,created,received,bytes,envelope,content) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![viewer,community,name,event.id,event.pubkey,event.kind,event.created_at as i64,now,bytes,raw,content]))?;
            // Byte quotas, not frame counts. A single agent cannot consume the whole pool.
            for (agent, cap) in [(Some(event.pubkey.as_str()), budget / 4), (None, budget)] {
                let used: i64 = database(tx.query_row("SELECT bytes FROM archive_usage WHERE viewer=?1 AND community=?2 AND subscription=?3 AND agent=?4",params![viewer,community,name,agent.unwrap_or("")],|r|r.get(0)))?;
                if used <= cap {
                    continue;
                }
                // Step only the oldest overflow rows. Separate predicates let
                // SQLite seek either existing paging index without a sort/full retained scan.
                let suffix = if agent.is_some() { " AND agent=?4" } else { "" };
                let mut statement = database(tx.prepare(&format!("SELECT seq,bytes FROM archive_events WHERE viewer=?1 AND community=?2 AND kind=?3{suffix} ORDER BY seq")))?;
                let mut rows = database(if let Some(agent) = agent {
                    statement.query(params![viewer, community, event.kind, agent])
                } else {
                    statement.query(params![viewer, community, event.kind])
                })?;
                let mut overflow = used - cap;
                let mut cutoff = 0;
                while overflow > 0 {
                    let row = database(rows.next())?.ok_or("Archive usage mismatch")?;
                    cutoff = database(row.get(0))?;
                    overflow -= database(row.get::<_, i64>(1))?;
                }
                drop(rows);
                drop(statement);
                let sql = format!("DELETE FROM archive_events WHERE viewer=?1 AND community=?2 AND kind=?3{suffix} AND seq<=?5");
                // ?4 is intentionally unused by the community-wide predicate.
                database(tx.execute(&sql, params![viewer, community, event.kind, agent, cutoff]))?;
            }
        }
        database(tx.commit())
    }
    pub(super) fn clear(&mut self, viewer: &str, community: &str, kind: Option<u16>) -> Result<()> {
        if let Some(kind) = kind {
            valid_kind(kind)?;
        }
        let tx = database(
            self.0
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate),
        )?;
        database(tx.execute(
            "UPDATE archive_partitions SET revision=revision+1 WHERE viewer=?1 AND community=?2",
            params![viewer, community],
        ))?;
        database(tx.execute("DELETE FROM archive_events WHERE viewer=?1 AND community=?2 AND (?3 IS NULL OR kind=?3)",params![viewer,community,kind]))?;
        database(tx.commit())?;
        // The delete has committed. Optional space reclamation cannot undo it
        // or truthfully turn this into a failed clear; prune will retry vacuum.
        let _ = self.vacuum(0);
        // Move the shrunken database out of WAL before returning; an active
        // reader may defer this, so reclamation cannot decide delete success.
        let _ = self.0.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
        Ok(())
    }
    pub(super) fn agents(&self, viewer: &str, community: &str, kind: u16) -> Result<Vec<String>> {
        let mut stmt = database(self.0.prepare("SELECT DISTINCT agent FROM archive_events WHERE viewer=?1 AND community=?2 AND kind=?3 ORDER BY agent LIMIT 256"))?;
        let rows = database(stmt.query_map(params![viewer, community, kind], |r| r.get(0)))?;
        database(rows.collect())
    }
    pub(super) fn read(
        &self,
        viewer: &str,
        community: &str,
        kind: u16,
        agent: Option<&str>,
        before: Option<i64>,
    ) -> Result<(Vec<StoredRow>, i64)> {
        valid_kind(kind)?;
        if agent.is_some_and(|s| s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()))
            || before.is_some_and(|v| v <= 0)
        {
            return Err("Invalid archive page".into());
        }
        let mut stmt = database(self.0.prepare("SELECT seq,received,envelope FROM archive_events WHERE viewer=?1 AND community=?2 AND kind=?3 AND (?4 IS NULL OR agent=?4) AND (?5 IS NULL OR seq<?5) AND NOT EXISTS(SELECT 1 FROM archive_subscriptions WHERE viewer=?1 AND community=?2 AND name=subscription AND days>0 AND created <= strftime('%s','now')-days*86400) ORDER BY seq DESC LIMIT 100"))?;
        let rows = database(stmt.query_map(
            params![viewer, community, kind, agent, before],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        ))?;
        let mut result = Vec::new();
        for row in rows {
            let (seq, received, raw) = database(row)?;
            result.push((seq, received, raw));
        }
        Ok((result, self.revision(viewer, community)?))
    }
    /// Metrics rows saved before plaintext storage, across this account's communities.
    pub(super) fn pending(&self, viewer: &str) -> Result<Vec<(i64, String)>> {
        let mut stmt = database(self.0.prepare("SELECT seq,envelope FROM archive_events WHERE viewer=?1 AND kind=44200 AND content IS NULL AND undecryptable=0 ORDER BY seq LIMIT ?2"))?;
        let rows = database(stmt.query_map(params![viewer, BACKFILL_BATCH], |r| {
            Ok((r.get(0)?, r.get(1)?))
        }))?;
        database(rows.collect())
    }
    /// Idempotent: only still-pending rows change. Rows that cannot be decoded
    /// are marked so they are never retried; their ciphertext stays readable.
    pub(super) fn fill(&mut self, rows: Vec<(i64, Option<String>)>) -> Result<()> {
        let tx = database(self.0.transaction())?;
        for (seq, content) in rows {
            database(tx.execute("UPDATE archive_events SET content=?2, undecryptable=(?2 IS NULL), bytes=bytes+COALESCE(length(CAST(?2 AS BLOB)),0) WHERE seq=?1 AND content IS NULL AND undecryptable=0", params![seq, content]))?;
        }
        database(tx.commit())
    }
}

#[cfg(test)]
mod contention_tests {
    use super::*;
    use crate::{
        archive::{execute, ArchiveHost, Request},
        identity::{EventTemplate, IdentityHost},
    };
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn sqlite_wait_does_not_hold_identity_signing_lock() {
        // A busy callback is the explicit barrier: signing starts only once the
        // archive operation has entered SQLite and is blocked by another writer.
        static BUSY: Mutex<Option<tokio::sync::oneshot::Sender<()>>> = Mutex::new(None);
        static RELEASE: std::sync::Condvar = std::sync::Condvar::new();
        static WAITING: Mutex<bool> = Mutex::new(false);
        fn blocked(_: i32) -> bool {
            let mut waiting = WAITING.lock().unwrap();
            *waiting = true;
            if let Some(sender) = BUSY.lock().unwrap().take() {
                let _ = sender.send(());
            }
            while *waiting {
                waiting = RELEASE.wait(waiting).unwrap();
            }
            false
        }
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("busy.sqlite3");
        let identity = IdentityHost::fixture();
        let viewer = identity.viewer().await.unwrap();
        let store = Store::open(path.clone()).unwrap();
        store.seed(&viewer, "https://a.test").unwrap();
        store.0.busy_handler(Some(blocked)).unwrap();
        let blocker = Connection::open(&path).unwrap();
        blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
        let (sender, entered) = tokio::sync::oneshot::channel();
        *BUSY.lock().unwrap() = Some(sender);
        let host = ArchiveHost(Arc::new(Mutex::new(Some(store))));
        let other = identity.clone();
        let work = tokio::spawn(async move {
            execute(
                &other,
                host,
                path,
                "https://a.test".into(),
                viewer,
                Request::Settings,
            )
            .await
        });
        entered.await.unwrap();
        let signed = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            identity.sign(EventTemplate {
                kind: 1,
                created_at: 1,
                tags: vec![],
                content: "independent signing".into(),
            }),
        )
        .await;
        // Always release before asserting, including when the old lock scope times out.
        *WAITING.lock().unwrap() = false;
        RELEASE.notify_one();
        blocker.execute_batch("ROLLBACK").unwrap();
        let _ = work.await.unwrap();
        assert!(signed.expect("SQLite blocked identity signing").is_ok());
    }
}
