// @vitest-environment node
// Drives a real `goose-acp` with the owner's goose config: run with
// GOOSE_ACP_BIN=/path/to/goose-acp. The Buzz tools are listed as the app lists
// them; their calls are recorded, not sent to a relay.
import { spawn as spawnChild } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { respond } from "../../buzz-mcp/rpc";
import type { HostProcessOptions } from "../../features/host/service";
import { systemPrompt } from "../claude-code/prompt";
import { GooseProcess, type Spawn, type ToolServer } from "./goose";
import { GooseSetup } from "./setup";

const BIN = process.env.GOOSE_ACP_BIN;

const spawn: Spawn = async (_id, options: HostProcessOptions = {}) => {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(options.env ?? {}))
    if (value === null) delete env[key];
    else env[key] = value;
  const child = spawnChild(BIN ?? "goose-acp", [], {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8").on("data", (data) => {
    if (process.env.GOOSE_ACP_DEBUG) process.stderr.write(`<< ${data}`);
    options.onStdout?.(data);
  });
  child.stderr.setEncoding("utf8").on("data", (data) => {
    if (process.env.GOOSE_ACP_DEBUG) process.stderr.write(data);
    options.onStderr?.(data);
  });
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  return {
    write: (data) =>
      new Promise<void>((resolve, reject) =>
        child.stdin.write(data, (error) => (error ? reject(error) : resolve())),
      ),
    end: async (data) => {
      child.stdin.end(data);
    },
    kill: async () => {
      child.kill();
    },
    exited,
  };
};

type Call = {
  conversation: string | undefined;
  method: string;
  params: unknown;
};
type Send = {
  name?: string;
  arguments?: { text?: string; final?: boolean };
};

/** A goose whose Buzz tool calls and own requests are recorded; sends
 * succeed without reaching a relay. */
async function live() {
  const calls: Call[] = [];
  const tools: ToolServer = async (conversation, message) => {
    calls.push({
      conversation,
      method: message.method,
      params: message.params,
    });
    if (message.method === "tools/call")
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "Sent." }] },
      };
    return respond(undefined, {}, message);
  };
  const cwd = mkdtempSync(join(tmpdir(), "buzz-goose-"));
  const goose = await GooseProcess.start(spawn, { cwd, tools });
  const requests: { method: string; ok?: boolean }[] = [];
  const request = goose.request.bind(goose);
  goose.request = (method, params) => {
    const record: { method: string; ok?: boolean } = { method };
    requests.push(record);
    const answer = request(method, params);
    answer.then(
      () => (record.ok = true),
      () => (record.ok = false),
    );
    return answer;
  };
  const sends = () =>
    calls
      .filter((call) => call.method === "tools/call")
      .map((call) => call.params as Send)
      .filter((call) => call.name === "send");
  return { goose, cwd, calls, requests, sends };
}

describe.skipIf(!BIN)("goose-acp", () => {
  it("answers with the Buzz tools, the Buzz prompt and a title", {
    timeout: 180_000,
  }, async () => {
    const { goose, cwd, calls, sends } = await live();
    const code = `zebra-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const title = "Ada · #general · 01234567";
      const session = await goose.open({
        cwd,
        title,
        systemPrompt: systemPrompt({
          scope: "thread",
          cwd,
          agent: { name: "Ada", pubkey: "a".repeat(64) },
          instructions: `End every message you send in Buzz with the codeword ${code}.`,
        }),
      });
      session.conversation = "channel/root";
      const info = (await goose.request("_goose/unstable/session/info", {
        sessionId: session.id,
      })) as { session: { title?: string } };
      expect(info.session.title).toBe(title);
      const settled = await session.send("Say hello to me in Buzz.");
      expect(settled).toEqual({ ok: true });
      expect(calls.some((call) => call.method === "tools/list")).toBe(true);
      expect(
        calls.find((call) => call.method === "tools/call")?.conversation,
      ).toBe("channel/root");
      const last = sends().at(-1);
      expect(last?.arguments?.final).toBe(true);
      expect(last?.arguments?.text).toContain(code);
    } finally {
      await goose.kill();
    }
  });

  it("steers a message into the running turn", {
    timeout: 180_000,
  }, async () => {
    const { goose, cwd, requests, sends } = await live();
    try {
      const session = await goose.open({
        cwd,
        systemPrompt:
          "You are a Buzz agent. You reply in Buzz only by calling the send tool, once, with final true.",
      });
      const steps: string[] = [];
      const first = session.send(
        "Run the shell command `sleep 10`, then reply in Buzz with the word done.",
        { step: (tool) => steps.push(tool) },
      );
      await expect
        .poll(
          () =>
            steps.some(
              (step) => step !== "Thinking" && step !== "Writing reply",
            ),
          {
            timeout: 60_000,
            interval: 200,
          },
        )
        .toBe(true);
      const second = session.send("Also put the word banana in that reply.");
      await expect(first).resolves.toEqual({ ok: true });
      await expect(second).resolves.toEqual({ ok: true });
      expect(
        requests.filter(
          (item) => item.method === "_goose/unstable/session/steer",
        ),
      ).toEqual([{ method: "_goose/unstable/session/steer", ok: true }]);
      expect(
        requests.filter((item) => item.method === "session/prompt"),
      ).toHaveLength(1);
      expect(sends().at(-1)?.arguments?.text?.toLowerCase()).toContain(
        "banana",
      );
    } finally {
      await goose.kill();
    }
  });

  it("lists goose's providers and tests its default one", {
    timeout: 120_000,
  }, async () => {
    // goose resolves `~` with the workspace process, which prints the folder.
    const setup = new GooseSetup(async (id, options = {}) => {
      if (id !== "workspace") return spawn(id, options);
      queueMicrotask(() =>
        options.onStdout?.(`${String(options.cwd).replace(/^~/, homedir())}\n`),
      );
      return {
        write: async () => undefined,
        end: async () => undefined,
        kill: async () => undefined,
        exited: Promise.resolve(0),
      };
    });
    const { providers, defaults } = await setup.providers();
    expect(providers.length).toBeGreaterThan(0);
    expect(providers.some((item) => item.keys.length > 0)).toBe(true);
    expect(await setup.test({ provider: "", model: "" })).toEqual({
      ok: true,
      message: "Connected",
    });
    if (defaults.provider)
      expect(
        await setup.test({
          provider: defaults.provider,
          model: "no-such-model-xyz",
        }),
      ).toMatchObject({ ok: false });
  });
});
