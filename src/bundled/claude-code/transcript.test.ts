import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { HostProcessOptions } from "../../features/host/service";
import manifest from "./manifest.json";
import { claudeTurns, projectName, readTranscript } from "./transcript";

const root = "c".repeat(64);
const conversation = { sessionId: "session-1", channelId: "channel", root };
const prompt = (content: string) =>
  `<context>\nScope: thread\n</context>\n\n<buzz-event type="mention">\nEvent ID: e\nFrom: Sam (npub: npub1x, hex: ${"a".repeat(64)})\nContent: ${content}\nTags: []\n</buzz-event>`;
let clock = 0;
const line = (type: string, content: unknown, extra = {}) =>
  JSON.stringify({
    type,
    uuid: `u${++clock}`,
    timestamp: new Date(clock * 1000).toISOString(),
    message: { role: type, content },
    ...extra,
  });
const file = () => {
  clock = 0;
  return [
    JSON.stringify({ type: "queue-operation" }),
    line("user", prompt("fix the tests")),
    line("assistant", [{ type: "thinking", thinking: "Run them first" }]),
    line("assistant", [
      {
        type: "tool_use",
        id: "t1",
        name: "Bash",
        input: { command: "pnpm test" },
      },
    ]),
    line("user", [
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: "1 failed",
        is_error: true,
      },
    ]),
    line("user", "<command-caveat>", { isMeta: true }),
    line("assistant", [{ type: "text", text: "from a subagent" }], {
      isSidechain: true,
    }),
    line(
      "user",
      `<new-message-arrived-while-you-were-working>\n${prompt("also lint")}\n</new-message-arrived-while-you-were-working>\n\nNote: A new message arrived.`,
    ),
    line("assistant", [
      {
        type: "tool_use",
        id: "t2",
        name: "Edit",
        input: { file_path: "/w/a.ts" },
      },
      { type: "text", text: "Fixed." },
    ]),
    "not json",
    line("user", [{ type: "text", text: prompt("thanks") }]),
    line("assistant", [{ type: "text", text: "Any time." }]),
  ].join("\n");
};

it("groups a session file into prompted turns with steering, tools and replies", () => {
  const turns = claudeTurns(file(), conversation, false);
  expect(turns.map((turn) => turn.items.map((item) => item.type))).toEqual([
    ["prompt", "thought", "tool", "prompt", "tool", "message"],
    ["prompt", "message"],
  ]);
  const [first, second] = turns;
  expect(first).toMatchObject({
    turnId: "u1",
    channelId: "channel",
    threadRootId: root,
    sessionId: "session-1",
    startedAt: 1000,
    endedAt: 8000,
    partial: false,
  });
  expect(first?.items[0]).toMatchObject({
    text: "fix the tests",
    author: "Sam",
    steer: false,
  });
  expect(first?.items[2]).toMatchObject({
    title: "pnpm test",
    kind: "execute",
    status: "failed",
    output: "1 failed",
    completedAt: 4000,
  });
  expect(first?.items[3]).toMatchObject({ text: "also lint", steer: true });
  expect(first?.items[4]).toMatchObject({
    title: "Edit",
    kind: "edit",
    status: "in_progress",
    paths: ["/w/a.ts"],
  });
  expect(second).toMatchObject({
    turnId: "u9",
    startedAt: 9000,
    endedAt: 10_000,
  });
  // A working session's last turn has not ended.
  expect(claudeTurns(file(), conversation, true).at(-1)).not.toHaveProperty(
    "endedAt",
  );
});

it("keeps steps before the first loaded prompt as a partial turn", () => {
  clock = 0;
  const [turn] = claudeTurns(
    line("assistant", [{ type: "text", text: "resumed" }]),
    { sessionId: "s", channelId: "dm" },
    false,
  );
  expect(turn).toMatchObject({ partial: true, threadRootId: null });
});

it("names projects as Claude Code does", () => {
  expect(projectName("/Users/me/.buzz")).toBe("-Users-me--buzz");
  expect(projectName("/Users/me/my_repo")).toBe("-Users-me-my-repo");
});

/** `workspace` prints the resolved folder; `read` serves `files` as base64. */
function host(files: Record<string, string>) {
  const reads: HostProcessOptions[] = [];
  const spawn = vi.fn(async (id: string, options: HostProcessOptions = {}) => {
    let code = 0;
    if (id === "workspace") options.onStdout?.("/Users/me/.buzz\n");
    if (id === "read") {
      reads.push(options);
      const path = options.args?.[0] ?? "";
      const content = files[path];
      if (content === undefined) {
        options.onStderr?.(`base64: ${path}: No such file or directory\n`);
        code = 1;
      } else options.onStdout?.(btoa(content));
    }
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      exited: Promise.resolve(code),
    };
  });
  return { spawn, reads };
}

it("reads the session file from the project of the agent's workspace", async () => {
  const { spawn, reads } = host({
    "./-Users-me--buzz/session-1.jsonl": file(),
  });
  const read = await readTranscript(
    spawn,
    "~/.buzz",
    conversation,
    false,
    new AbortController().signal,
  );
  expect(spawn).toHaveBeenCalledWith(
    "workspace",
    expect.objectContaining({ cwd: "~/.buzz" }),
  );
  expect(reads[0]).toMatchObject({
    cwd: "~/.claude/projects",
    args: ["./-Users-me--buzz/session-1.jsonl"],
  });
  expect(read).toMatchObject({ more: false, unknownThread: 0 });
  expect(read?.turns).toHaveLength(2);
});

it("treats a missing session file as no transcript, not a failure", async () => {
  const { spawn } = host({});
  await expect(
    readTranscript(
      spawn,
      "~/.buzz",
      conversation,
      false,
      new AbortController().signal,
    ),
  ).resolves.toBeUndefined();
});

it("passes this platform's base64 a session path it reads as a file", async () => {
  const { spawn, reads } = host({});
  await readTranscript(
    spawn,
    "~/.buzz",
    conversation,
    false,
    new AbortController().signal,
  );
  const path = reads[0]?.args?.[0] ?? "";
  const read = manifest.host.processes.find((process) => process.id === "read");
  const root = mkdtempSync(join(tmpdir(), "claude-projects-"));
  try {
    mkdirSync(join(root, "-Users-me--buzz"));
    writeFileSync(join(root, "-Users-me--buzz", "session-1.jsonl"), "{}\n");
    const output = execFileSync(
      read?.program ?? "",
      [...(read?.args ?? []), path],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(atob(output.replace(/\s/g, ""))).toBe("{}\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
