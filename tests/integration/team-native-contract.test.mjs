import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cargo = path.join(root, "bin/cargo");
const envelopeLimit = 8 * 1024 * 1024;
const promptLimit = 128 * 1024;
const options = {
  destination: "https://relay.example",
  owner: "b".repeat(64),
  keepAllowlist: true,
};

function command(executable, args, input) {
  const result = spawnSync(executable, args, {
    cwd: root,
    input,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.ifError(result.error);
  return result;
}

function source() {
  return {
    format: "buzz-team-snapshot",
    version: 1,
    team: { name: "Team", instructions: "Shared" },
    members: [
      {
        format: "buzz-agent-snapshot",
        version: 1,
        definition: {
          name: "One",
          runtime: "buzz-agent",
          systemPrompt: "Individual",
        },
        profile: { displayName: "One", about: "" },
        memory: {
          level: "everything",
          entries: [{ slug: "core", body: "Memory" }],
        },
      },
    ],
  };
}

// Fill across bounded portable fields; no individual profile may exceed kind-0's
// readable content limit. Preserve exact serialized UTF-8 and escape accounting.
function fillEnvelope(snapshot, token, extra = 0) {
  snapshot.members = Array.from({ length: 32 }, () =>
    structuredClone(snapshot.members[0]),
  );
  for (const member of snapshot.members) {
    member.profile.about = "";
    member.definition.systemPrompt = "";
    member.memory.entries[0].body = "";
  }
  const fields = snapshot.members.flatMap((member) => [
    [member.definition, "systemPrompt", promptLimit],
    [member.profile, "about", 64 * 1024],
    [member.memory.entries[0], "body", 64 * 1024],
  ]);
  for (const [object, field, maxBytes] of fields) {
    const remaining =
      envelopeLimit + extra - Buffer.byteLength(JSON.stringify(snapshot));
    if (remaining <= 0) break;
    const cost = Buffer.byteLength(JSON.stringify(token)) - 2;
    const count = Math.min(
      Math.floor(remaining / cost),
      Math.floor(maxBytes / Buffer.byteLength(token)),
    );
    object[field] = token.repeat(count);
    const residual =
      envelopeLimit + extra - Buffer.byteLength(JSON.stringify(snapshot));
    object[field] += "a".repeat(
      Math.min(residual, maxBytes - Buffer.byteLength(object[field])),
    );
  }
  assert.equal(
    Buffer.byteLength(JSON.stringify(snapshot)),
    envelopeLimit + extra,
  );
  return snapshot;
}

test("native-validated team boundaries survive the shared parser and real import orchestrator", async (t) => {
  const build = command(cargo, [
    "build",
    "--locked",
    "-p",
    "buzz-agent-controller",
    "--example",
    "team-preview",
  ]);
  assert.equal(build.status, 0, build.stderr);
  const metadata = command(cargo, [
    "metadata",
    "--no-deps",
    "--format-version=1",
    "--locked",
    "--offline",
  ]);
  assert.equal(metadata.status, 0, metadata.stderr);
  const executable = path.join(
    JSON.parse(metadata.stdout).target_directory,
    "debug/examples",
    process.platform === "win32" ? "team-preview.exe" : "team-preview",
  );
  const server = await createServer({
    root,
    configFile: false,
    // This is an SSR adapter, not a browser entry. Do not scan/bundle the app in
    // the background while invoking native child processes synchronously.
    optimizeDeps: { noDiscovery: true, include: [], entries: [] },
    server: { middlewareMode: true, watch: null },
    appType: "custom",
  });
  t.after(() => server.close());
  const { importTeamSnapshot } = await server.ssrLoadModule(
    path.join(root, "src/features/agents/team-import.ts"),
  );
  const { controlFixture } = await server.ssrLoadModule(
    path.join(root, "src/features/agents/control-testing.ts"),
  );
  const { encodeTeam, decodeTeamFile } = await server.ssrLoadModule(
    path.join(root, "src/features/agents/team-encoding.ts"),
  );
  const native = controlFixture();
  const previousStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  t.after(() => {
    if (previousStorage)
      Object.defineProperty(globalThis, "localStorage", previousStorage);
    else delete globalThis.localStorage;
  });
  const preview = (snapshot) =>
    command(executable, [], JSON.stringify(snapshot));
  const validated = (snapshot) => {
    const result = preview(snapshot);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  async function check(snapshot, accepted, restoreMemory) {
    const calls = { creates: [], writes: [], saves: [], previews: [] };
    const values = new Map();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: (key) => values.delete(key),
      },
    });
    const control = {
      previewTeam: async (content) => {
        const result = command(executable, [], content);
        calls.previews.push(result.status);
        if (result.status !== 0) throw new Error(result.stderr.trim());
        return JSON.parse(result.stdout);
      },
      refresh: async () => {},
      snapshot: () => ({ data: native.data }),
      create: async (...args) => {
        calls.creates.push(args);
        return native.agent;
      },
      writeSnapshotMemory: async (_id, entries) => {
        calls.writes.push(entries);
        // The production writer has a distinct, narrower cap. Model its thrown boundary.
        if (
          entries.length > 128 ||
          entries.some((entry) => Buffer.byteLength(entry.body) > 64 * 1024)
        )
          throw new Error("Snapshot memory exceeds the import limit");
        return { written: entries.length, total: entries.length, errors: [] };
      },
    };
    const kit = {
      refresh: async () => {},
      snapshot: () => ({ entries: [] }),
      savePortable: async (...args) => {
        calls.saves.push(args);
        return "saved";
      },
    };
    const original = JSON.stringify(snapshot);
    const operation = () =>
      importTeamSnapshot(control, kit, snapshot, { ...options, restoreMemory });
    if (!accepted) {
      assert.notEqual(
        preview(snapshot).status,
        0,
        "Over-limit input must be rejected by native validation",
      );
      await assert.rejects(operation);
      assert.equal(calls.creates.length, 0);
      assert.equal(calls.writes.length, 0);
      assert.equal(calls.saves.length, 0);
      assert.notEqual(calls.previews[0], 0);
      return;
    }
    const canonical = validated(snapshot);
    const result = await operation();
    assert.equal(calls.creates.length, snapshot.members.length);
    for (const [index, args] of calls.creates.entries()) {
      assert.equal(
        args[3].systemPrompt,
        snapshot.members[index].definition.systemPrompt,
      );
      assert.deepEqual(
        args[4].member.definition,
        canonical.members[index].definition,
      );
      assert.deepEqual(
        args[4].member.profile,
        canonical.members[index].profile,
      );
      assert.deepEqual(args[4].member.memory, { level: "none", entries: [] });
      assert.equal(args[4].instructions, snapshot.team.instructions);
    }
    assert.deepEqual(calls.saves[0][1], canonical);
    assert.equal(JSON.stringify(snapshot), original);
    if (!restoreMemory) assert.equal(calls.writes.length, 0);
    else {
      assert.deepEqual(calls.writes[0], canonical.members[0].memory.entries);
      assert.equal(
        result.memories[0].total,
        canonical.members[0].memory.entries.length,
      );
    }
  }

  for (const token of ["a", 'é"\\\n']) {
    for (const extra of [0, 1]) {
      for (const format of ["json", "png"]) {
        await t.test(
          `export ${format} complete envelope ${envelopeLimit + extra}, escaping=${token !== "a"}`,
          async () => {
            const snapshot = fillEnvelope(validated(source()), token, extra);
            if (extra) {
              assert.notEqual(preview(snapshot).status, 0);
              assert.throws(() => encodeTeam(snapshot, format), /size limit/);
              return;
            }
            const canonical = validated(snapshot);
            const file = encodeTeam(canonical, format);
            if (format === "json") assert.equal(file.size, envelopeLimit);
            const content = decodeTeamFile(
              new Uint8Array(await file.arrayBuffer()),
            );
            assert.equal(Buffer.byteLength(content), envelopeLimit);
            const result = command(executable, [], content);
            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(JSON.parse(result.stdout), canonical);
          },
        );
      }
    }
  }

  for (const token of ["a", "é"]) {
    for (const extra of [0, 1]) {
      for (const restoreMemory of [false, true]) {
        await t.test(
          `prompt UTF-8 ${token} ${promptLimit + extra} restore=${restoreMemory}`,
          async () => {
            const snapshot = source();
            snapshot.members[0].definition.systemPrompt =
              token.repeat(promptLimit / Buffer.byteLength(token)) +
              "a".repeat(extra);
            assert.equal(
              Buffer.byteLength(snapshot.members[0].definition.systemPrompt),
              promptLimit + extra,
            );
            await check(snapshot, extra === 0, restoreMemory);
          },
        );
      }
    }
  }
  for (const restoreMemory of [false, true]) {
    await t.test(
      `oversized second profile creates no members restore=${restoreMemory}`,
      async () => {
        const snapshot = source();
        snapshot.members.push(structuredClone(snapshot.members[0]));
        snapshot.members[1].profile.about = '"'.repeat(70 * 1024);
        await check(snapshot, false, restoreMemory);
      },
    );
    await t.test(
      `about beyond former 2048-byte cap restore=${restoreMemory}`,
      async () => {
        const snapshot = source();
        snapshot.members[0].profile.about = 'é"\\\n'.repeat(1024);
        await check(snapshot, true, restoreMemory);
      },
    );
    for (const token of ["a", 'é"\\\n']) {
      for (const extra of [0, 1]) {
        await t.test(
          `complete serialized envelope ${envelopeLimit + extra}, escaping=${token !== "a"}, restore=${restoreMemory}`,
          async () => {
            // First materialize every Serde default/null so input and native output overhead agree.
            const snapshot = fillEnvelope(validated(source()), token, extra);
            await check(snapshot, extra === 0, restoreMemory);
          },
        );
      }
    }
    await t.test(
      `all bounded fields at native maxima restore=${restoreMemory}`,
      async () => {
        const snapshot = source();
        snapshot.team = {
          name: "T".repeat(256),
          description: "D".repeat(4096),
          instructions: "S".repeat(promptLimit),
        };
        const member = snapshot.members[0];
        member.definition = {
          name: "N".repeat(256),
          runtime: "buzz-agent",
          sourceIsBuiltin: false,
          systemPrompt: "P".repeat(promptLimit),
          model: "M".repeat(512),
          provider: "V".repeat(128),
          sessionPolicy: "thread",
          respondTo: "allowlist",
          parallelism: 32,
          idleTimeoutSeconds: 86400,
          maxTurnDurationSeconds: 86400,
          namePool: Array.from({ length: 256 }, () => "N".repeat(256)),
          respondToAllowlist: Array.from({ length: 2000 }, (_, i) =>
            i.toString(16).padStart(64, "0"),
          ),
        };
        member.profile = {
          displayName: member.definition.name,
          about: "A".repeat(2049),
          avatarUrl:
            "https://example.test/" +
            "a".repeat(2048 - "https://example.test/".length),
        };
        // Each segment is <=64 bytes; the complete unique slug reaches 255.
        member.memory.entries = Array.from({ length: 256 }, (_, i) => ({
          slug: `mem/${`${"a".repeat(62)}/`.repeat(3)}${"a".repeat(58)}${i.toString(16).padStart(4, "0")}`,
          body: "",
        }));
        assert.equal(member.memory.entries[0].slug.length, 255);
        member.memory.entries[0].body = "m".repeat(
          1024 * 1024 -
            member.memory.entries.reduce(
              (n, entry) => n + Buffer.byteLength(entry.slug),
              0,
            ),
        );
        await check(snapshot, true, restoreMemory);
      },
    );
    await t.test(
      `credential-free avatar query and fragment restore=${restoreMemory}`,
      async () => {
        const snapshot = source();
        snapshot.members[0].profile.avatarUrl =
          "https://example.test/picture?size=2#avatar";
        await check(snapshot, true, restoreMemory);
      },
    );
    await t.test(
      `native maximum member count restore=${restoreMemory}`,
      async () => {
        const snapshot = source();
        snapshot.members = Array.from({ length: 32 }, () =>
          structuredClone(snapshot.members[0]),
        );
        await check(snapshot, true, restoreMemory);
        snapshot.members.push(structuredClone(snapshot.members[0]));
        await check(snapshot, false, restoreMemory);
      },
    );
  }
});
