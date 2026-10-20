// @vitest-environment node
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../bundled/claude-code/runtime";
import { defaults as codexDefaults } from "../bundled/codex/config";
import { localStore } from "../features/agents/store";
import { checkKind, claudeResolver, codexResolver, KINDS } from "./host";
import { stateStorage } from "./storage";

it("publishes the kinds the app's custody signs, and no others", () => {
  const source = readFileSync(
    join(__dirname, "../../crates/agent-controller/src/app_agent.rs"),
    "utf8",
  );
  const native = /const KINDS: \[u16; \d+\] = \[([^\]]*)\]/.exec(source)?.[1];
  expect(native).toBeDefined();
  expect(KINDS).toEqual(
    native
      ?.split(",")
      .map((kind) => kind.trim())
      .filter(Boolean)
      .map(Number),
  );
  // A channel tool's creation and edit, and typing.
  for (const kind of [9007, 9002, 20002])
    expect(() => checkKind(kind)).not.toThrow();
  expect(() => checkKind(0)).toThrow("Agents cannot publish kind 0");
  expect(() => checkKind(1)).toThrow("Agents cannot publish kind 1");
});

it("resolves blank settings from the owner's saved defaults, as they are now", () => {
  const storage = stateStorage(mkdtempSync(join(tmpdir(), "agent-host-")));
  const claude = claudeResolver(localStore(storage));
  const codex = codexResolver(localStore(storage));
  // Without saved defaults, the CLI's own.
  expect(claude(DEFAULT_CONFIG).model).toBe("");
  expect(codex(codexDefaults)).toMatchObject({ model: "", effort: "" });
  // The app saves defaults while the host runs.
  storage.setItem(
    "buzz.claude-code.provider-defaults.v1",
    JSON.stringify({ version: 1, model: "sonnet" }),
  );
  storage.setItem(
    "buzz.codex.provider-defaults.v1",
    JSON.stringify({ version: 1, model: "gpt-5", effort: "high" }),
  );
  expect(claude(DEFAULT_CONFIG).model).toBe("sonnet");
  expect(codex(codexDefaults)).toMatchObject({
    model: "gpt-5",
    effort: "high",
  });
  // An agent's own choice wins.
  expect(claude({ ...DEFAULT_CONFIG, model: "opus" }).model).toBe("opus");
  expect(codex({ ...codexDefaults, model: "o3", effort: "low" })).toMatchObject(
    { model: "o3", effort: "low" },
  );
});
