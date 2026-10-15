// @vitest-environment node
// Drives a real `goose-acp` with the owner's goose config: run with
// GOOSE_ACP_BIN=/path/to/goose-acp. The Buzz tools are listed as the app lists
// them, from a loopback HTTP MCP server that follows the app's native one;
// their calls are recorded, not sent to a relay.
import { spawn as spawnChild } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { respond } from "../../buzz-mcp/rpc";
import {
  answerMcp,
  type HostProcessOptions,
} from "../../features/host/service";
import { systemPrompt } from "../claude-code/prompt";
import {
  GooseProcess,
  type ServeMcp,
  type Spawn,
  type ToolServer,
} from "./goose";
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

/** The HTTP requests the MCP servers received, by method and status. */
const hits: { method: string; status: number }[] = [];

const method = (body: string): unknown => {
  try {
    return (JSON.parse(body) as { method?: unknown } | null)?.method;
  } catch {
    return undefined;
  }
};

/** What the app's native listener does: a token per server, 404 for a wrong
 * one, 405 for `GET`, and a JSON reply or 202 for each `POST /mcp`. An
 * `initialize` that succeeds claims the server's one session, and later
 * requests must name it; before it, only discovery and `ping` are answered. A
 * second `initialize` stops the server. */
const serve: ServeMcp = async (handler) => {
  const token = randomBytes(32).toString("base64url");
  const session = randomBytes(32).toString("base64url");
  let claim: "unclaimed" | "claiming" | "claimed" = "unclaimed";
  const server = createServer((request, response) => {
    let joined = false;
    const end = (status: number, body?: string) => {
      hits.push({ method: request.method ?? "", status });
      response.writeHead(status, {
        ...(joined && (status === 200 || status === 202)
          ? { "Mcp-Session-Id": session }
          : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      });
      response.end(body);
    };
    if (
      request.url?.split("?")[0] !== "/mcp" ||
      request.headers.authorization !== `Bearer ${token}`
    )
      return end(404);
    if (request.method !== "POST") return end(405);
    const named = request.headers["mcp-session-id"];
    if (named !== undefined && (named !== session || claim !== "claimed"))
      return end(404);
    let body = "";
    request.setEncoding("utf8").on("data", (data) => (body += data));
    request.on("end", async () => {
      const kind = method(body);
      const claiming = named === undefined && kind === "initialize";
      if (claiming) {
        if (claim !== "unclaimed") {
          server.close();
          return end(404);
        }
        claim = "claiming";
      } else if (named === undefined) {
        // goose first asks `server/discover`.
        if (
          claim === "claimed" ||
          (kind !== "server/discover" && kind !== "ping")
        )
          return end(404);
      } else joined = true;
      const reply = await answerMcp(handler, body);
      if (claiming) {
        joined =
          (reply as { result?: unknown } | undefined)?.result !== undefined;
        claim = joined ? "claimed" : "unclaimed";
      }
      end(reply === undefined ? 202 : 200, JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const closed = new Promise<void>((resolve) =>
    server.on("close", () => resolve()),
  );
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    close: async () => {
      server.closeAllConnections();
      server.close();
    },
    closed,
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
  const goose = await GooseProcess.start(spawn, { cwd, tools, serve });
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
      // goose reached the tools over HTTP with the token, and no request was
      // refused.
      expect(hits.some((hit) => hit.status === 200)).toBe(true);
      expect(hits.filter((hit) => hit.status === 404)).toEqual([]);
      // goose saves the token with the session; alone, it admits nothing.
      const server = session.server;
      if (!server) throw new Error("no Buzz MCP server");
      const stolen = await fetch(server.url, {
        method: "POST",
        headers: {
          ...Object.fromEntries(
            server.headers.map(({ name, value }) => [name, value]),
          ),
          "Content-Type": "application/json",
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      });
      expect(stolen.status).toBe(404);
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
