import { expect, it } from "vitest";
import {
  MAX_AGENT_SNAPSHOT_JSON_BYTES,
  MAX_AGENT_SNAPSHOT_PNG_BYTES,
} from "./snapshot";
import {
  MAX_TEAM_SNAPSHOT_JSON_BYTES,
  MAX_TEAM_SNAPSHOT_PNG_BYTES,
} from "./team-encoding";

import type { RelaySession } from "../relay/session";
import { snapshotClipboardHtml } from "./snapshot-link";
import { parseSnapshotClipboard } from "./snapshot-clipboard";

const hash = "a".repeat(64);
const session = {
  media: (url: string) =>
    url.startsWith("https://relay.test/media/")
      ? `buzz-media://localhost/${encodeURIComponent(url)}`
      : undefined,
} as unknown as RelaySession;
const attachment = {
  name: "helper.agent.png",
  url: `https://relay.test/media/${hash}.png`,
  size: 1024,
  type: "image/png",
  sha256: hash,
};
function html(change: Record<string, unknown>) {
  return `<a data-buzz-agent-snapshot="${encodeURIComponent(
    JSON.stringify({
      version: 1,
      displayName: "Helper",
      filename: attachment.name,
      ...attachment,
      ...change,
    }),
  )}">Helper</a>`;
}
it.each(["agent", "team"])(
  "restores the actual Copy link HTML for %s",
  (kind) => {
    const value = { ...attachment, name: `helper.${kind}.png` };
    expect(
      parseSnapshotClipboard(snapshotClipboardHtml(value, "Helper"), session),
    ).toEqual(value);
  },
);
it.each([
  { version: 2 },
  { filename: "../helper.agent.png" },
  { filename: "helper.png" },
  { displayName: "" },
  { size: 0 },
  { size: MAX_AGENT_SNAPSHOT_PNG_BYTES + 1 },
  { size: 1.5 },
  { sha256: "b".repeat(64) },
  { type: "text/html" },
  { url: `https://other.test/media/${hash}.png` },
  { url: `${attachment.url}?token=secret` },
])("rejects untrusted metadata %j", (change) => {
  expect(parseSnapshotClipboard(html(change), session)).toBeUndefined();
});
it("rejects oversized HTML and malformed payloads without intercepting normal paste", () => {
  expect(parseSnapshotClipboard("x".repeat(16385), session)).toBeUndefined();
  expect(
    parseSnapshotClipboard('<a data-buzz-agent-snapshot="%">', session),
  ).toBeUndefined();
  expect(parseSnapshotClipboard("ordinary text", session)).toBeUndefined();
});

it.each([
  ["agent.png", MAX_AGENT_SNAPSHOT_PNG_BYTES],
  ["agent.json", MAX_AGENT_SNAPSHOT_JSON_BYTES],
  ["team.png", MAX_TEAM_SNAPSHOT_PNG_BYTES],
  ["team.json", MAX_TEAM_SNAPSHOT_JSON_BYTES],
])("bounds copied %s metadata at the owner limit", (format, limit) => {
  const change = {
    filename: `helper.${format}`,
    type: format.endsWith("png") ? "image/png" : "application/json",
    size: limit,
  };
  expect(parseSnapshotClipboard(html(change), session)).toMatchObject({
    name: change.filename,
    size: limit,
    type: change.type,
  });
  expect(
    parseSnapshotClipboard(html({ ...change, size: limit + 1 }), session),
  ).toBeUndefined();
});
