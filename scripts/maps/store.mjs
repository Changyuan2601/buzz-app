import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function querySpec(value) {
  if (
    value?.source !== "square-roster" ||
    !/^[a-z_]{1,80}$/.test(value.category ?? "") ||
    !Array.isArray(value.bbox) ||
    value.bbox.length !== 4 ||
    !value.bbox.every(Number.isFinite) ||
    value.bbox[0] < -180 ||
    value.bbox[2] > 180 ||
    value.bbox[1] < -90 ||
    value.bbox[3] > 90 ||
    value.bbox[0] >= value.bbox[2] ||
    value.bbox[1] >= value.bbox[3] ||
    typeof value.requireAddress !== "boolean"
  )
    throw new Error("Invalid map query");
  return {
    source: value.source,
    category: value.category,
    bbox: value.bbox,
    requireAddress: value.requireAddress,
  };
}

export function mapStore(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  return {
    close: () => db.close(),
    create(scope, channel, query) {
      const id = randomUUID();
      db.prepare("INSERT INTO map_datasets VALUES (?, ?, ?, ?, ?)").run(
        id,
        scope,
        channel,
        JSON.stringify(querySpec(query)),
        Date.now(),
      );
      return id;
    },
    dataset(scope, channel, id) {
      const row = db
        .prepare(
          "SELECT query_json FROM map_datasets WHERE scope = ? AND channel = ? AND id = ?",
        )
        .get(scope, channel, id);
      return row ? querySpec(JSON.parse(row.query_json)) : undefined;
    },
    note(scope, channel, location) {
      const row = db
        .prepare(
          "SELECT note, revision FROM map_notes WHERE scope = ? AND channel = ? AND location = ?",
        )
        .get(scope, channel, location);
      return row
        ? { text: row.note, revision: row.revision }
        : { text: "", revision: 0 };
    },
    saveNote(scope, channel, location, text, revision) {
      const result =
        revision === 0
          ? db
              .prepare(
                "INSERT INTO map_notes VALUES (?, ?, ?, ?, 1) ON CONFLICT(scope, channel, location) DO NOTHING",
              )
              .run(scope, channel, location, text)
          : db
              .prepare(
                "UPDATE map_notes SET note = ?, revision = revision + 1 WHERE scope = ? AND channel = ? AND location = ? AND revision = ?",
              )
              .run(text, scope, channel, location, revision);
      return result.changes === 1
        ? { text, revision: revision + 1 }
        : undefined;
    },
    view(scope, channel) {
      const row = db
        .prepare(
          "SELECT view_json FROM map_views WHERE scope = ? AND channel = ?",
        )
        .get(scope, channel);
      return row ? JSON.parse(row.view_json) : undefined;
    },
    saveView(scope, channel, view) {
      db.prepare(
        "INSERT INTO map_views VALUES (?, ?, ?) ON CONFLICT(scope, channel) DO UPDATE SET view_json = excluded.view_json",
      ).run(scope, channel, JSON.stringify(view));
    },
  };
}
