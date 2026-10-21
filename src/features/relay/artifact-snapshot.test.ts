import { afterEach, expect, it, vi } from "vitest";
import {
  ARTIFACT_SNAPSHOT_LIMITS,
  artifactSnapshotCapability,
  createArtifactSnapshotReader,
  type ArtifactManifestEntry,
  type ArtifactSnapshotRequest,
} from "./artifact-snapshot";
import { keypair, signed } from "./testing";

const artifactId = "11111111-1111-4111-8111-111111111111";
const channelId = "22222222-2222-4222-8222-222222222222";
const author = keypair();
const revision = () =>
  signed(author, {
    kind: 45010,
    content: '{"version":0}',
    tags: [
      ["ar", "1"],
      ["d", artifactId],
      ["h", channelId],
      ["type", "test.task"],
      ["title", "Task"],
      ["op", "create"],
    ],
  });
const query = {
  artifact: "current",
  kinds: [45010],
  "#type": ["test.task"],
} as const;
const signal = () => new AbortController().signal;
const page = (
  entries: readonly ArtifactManifestEntry[] = [],
  more: string | null = null,
) => ({
  version: 1,
  token: "snapshot-token",
  expiresAt: Math.floor(Date.now() / 1000) + 300,
  entries,
  nextToken: more,
});
afterEach(() => vi.useRealTimers());

it("requires the complete advertised snapshot contract", () => {
  expect(
    artifactSnapshotCapability({
      artifacts: { snapshot: ARTIFACT_SNAPSHOT_LIMITS },
    }),
  ).toBe(true);
  expect(
    artifactSnapshotCapability({ artifacts: { snapshot: { version: 1 } } }),
  ).toBe(false);
  expect(artifactSnapshotCapability({ supported_extensions: ["nip-ar"] })).toBe(
    false,
  );
});
it("uses stable snapshot tokens and separate page cursors", async () => {
  const event = revision();
  const entry = { artifactId, revisionId: event.id, channelId };
  const request = vi.fn(async (filter: ArtifactSnapshotRequest) => {
    if (filter.action === "start")
      return Response.json(page([entry], "page-two"));
    if (filter.action === "page") return Response.json(page());
    if (filter.action === "bodies")
      return Response.json({
        version: 1,
        token: "snapshot-token",
        events: [event],
      });
    return Response.json({
      version: 1,
      token: "snapshot-token",
      complete: true,
    });
  });
  const reader = createArtifactSnapshotReader(request);
  const first = await reader.start(query, signal());
  expect(first.entries).toEqual([entry]);
  await reader.page(first.token, "page-two", signal());
  expect((await reader.bodies(first.token, [entry], signal()))[0]?.id).toBe(
    event.id,
  );
  await reader.complete(first.token, signal());
  expect(request.mock.calls.map(([filter]) => filter)).toEqual([
    { artifact: "snapshot", action: "start", query },
    {
      artifact: "snapshot",
      action: "page",
      token: "snapshot-token",
      cursor: "page-two",
    },
    {
      artifact: "snapshot",
      action: "bodies",
      token: "snapshot-token",
      revisionIds: [event.id],
    },
    { artifact: "snapshot", action: "complete", token: "snapshot-token" },
  ]);
});
it.each([
  { version: 1, token: "snapshot-token", complete: false },
  { version: 1, token: "another-token", complete: true },
  { version: 2, token: "snapshot-token", complete: true },
])("rejects invalid completion %j", async (raw) => {
  const reader = createArtifactSnapshotReader(async () => Response.json(raw));
  await expect(
    reader.complete("snapshot-token", signal()),
  ).rejects.toMatchObject({ code: "snapshot_invalid" });
});
it("does not accept expired pages or duplicate artifact identities", async () => {
  const entry = { artifactId, revisionId: "a".repeat(64), channelId };
  let value = { ...page(), expiresAt: Math.floor(Date.now() / 1000) - 1 };
  const reader = createArtifactSnapshotReader(async () => Response.json(value));
  await expect(reader.start(query, signal())).rejects.toMatchObject({
    code: "snapshot_reset",
  });
  value = page([entry, entry]);
  await expect(reader.start(query, signal())).rejects.toMatchObject({
    code: "snapshot_invalid",
  });
});
it("rejects a page from another token and an empty page that claims more rows", async () => {
  let value = page();
  const reader = createArtifactSnapshotReader(async () => Response.json(value));
  await expect(
    reader.page("another-token", "cursor", signal()),
  ).rejects.toMatchObject({ code: "snapshot_invalid" });
  value = page([], "cursor");
  await expect(reader.start(query, signal())).rejects.toMatchObject({
    code: "snapshot_invalid",
  });
});
it.each(["snapshot_reset", "snapshot_limit", "snapshot_invalid"])(
  "retains machine error %s without relay text",
  async (code) => {
    const reader = createArtifactSnapshotReader(async () =>
      Response.json({ code, error: "private relay detail" }, { status: 409 }),
    );
    await expect(reader.start(query, signal())).rejects.toMatchObject({ code });
    await expect(reader.start(query, signal())).rejects.not.toThrow(
      "private relay detail",
    );
  },
);
it("checks exact revision, identity, channel and signature before returning a body", async () => {
  const event = revision();
  let events = [event];
  const reader = createArtifactSnapshotReader(async () =>
    Response.json({ version: 1, token: "snapshot-token", events }),
  );
  const entry = { artifactId, revisionId: event.id, channelId };
  await expect(
    reader.bodies(
      "snapshot-token",
      [{ ...entry, revisionId: "b".repeat(64) }],
      signal(),
    ),
  ).rejects.toMatchObject({ code: "snapshot_invalid" });
  await expect(
    reader.bodies(
      "snapshot-token",
      [{ ...entry, artifactId: channelId }],
      signal(),
    ),
  ).rejects.toMatchObject({ code: "snapshot_invalid" });
  await expect(
    reader.bodies(
      "snapshot-token",
      [{ ...entry, channelId: artifactId }],
      signal(),
    ),
  ).rejects.toMatchObject({ code: "snapshot_invalid" });
  events = [{ ...event, content: "tampered" }];
  await expect(
    reader.bodies("snapshot-token", [entry], signal()),
  ).rejects.toThrow("invalidly signed");
});
it("rejects duplicate, missing, or deleted bodies", async () => {
  const event = revision();
  const entry = { artifactId, revisionId: event.id, channelId };
  let events = [event, event];
  const reader = createArtifactSnapshotReader(async () =>
    Response.json({ version: 1, token: "snapshot-token", events }),
  );
  await expect(
    reader.bodies("snapshot-token", [entry], signal()),
  ).rejects.toMatchObject({ code: "snapshot_invalid" });
  events = [];
  await expect(
    reader.bodies("snapshot-token", [entry], signal()),
  ).rejects.toMatchObject({ code: "snapshot_invalid" });
  const deleted = signed(author, {
    kind: 45010,
    content: "",
    tags: [
      ["ar", "1"],
      ["d", artifactId],
      ["h", channelId],
      ["op", "delete"],
    ],
  });
  events = [deleted];
  await expect(
    reader.bodies(
      "snapshot-token",
      [{ ...entry, revisionId: deleted.id }],
      signal(),
    ),
  ).rejects.toMatchObject({ code: "snapshot_invalid" });
});
it("bounds manifest bytes before parsing and cancels the response stream", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new Uint8Array(ARTIFACT_SNAPSHOT_LIMITS.pageBytes + 1),
      );
    },
    cancel,
  });
  const reader = createArtifactSnapshotReader(async () => new Response(body));
  await expect(reader.start(query, signal())).rejects.toMatchObject({
    code: "snapshot_limit",
  });
  expect(cancel).toHaveBeenCalledOnce();
});
it("fences cancellation before consuming a response", async () => {
  const controller = new AbortController();
  const reader = createArtifactSnapshotReader(async () => {
    controller.abort();
    return Response.json(page());
  });
  await expect(reader.start(query, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
});
