import { deflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { controlFixture } from "./control-testing";
import {
  buildAgentSnapshot,
  encodeAgentSnapshot,
  MAX_AGENT_SNAPSHOT_FILE_BYTES,
  MAX_AGENT_SNAPSHOT_JSON_BYTES,
  MAX_AGENT_SNAPSHOT_PNG_BYTES,
  parseAgentSnapshot,
  snapshotImportEdit,
  snapshotPngArtwork,
  restorableMemoryEntry,
  snapshotLimitations,
} from "./snapshot";
const portableAgent = () => {
  const { agent } = controlFixture();
  agent.harness.command = "buzz-agent";
  agent.sessionPolicy = "thread";
  agent.harness.environmentKeys = [];
  return agent;
};
const utf8 = new TextEncoder();
const parse = (value: unknown) =>
  parseAgentSnapshot(utf8.encode(JSON.stringify(value)));

const destination = {
  defaultWorkspace: "/new-machine/agents",
  harnessOptions: [
    {
      command: "buzz-agent",
      label: "Buzz Agent",
      defaultArgs: ["--local"],
      providers: [],
    },
  ],
};

it.each(["json", "png"] as const)(
  "maps omitted and explicit portable settings from %s for native creation",
  (format) => {
    const source = buildAgentSnapshot(portableAgent());
    const withSettings = parse({
      ...source,
      definition: {
        name: "Portable",
        systemPrompt: "Keep the contract.",
        model: "",
        provider: "provider-a",
        parallelism: 4,
        sessionPolicy: "thread",
        runtime: "buzz-agent",
      },
      profile: {
        displayName: "Portable",
        avatarUrl: "https://example.test/a.png",
      },
    });
    const wire = parseAgentSnapshot(encodeAgentSnapshot(withSettings, format));
    const edit = snapshotImportEdit(wire, destination);
    expect(edit).toMatchObject({
      name: "Portable",
      sessionPolicy: "thread",
      workspace: "/new-machine/agents",
      harness: {
        command: "buzz-agent",
        args: ["--local"],
        model: "",
        provider: "provider-a",
      },
      environment: { BUZZ_ACP_AGENTS: "4" },
      picture: "https://example.test/a.png",
    });
    expect(edit).not.toHaveProperty("pubkey");
    const omitted = parse({
      ...wire,
      definition: { name: "Portable" },
      profile: { displayName: "Portable" },
    });
    expect(snapshotImportEdit(omitted, destination)).toMatchObject({
      systemPrompt: "",
      sessionPolicy: "channel",
      environment: {},
      harness: { model: "", provider: "" },
    });
    expect(snapshotImportEdit(omitted, destination)).not.toHaveProperty(
      "picture",
    );
    expect(snapshotLimitations(omitted)).toEqual([]);
  },
);

it.each([
  ["claude", "/local/claude-agent-acp"],
  ["hermes", "/local/hermes-acp"],
  ["pi", "/local/buzz-pi-acp"],
  ["goose", "/local/goose-acp"],
] as const)(
  "resolves %s through an available native harness, never a publisher path",
  (runtime, command) => {
    const source = buildAgentSnapshot(portableAgent());
    const snapshot = parse({
      ...source,
      definition: { name: source.definition.name, runtime },
    });
    const options = {
      ...destination,
      harnessOptions: [
        { command, label: runtime, providers: [], defaultArgs: ["--native"] },
      ],
    };
    expect(snapshotImportEdit(snapshot, options).harness).toMatchObject({
      command,
      args: ["--native"],
    });
    expect(() =>
      snapshotImportEdit(snapshot, {
        ...options,
        harnessOptions: [
          { command, label: runtime, providers: [], available: false },
        ],
      }),
    ).toThrow("unavailable");
    expect(() =>
      snapshotImportEdit(snapshot, {
        ...options,
        transportAlias: "buzz-other-acp",
      }),
    ).toThrow("unsupported ACP transport");
  },
);

it("rejects unsupported selector and worker semantics before native creation", () => {
  const source = buildAgentSnapshot(portableAgent());
  const options = {
    ...destination,
    harnessOptions: [
      {
        command: "claude-agent-acp",
        label: "Claude",
        providers: [],
        configurationPolicy: {
          authentication: "external" as const,
          provider: "external" as const,
          supportedModes: [] as [],
          model: "optional" as const,
          effortDiscovery: "unknown" as const,
          selectorEnvironment: null,
        },
      },
    ],
  };
  expect(() =>
    snapshotImportEdit(
      parse({
        ...source,
        definition: {
          name: source.definition.name,
          runtime: "claude",
          provider: "openai",
        },
      }),
      options,
    ),
  ).toThrow("external harness provider selector");
  const standalone = snapshotImportEdit(
    parse({
      ...source,
      definition: {
        name: source.definition.name,
        runtime: "claude",
        parallelism: 4,
      },
    }),
    options,
  );
  expect(standalone.environment).toEqual({ BUZZ_ACP_AGENTS: "4" });
  const team = snapshotImportEdit(
    parse({
      ...source,
      definition: {
        name: source.definition.name,
        runtime: "claude",
        parallelism: 4,
        respondTo: "allowlist",
        respondToAllowlist: ["source"],
      },
      profile: {
        displayName: source.profile.displayName,
        about: "About",
        avatarDataUrl: "data:image/png;base64,AAAA",
      },
    }),
    { ...options, teamMember: true },
  );
  expect(team.environment).toEqual({});
  expect(team.picture).toBe("data:image/png;base64,AAAA");
  const pi = {
    ...options,
    harnessOptions: [{ command: "buzz-pi-acp", label: "Pi", providers: [] }],
  };
  expect(() =>
    snapshotImportEdit(
      parse({
        ...source,
        definition: {
          name: source.definition.name,
          runtime: "pi",
          provider: "openai",
        },
      }),
      pi,
    ),
  ).toThrow("Pi provider requires a model");
});

it("validates full team members at native collection and memory budgets without weakening standalone", () => {
  const source = buildAgentSnapshot(portableAgent());
  const member = (count: number) => ({
    ...source,
    definition: {
      ...source.definition,
      respondTo: "allowlist",
      respondToAllowlist: Array.from({ length: count }, (_, n) =>
        n.toString(16).padStart(64, "0"),
      ),
      namePool: Array.from(
        { length: Math.min(count, 256) },
        (_, n) => `agent-${n}`,
      ),
    },
    memory: {
      level: "everything",
      entries: Array.from({ length: Math.min(count, 257) }, (_, n) => ({
        slug: `mem/entry-${n}`,
        body: "x",
      })),
    },
  });
  for (const count of [129, 255, 256]) {
    const bytes = utf8.encode(JSON.stringify(member(count)));
    expect(() => parseAgentSnapshot(bytes)).toThrow(
      "Invalid snapshot manifest",
    );
    const parsed = parseAgentSnapshot(bytes, { teamMember: true });
    expect(parsed.memory.entries).toHaveLength(count);
    expect(
      snapshotImportEdit(parsed, { ...destination, teamMember: true })
        .environment,
    ).toEqual({});
  }
  expect(() =>
    parseAgentSnapshot(utf8.encode(JSON.stringify(member(257))), {
      teamMember: true,
    }),
  ).toThrow("Invalid snapshot manifest");
  const allowlist = (count: number) => ({
    ...member(1),
    definition: {
      ...member(1).definition,
      respondToAllowlist: Array.from({ length: count }, (_, n) =>
        n.toString(16).padStart(64, "0"),
      ),
    },
  });
  expect(
    parseAgentSnapshot(utf8.encode(JSON.stringify(allowlist(2000))), {
      teamMember: true,
    }).definition.respondToAllowlist,
  ).toHaveLength(2000);
  expect(() =>
    parseAgentSnapshot(utf8.encode(JSON.stringify(allowlist(2001))), {
      teamMember: true,
    }),
  ).toThrow("Invalid snapshot manifest");
  const large = {
    ...member(1),
    memory: {
      level: "everything",
      entries: [{ slug: "mem/notes", body: "x".repeat(64 * 1024 + 1) }],
    },
  };
  expect(() => parseAgentSnapshot(utf8.encode(JSON.stringify(large)))).toThrow(
    "Invalid snapshot manifest",
  );
  expect(
    parseAgentSnapshot(utf8.encode(JSON.stringify(large)), { teamMember: true })
      .memory.entries[0]?.body,
  ).toHaveLength(64 * 1024 + 1);
  const over = {
    ...large,
    memory: {
      level: "everything",
      entries: [{ slug: "mem/notes", body: "x".repeat(1024 * 1024) }],
    },
  };
  expect(() =>
    parseAgentSnapshot(utf8.encode(JSON.stringify(over)), { teamMember: true }),
  ).toThrow("Invalid snapshot manifest");
});

it("accepts native team prompt and about byte bounds without relaxing standalone snapshots", () => {
  const source = buildAgentSnapshot(portableAgent());
  const team = (systemPrompt: string, about: string) => ({
    ...source,
    definition: { ...source.definition, systemPrompt },
    profile: { ...source.profile, about },
  });
  for (const prompt of ["x".repeat(128 * 1024), "é".repeat(64 * 1024)]) {
    const about = "é".repeat(1025);
    const bytes = utf8.encode(JSON.stringify(team(prompt, about)));
    expect(() => parseAgentSnapshot(bytes)).toThrow(
      "Invalid snapshot manifest",
    );
    const parsed = parseAgentSnapshot(bytes, { teamMember: true });
    expect(parsed.definition.systemPrompt).toBe(prompt);
    expect(parsed.profile.about).toBe(about);
    expect(
      snapshotImportEdit(parsed, { ...destination, teamMember: true })
        .systemPrompt,
    ).toBe(prompt);
  }
  expect(() =>
    parseAgentSnapshot(
      utf8.encode(JSON.stringify(team("é".repeat(65537), ""))),
      {
        teamMember: true,
      },
    ),
  ).toThrow("Invalid snapshot manifest");
  const about = "é".repeat(5000);
  expect(
    parseAgentSnapshot(utf8.encode(JSON.stringify(team("", about))), {
      teamMember: true,
    }).profile.about,
  ).toBe(about);
});

it("uses native team avatar URL rules without relaxing standalone parsing", () => {
  const source = buildAgentSnapshot(portableAgent());
  const team = (avatarUrl: string) =>
    utf8.encode(
      JSON.stringify({
        ...source,
        profile: { ...source.profile, avatarUrl },
      }),
    );
  const url = "https://example.test/a.png?size=2#image";
  expect(() => parseAgentSnapshot(team(url))).toThrow(
    "Invalid snapshot manifest",
  );
  expect(
    parseAgentSnapshot(team(url), { teamMember: true }).profile.avatarUrl,
  ).toBe(url);
  for (const invalid of [
    "https://name:pass@example.test/a",
    "http://example.test/a",
  ]) {
    expect(() =>
      parseAgentSnapshot(team(invalid), { teamMember: true }),
    ).toThrow("Invalid snapshot manifest");
  }
});

it("rejects unsupported explicit values instead of silently downgrading", () => {
  const source = buildAgentSnapshot(portableAgent());
  for (const definition of [
    { runtime: "other" },
    { respondTo: "anyone" },
    { parallelism: 33 },
    { idleTimeoutSeconds: 0 },
    { namePool: ["other"] },
  ]) {
    const snapshot = parse({
      ...source,
      definition: { ...source.definition, ...definition },
    });
    expect(() => snapshotImportEdit(snapshot, destination)).toThrow(
      "Import is blocked",
    );
  }
  expect(() => snapshotImportEdit(source, { harnessOptions: [] })).toThrow(
    "unavailable",
  );
});

it.each(["json", "png"] as const)(
  "normalizes reference nullable option fields in %s while preserving explicit values",
  (format) => {
    const source = buildAgentSnapshot(portableAgent());
    const nullable = {
      ...source,
      definition: {
        name: source.definition.name,
        systemPrompt: null,
        runtime: null,
        model: null,
        provider: null,
        parallelism: null,
        respondTo: null,
        idleTimeoutSeconds: null,
        maxTurnDurationSeconds: null,
      },
      profile: {
        displayName: source.profile.displayName,
        about: null,
        avatarUrl: null,
      },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(nullable));
    const imported = parseAgentSnapshot(bytes);
    expect(imported.definition).toEqual({ name: source.definition.name });
    expect(imported.profile).toEqual({
      displayName: source.profile.displayName,
    });
    const roundtrip = parseAgentSnapshot(encodeAgentSnapshot(imported, format));
    expect(roundtrip.definition).toEqual(imported.definition);
    expect(snapshotImportEdit(roundtrip, destination).environment).toEqual({});
    expect(() =>
      parse({
        ...nullable,
        definition: { ...nullable.definition, sessionPolicy: null },
      }),
    ).toThrow("Invalid snapshot manifest");
    expect(() =>
      parse({
        ...nullable,
        definition: { ...nullable.definition, parallelism: 0 },
      }),
    ).toThrow("Invalid snapshot manifest");
  },
);

it.each(["json", "png"] as const)(
  "uses the shared %s file cap for send eligibility and import",
  (format) => {
    const bytes = encodeAgentSnapshot(
      buildAgentSnapshot(portableAgent()),
      format,
    );
    const cap =
      format === "png"
        ? MAX_AGENT_SNAPSHOT_PNG_BYTES
        : MAX_AGENT_SNAPSHOT_JSON_BYTES;
    expect(bytes.length).toBeLessThanOrEqual(cap);
    expect(parseAgentSnapshot(bytes).format).toBe("buzz-agent-snapshot");
    const oversized = new Uint8Array(cap + 1);
    if (format === "png") oversized.set(bytes.subarray(0, 8));
    expect(() => parseAgentSnapshot(oversized)).toThrow(
      "Snapshot exceeds the size limit.",
    );
    expect(MAX_AGENT_SNAPSHOT_FILE_BYTES).toBe(MAX_AGENT_SNAPSHOT_PNG_BYTES);
  },
);

it("exports the native listener fallback explicitly across different destination defaults", () => {
  const source = portableAgent();
  source.launchParallelism = 1; // Native projection when no worker setting exists.
  const exported = buildAgentSnapshot(source);
  expect(exported.definition.parallelism).toBe(1);
  const imported = parseAgentSnapshot(encodeAgentSnapshot(exported, "json"));
  expect(imported.definition.parallelism).toBe(1);
  // Import writes 1 rather than inheriting the destination's worker default of 4.
  const destination = portableAgent();
  destination.launchParallelism = imported.definition.parallelism ?? null;
  expect(buildAgentSnapshot(destination).definition.parallelism).toBe(1);
  expect(
    parseAgentSnapshot(encodeAgentSnapshot(exported, "png")).definition
      .parallelism,
  ).toBe(1);
});

it.each(["json", "png"] as const)(
  "round trips %s with no credentials, identity, or local arguments",
  (format) => {
    const { agent } = controlFixture();
    Object.assign(agent.harness, { command: "buzz-agent" });
    agent.sessionPolicy = "thread";
    agent.harness.environmentKeys = [];
    agent.systemPrompt = "Handle café carefully.";
    agent.picture = "https://images.example.test/avatar.png";
    const snapshot = buildAgentSnapshot(agent);
    const bytes = encodeAgentSnapshot(snapshot, format);
    expect(parseAgentSnapshot(bytes)).toEqual(snapshot);
    const text = new TextDecoder().decode(
      format === "json" ? bytes : encodeAgentSnapshot(snapshot, "json"),
    );
    for (const secret of [
      agent.pubkey,
      agent.id,
      agent.workspace,
      "EXAMPLE_TOKEN",
      "--literal",
      "DO_NOT_PROJECT",
    ])
      expect(text).not.toContain(secret);
    expect(snapshot.memory).toEqual({ level: "none", entries: [] });
    expect(
      JSON.parse(
        new TextDecoder().decode(encodeAgentSnapshot(snapshot, "json")),
      ).memory,
    ).toEqual({ level: "none" });
  },
);

it.each(["core", "everything"] as const)(
  "round trips %s memory only after selection",
  (level) => {
    const source = [
      { slug: "core", body: "remember this" },
      { slug: "mem/one", body: "value" },
    ];
    const manifest = buildAgentSnapshot(portableAgent(), level, source);
    expect(
      parseAgentSnapshot(encodeAgentSnapshot(manifest, "png")).memory.entries,
    ).toEqual(level === "core" ? source.slice(0, 1) : source);
  },
);

it.each(["none", "core", "everything"] as const)(
  "accepts a reference %s snapshot with omitted empty entries",
  (level) => {
    const manifest = buildAgentSnapshot(portableAgent());
    const decoded = parse({ ...manifest, memory: { level } });
    expect(decoded.memory).toEqual({ level, entries: [] });
    expect(
      JSON.parse(new TextDecoder().decode(encodeAgentSnapshot(decoded, "json")))
        .memory,
    ).toEqual({ level });
  },
);

it("rejects source credentials and inconsistent memory before preview", () => {
  const manifest = buildAgentSnapshot(portableAgent());
  expect(() => parse({ ...manifest, privateKey: "nsec" })).toThrow(
    "Invalid snapshot manifest",
  );
  expect(() =>
    parse({
      ...manifest,
      definition: { ...manifest.definition, environment: { KEY: "secret" } },
    }),
  ).toThrow("Invalid snapshot manifest");
  expect(() =>
    parse({
      ...manifest,
      definition: { ...manifest.definition, acpCommand: "buzz-agent" },
    }),
  ).toThrow("Invalid snapshot manifest");
  expect(
    parse({
      ...manifest,
      definition: { ...manifest.definition, respondTo: "anyone" },
    }).definition.respondTo,
  ).toBe("anyone");
  expect(() =>
    parse({
      ...manifest,
      memory: { level: "none", entries: [{ slug: "core", body: "x" }] },
    }),
  ).toThrow("Invalid snapshot manifest");
  expect(() =>
    parse({
      ...manifest,
      memory: {
        level: "everything",
        entries: [{ slug: "mem/../oops", body: "x" }],
      },
    }),
  ).toThrow("Invalid snapshot manifest");
  expect(() =>
    parse({
      ...manifest,
      memory: {
        level: "core",
        entries: [{ slug: "core", body: "é".repeat(40000) }],
      },
    }),
  ).toThrow("Invalid snapshot manifest");
  expect(() => parse({ ...manifest, version: 2 })).toThrow(
    "Unsupported snapshot version",
  );
  const png = encodeAgentSnapshot(manifest, "png");
  png[20] = (png[20] ?? 0) ^ 1;
  expect(() => parseAgentSnapshot(png)).toThrow("Invalid PNG snapshot");
});

it.each(["json", "png"] as const)(
  "accepts reference-serde v1 field casing and parallelism in %s",
  (format) => {
    // Reference AgentSnapshotDefinition derives serde camelCase; source_is_builtin
    // serializes as sourceIsBuiltin and parallelism is always emitted by build_snapshot.
    const reference = {
      format: "buzz-agent-snapshot",
      version: 1,
      definition: {
        name: "Reference",
        sourceIsBuiltin: false,
        systemPrompt: "Review changes.",
        parallelism: 1,
      },
      profile: { displayName: "Reference" },
      memory: { level: "none" },
    };
    const manifest = parse(reference);
    expect(
      parseAgentSnapshot(encodeAgentSnapshot(manifest, format)).definition,
    ).toMatchObject(reference.definition);
    expect(manifest.definition.sessionPolicy).toBeUndefined(); // reference omission means channel
  },
);

it.each([1, 4])(
  "round trips reference parallelism %i through projected native saved settings",
  (workers) => {
    const reference = buildAgentSnapshot(portableAgent());
    reference.definition.parallelism = workers;
    // AgentEdit.environment persists the imported count. The native snapshot
    // exposes its effective numeric count, not its write-only environment value.
    const native = portableAgent();
    native.harness.environmentKeys = ["BUZZ_ACP_AGENTS"];
    native.launchParallelism = workers;
    for (const format of ["json", "png"] as const) {
      const first = parseAgentSnapshot(encodeAgentSnapshot(reference, format));
      expect(first.definition.parallelism).toBe(workers);
      const exported = buildAgentSnapshot(native);
      const second = parseAgentSnapshot(encodeAgentSnapshot(exported, format));
      expect(second.definition.parallelism).toBe(first.definition.parallelism);
      expect(second.definition.model).toBe(first.definition.model);
      expect(second.definition.provider).toBe(first.definition.provider);
    }
    native.harness.environmentKeys.push("PRIVATE_SETTING");
    expect(() => buildAgentSnapshot(native)).toThrow(
      /cannot be exported faithfully/,
    );
  },
);

it("uses effective nonsecret selectors rather than saved inherited blanks", () => {
  const agent = portableAgent();
  agent.harness.model = "";
  agent.harness.provider = "";
  agent.launchModel = "source-model";
  agent.launchProvider = "source-provider";
  expect(buildAgentSnapshot(agent).definition).toMatchObject({
    model: "source-model",
    provider: "source-provider",
  });
  agent.launchModelEnv = "BUZZ_AGENT_MODEL";
  expect(() => buildAgentSnapshot(agent)).toThrow(
    /cannot be exported faithfully/,
  );
});

it("blocks credential-like allowed values and unsupported source behavior at export", () => {
  const agent = portableAgent();
  agent.systemPrompt = "Use api_key=INERT_SENTINEL_12345678";
  expect(() => buildAgentSnapshot(agent)).toThrow(/credential/);
  agent.systemPrompt = "Review changes.";
  agent.respondTo = "anyone";
  expect(() => buildAgentSnapshot(agent)).toThrow(
    /cannot be exported faithfully/,
  );
  agent.respondTo = "owner-only";
  agent.harness.command = "goose";
  expect(() => buildAgentSnapshot(agent)).toThrow(
    /cannot be exported faithfully/,
  );
});

it("resolves inherited source session policy and rejects invisible prompt controls", () => {
  const inherited = portableAgent();
  inherited.sessionPolicy = null;
  expect(
    buildAgentSnapshot(inherited, "none", [], "channel").definition
      .sessionPolicy,
  ).toBe("channel");
  expect(() => buildAgentSnapshot(inherited)).toThrow(
    /cannot be exported faithfully/,
  );
  const manifest = buildAgentSnapshot(portableAgent());
  for (const character of ["\u202e", "\u200b", "\u{e0061}"]) {
    expect(() =>
      parse({
        ...manifest,
        definition: {
          ...manifest.definition,
          systemPrompt: `Review${character} this.`,
        },
      }),
    ).toThrow(/Invalid snapshot manifest/);
  }
  expect(
    parse({
      ...manifest,
      definition: { ...manifest.definition, systemPrompt: "Review 👩‍💻 ❤️" },
    }).definition.systemPrompt,
  ).toBe("Review 👩‍💻 ❤️");
});

it("uses supplied PNG artwork as pixels and never copies its snapshot metadata", () => {
  const manifest = buildAgentSnapshot(portableAgent());
  const artwork = encodeAgentSnapshot(manifest, "png");
  const image = encodeAgentSnapshot(
    { ...manifest, profile: { displayName: "Another" } },
    "png",
    artwork,
  );
  expect(parseAgentSnapshot(image).profile.displayName).toBe("Another");
  const text = new TextDecoder().decode(image);
  expect(text.match(/buzz_agent_snapshot/g)).toHaveLength(1);
});

it("rejects escaped memory event overflow before identity creation", () => {
  const source = buildAgentSnapshot(portableAgent(), "core", []);
  const body = "\\".repeat(40_000);
  expect(restorableMemoryEntry("core", body)).toBe(false);
  expect(() =>
    parse({
      ...source,
      memory: { level: "core", entries: [{ slug: "core", body }] },
    }),
  ).toThrow("Invalid snapshot manifest");
  expect(() =>
    encodeAgentSnapshot(
      {
        ...source,
        memory: { level: "core", entries: [{ slug: "core", body }] },
      },
      "json",
    ),
  ).toThrow("Invalid snapshot manifest");
});

it("detects transparent PNG placeholders and ignores JSON artwork", async () => {
  const manifest = buildAgentSnapshot(portableAgent());
  const empty = encodeAgentSnapshot(manifest, "png");
  expect(await snapshotPngArtwork(empty)).toBeUndefined();
  expect(
    await snapshotPngArtwork(encodeAgentSnapshot(manifest, "json")),
  ).toBeUndefined();
  expect(
    await snapshotPngArtwork(encodeAgentSnapshot(manifest, "png", empty)),
  ).toBeUndefined();
});

it("rejects aggregate reader DTO overflow even when entry array fits", () => {
  const source = buildAgentSnapshot(portableAgent());
  const entries = Array.from({ length: 40 }, (_, i) => ({
    slug: `mem/${i}`,
    body: "x".repeat(30_000),
  }));
  const manifest = { ...source, memory: { level: "everything", entries } };
  expect(restorableMemoryEntry("mem/0", "x".repeat(30_000))).toBe(true);
  expect(() => parse(manifest)).toThrow("Invalid snapshot manifest");
  expect(() =>
    parse({
      ...manifest,
      memory: { level: "everything", entries: entries.slice(0, 30) },
    }),
  ).not.toThrow();
});

it("passes validated PNG artwork to the avatar sanitizer without changing pixels", async () => {
  const source = buildAgentSnapshot(portableAgent());
  const pixels = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII=",
    ),
    (char) => char.charCodeAt(0),
  );
  const png = encodeAgentSnapshot(source, "png", pixels);
  const extracted = await snapshotPngArtwork(png);
  expect(extracted).toEqual(png);
  expect(new TextDecoder().decode(extracted)).toContain("buzz_agent_snapshot");
});

// Build CRC-valid PNG chunks without relying on the reference encoder's zlib output.
function pngChunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(data.length + 12);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(utf8.encode(type), 4);
  out.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of out.subarray(4, 8 + data.length)) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  new DataView(out.buffer).setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0);
  return out;
}
function replacePngPixels(
  source: Uint8Array,
  update: (type: string, data: Uint8Array) => Uint8Array[],
) {
  const parts: Uint8Array[] = [source.slice(0, 8)];
  for (let at = 8; at < source.length; ) {
    const size = new DataView(source.buffer, source.byteOffset).getUint32(at);
    const type = new TextDecoder().decode(source.subarray(at + 4, at + 8));
    parts.push(...update(type, source.subarray(at + 8, at + 8 + size)));
    at += size + 12;
  }
  const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

it("retains indexed PNG palette and transparency for avatar sanitization", async () => {
  const source = buildAgentSnapshot(portableAgent());
  const original = encodeAgentSnapshot(source, "png");
  const indexed = replacePngPixels(original, (type, data) => {
    if (type === "IHDR") {
      const header = data.slice();
      header[9] = 3;
      return [
        pngChunk(type, header),
        pngChunk("PLTE", new Uint8Array([255, 0, 0, 0, 0, 255])),
        pngChunk("tRNS", new Uint8Array([0, 255])),
      ];
    }
    if (type === "IDAT")
      return [pngChunk(type, deflateSync(new Uint8Array([0, 0])))];
    return [pngChunk(type, data)];
  });
  const extracted = await snapshotPngArtwork(indexed);
  if (!extracted) throw new Error("Indexed artwork was lost");
  const kinds: string[] = [];
  replacePngPixels(extracted, (type, data) => {
    kinds.push(type);
    return [pngChunk(type, data)];
  });
  expect(kinds).toEqual(["IHDR", "PLTE", "tRNS", "tEXt", "IDAT", "IEND"]);
});

it("refuses animated ICC and oriented EXIF before stripping metadata", async () => {
  const original = encodeAgentSnapshot(
    buildAgentSnapshot(portableAgent()),
    "png",
  );
  const exif = new Uint8Array(28);
  exif.set(utf8.encode("Exif\0\0II"));
  const tiff = new DataView(exif.buffer, 6);
  tiff.setUint16(2, 42, true);
  tiff.setUint32(4, 8, true);
  tiff.setUint16(8, 1, true);
  tiff.setUint16(10, 0x112, true);
  tiff.setUint16(12, 3, true);
  tiff.setUint32(14, 1, true);
  tiff.setUint16(18, 6, true);
  for (const [kind, payload, reason] of [
    ["iCCP", utf8.encode("profile"), "ICC"],
    ["eXIf", exif, "EXIF orientation"],
  ] as const) {
    const animated = replacePngPixels(original, (type, data) =>
      type === "IHDR"
        ? [
            pngChunk(type, data),
            pngChunk("acTL", new Uint8Array(8)),
            pngChunk(kind, payload),
          ]
        : [pngChunk(type, data)],
    );
    await expect(snapshotPngArtwork(animated)).rejects.toThrow(reason);
  }
});

it("retains a painted later animation frame despite a transparent first frame", async () => {
  const original = encodeAgentSnapshot(
    buildAgentSnapshot(portableAgent()),
    "png",
  );
  const animated = replacePngPixels(original, (type, data) =>
    type === "IHDR"
      ? [
          pngChunk(type, data),
          pngChunk("acTL", new Uint8Array(8)),
          pngChunk("fcTL", new Uint8Array(26)),
        ]
      : type === "IEND"
        ? [
            pngChunk("fcTL", new Uint8Array(26)),
            pngChunk("fdAT", new Uint8Array([0, 0, 0, 1, 255])),
            pngChunk(type, data),
          ]
        : [pngChunk(type, data)],
  );
  const artwork = await snapshotPngArtwork(animated);
  expect(artwork).toBeDefined();
  if (!artwork) throw new Error("Animated artwork was lost");
  const kinds: string[] = [];
  replacePngPixels(artwork, (type, data) => {
    kinds.push(type);
    return [pngChunk(type, data)];
  });
  expect(kinds).toEqual([
    "IHDR",
    "acTL",
    "fcTL",
    "tEXt",
    "IDAT",
    "fcTL",
    "fdAT",
    "IEND",
  ]);
});

it("keeps a transparent placeholder when its scanline is malformed", async () => {
  const source = buildAgentSnapshot(portableAgent());
  const image = replacePngPixels(
    encodeAgentSnapshot(source, "png"),
    (type, data) =>
      type === "IDAT"
        ? [pngChunk(type, deflateSync(new Uint8Array([0, 0, 0, 0, 0, 0])))]
        : [pngChunk(type, data)],
  );
  await expect(snapshotPngArtwork(image)).rejects.toThrow(
    "Invalid snapshot artwork",
  );
});

it("recognizes differently compressed transparent placeholders, not painted 1x1 art", async () => {
  const source = buildAgentSnapshot(portableAgent());
  const original = encodeAgentSnapshot(source, "png");
  for (const alpha of [0, 255]) {
    const image = replacePngPixels(original, (type, data) =>
      type === "IDAT"
        ? [pngChunk(type, deflateSync(new Uint8Array([0, 0, 0, 0, alpha])))]
        : [pngChunk(type, data)],
    );
    expect(await snapshotPngArtwork(image)).toEqual(
      alpha === 0 ? undefined : image,
    );
  }
});

it("fails closed when the host cannot attest portable native settings", () => {
  const source = portableAgent();
  delete source.snapshotExportLimitations;
  expect(() => buildAgentSnapshot(source)).toThrow(
    "cannot be exported faithfully",
  );
  source.snapshotExportLimitations = ["team instructions"];
  expect(() => buildAgentSnapshot(source)).toThrow(
    "cannot be exported faithfully",
  );
  source.snapshotExportLimitations = [];
  expect(buildAgentSnapshot(source).definition.name).toBe(source.name);
});

it("names inherited effort without exposing unexpected native verdict values", () => {
  const source = portableAgent();
  source.snapshotExportLimitations = ["effort level"];
  expect(() => buildAgentSnapshot(source)).toThrow(
    /effort level.*Agent defaults/,
  );
  source.snapshotExportLimitations = ["team instructions", "idle timeout"];
  expect(() => buildAgentSnapshot(source)).toThrow(
    /team instructions, idle timeout.*Remove the listed settings/,
  );
  source.snapshotExportLimitations = ["behavioral environment overrides"];
  expect(() => buildAgentSnapshot(source)).toThrow(
    /behavioral environment overrides/,
  );
  source.snapshotExportLimitations = ["private native text"];
  expect(() => buildAgentSnapshot(source)).toThrow(
    "This agent cannot be exported faithfully.",
  );
  expect(() => buildAgentSnapshot(source)).not.toThrow("private native text");
});

it("accepts exact per-event plaintext boundary, rejects first byte beyond", () => {
  const source = buildAgentSnapshot(portableAgent());
  const make = (size: number) => ({
    ...source,
    memory: {
      level: "everything",
      entries: [{ slug: "mem/a", body: "x".repeat(size) }],
    },
  });
  let low = 0,
    high = 65_535;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (restorableMemoryEntry("mem/a", "x".repeat(middle))) low = middle;
    else high = middle - 1;
  }
  expect(() => parse(make(low))).not.toThrow();
  expect(() => parse(make(low + 1))).toThrow("Invalid snapshot manifest");
});

it("rejects hidden standing memory in both formats while allowing multilingual context", () => {
  const source = buildAgentSnapshot(portableAgent(), "core", []);
  for (const character of ["\u202e", "\u200b", "\u{e0061}"]) {
    const hidden = {
      ...source,
      memory: {
        level: "core" as const,
        entries: [{ slug: "core", body: `Before${character}after` }],
      },
    };
    expect(() => parse(hidden)).toThrow("Invalid snapshot manifest");
    for (const format of ["json", "png"] as const)
      expect(() => encodeAgentSnapshot(hidden, format)).toThrow(
        "Invalid snapshot manifest",
      );
  }
  const visible = {
    ...source,
    definition: {
      ...source.definition,
      systemPrompt: "فارسی‌زبان\r\nनमस्ते\u200dदुनिया 👩‍💻 “അവന്‍” അവന്‍। വന്നു",
    },
    memory: {
      level: "core" as const,
      entries: [
        {
          slug: "core",
          body: "فارسی‌زبان\r\nनमस्ते\u200dदुनिया 👩‍💻 “അവന്‍” അവന്‍। വന്നു",
        },
      ],
    },
  };
  for (const format of ["json", "png"] as const)
    expect(
      parseAgentSnapshot(encodeAgentSnapshot(visible, format)).memory.entries,
    ).toEqual(visible.memory.entries);
});
