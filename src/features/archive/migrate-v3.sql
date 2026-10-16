-- Plaintext NIP-AM metrics (44200). NULL content on a metrics row is pending backfill.
ALTER TABLE archive_events ADD COLUMN content TEXT;
ALTER TABLE archive_events ADD COLUMN undecryptable INTEGER NOT NULL DEFAULT 0;
CREATE INDEX archive_backfill ON archive_events(viewer, seq)
  WHERE kind=44200 AND content IS NULL AND undecryptable=0;
CREATE TRIGGER archive_resize_usage AFTER UPDATE OF bytes ON archive_events BEGIN
  UPDATE archive_usage SET bytes=bytes-OLD.bytes+NEW.bytes WHERE viewer=OLD.viewer AND community=OLD.community
    AND subscription=OLD.subscription AND agent IN ('',OLD.agent);
END;
-- The old 90-day/64 MiB metrics limits were fixed, never user-chosen.
UPDATE archive_subscriptions SET days=365 WHERE name='metrics' AND days=90;
UPDATE archive_subscriptions SET budget=1073741824 WHERE name='metrics';
