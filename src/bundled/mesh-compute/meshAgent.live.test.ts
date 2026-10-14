// @vitest-environment node
// Opt-in: real managed Goose + isolated deterministic OpenAI fixture, no relay or fleet.
import { spawn as spawnChild } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { finalizeEvent } from "nostr-tools/pure";
import { expect, it } from "vitest";
import type { HostProcessOptions } from "../../features/host/service";
import type { Delivery } from "../../features/agents/service";
import {
  MeshAgentRuntime,
  meshAgentConfig,
  type MeshAgentDeps,
} from "./meshAgent";
import { MeshHistory } from "./meshTranscript";

const binary = process.env.MESH_GOOSE_TEST_BIN;
it.skipIf(!binary)(
  "steers and reads persisted transcripts through the real managed Goose binary",
  async () => {
    if (!binary) throw new Error("MESH_GOOSE_TEST_BIN is required");
    const root = await mkdtemp(join(tmpdir(), "buzz-mesh-lifecycle-"));
    const children: ReturnType<typeof spawnChild>[] = [];
    const requests: Record<string, unknown>[] = [];
    const methods: string[] = [];
    let release!: () => void;
    let entered!: () => void;
    let steerStarted!: () => void;
    let steerFinished!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const steering = new Promise<void>((resolve) => {
      steerStarted = resolve;
    });
    const steered = new Promise<void>((resolve) => {
      steerFinished = resolve;
    });
    let steerId: number | undefined;
    let stderr = "";
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "mesh", object: "model", created: 1, owned_by: "fixture" },
            ],
          }),
        );
        return;
      }
      const body = JSON.parse(raw);
      requests.push(body);
      if (requests.length === 1) {
        entered();
        await gate;
      }
      const answer =
        requests.length === 1
          ? "Initial response."
          : "Updated requirement applied.";
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: object, finish_reason: string | null) => ({
          id: "fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "mesh",
          choices: [{ index: 0, delta, finish_reason }],
        });
        res.write(
          `data: ${JSON.stringify(chunk({ role: "assistant", content: answer }, null))}\n\n`,
        );
        res.end(
          `data: ${JSON.stringify(chunk({}, "stop"))}\n\ndata: [DONE]\n\n`,
        );
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "fixture",
            object: "chat.completion",
            created: 1,
            model: "mesh",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: answer },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          }),
        );
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    const spawn: MeshAgentDeps["spawn"] = async (
      id,
      options: HostProcessOptions = {},
    ) => {
      if (id === "workspace") {
        options.onStdout?.(`${root}\n`);
        return {
          write: async () => {},
          end: async () => {},
          kill: async () => {},
          exited: Promise.resolve(0),
        };
      }
      const env = { ...process.env };
      for (const [key, value] of Object.entries(options.env ?? {})) {
        if (value === null) delete env[key];
        else env[key] = value;
      }
      env.GOOSE_PATH_ROOT = root;
      const child = spawnChild(binary, [], { cwd: root, env, stdio: "pipe" });
      children.push(child);
      let buffer = "";
      child.stdout?.setEncoding("utf8").on("data", (data: string) => {
        options.onStdout?.(data);
        buffer += data;
        let end = buffer.indexOf("\n");
        while (end >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          end = buffer.indexOf("\n");
          try {
            const frame = JSON.parse(line);
            if (frame.id === steerId && frame.result) steerFinished();
          } catch {}
        }
      });
      child.stderr?.setEncoding("utf8").on("data", (data: string) => {
        stderr += data;
        options.onStderr?.(data);
      });
      const exited = new Promise<number | null>((resolve) =>
        child.once("exit", resolve),
      );
      return {
        exited,
        write: async (line: string) => {
          const frame = JSON.parse(line);
          methods.push(frame.method);
          if (frame.method.endsWith("/steer")) {
            steerId = frame.id;
            steerStarted();
          }
          await new Promise<void>((resolve, reject) =>
            child.stdin.write(line, (error) =>
              error ? reject(error) : resolve(),
            ),
          );
        },
        end: async () => {
          child.stdin?.end();
        },
        kill: async () => {
          child.kill();
          await exited;
        },
      };
    };
    const published: { content: string }[] = [];
    const runtime = new MeshAgentRuntime({
      spawn,
      origin: () => "fixture",
      prepare: async () => ({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "mesh",
        lease: "fixture",
      }),
      current: async () => true,
      chat: async () => "unused",
    });
    const controller = new AbortController();
    const agent = "b".repeat(64);
    const key = new Uint8Array(32).fill(1);
    const owner = finalizeEvent(
      { kind: 9, created_at: 1, content: "", tags: [] },
      key,
    ).pubkey;
    const delivery = (
      n: number,
    ): Delivery<ReturnType<typeof meshAgentConfig>> => ({
      config: meshAgentConfig({ buzz: false, workspace: root }),
      signal: controller.signal,
      channelId: "fixture-channel",
      current: () => true,
      workingUntil: () => {},
      agent: {
        pubkey: agent,
        owner,
        name: "Fixture",
        query: async () => [],
        publish: async (event: { content: string }) => {
          published.push(event);
          return event;
        },
      } as unknown as Delivery["agent"],
      trigger: {
        type: "mention",
        event: finalizeEvent(
          {
            kind: 9,
            created_at: n,
            content: n === 1 ? "Say hello" : "Use the updated requirement",
            tags: [
              ["h", "fixture-channel"],
              ["e", "c".repeat(64), "", "root"],
              ["e", "c".repeat(64), "", "reply"],
            ],
          },
          key,
        ),
      },
    });
    try {
      const first = runtime.run(delivery(1));
      await started;
      const second = runtime.run(delivery(2));
      await steering;
      await steered;
      release();
      await Promise.all([first, second]);
      expect(
        methods.filter((method) => method === "session/prompt"),
        stderr,
      ).toHaveLength(1);
      expect(published, stderr).toHaveLength(1);
      expect(JSON.stringify(requests)).toContain("Use the updated requirement");
      runtime.dispose();
      const history = new MeshHistory(spawn);
      const rows = await history.recent(agent, root, controller.signal);
      expect(rows, stderr).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error("Missing saved session");
      const transcript = await history.transcript(
        agent,
        root,
        row,
        controller.signal,
      );
      expect(JSON.stringify(transcript)).toContain("updated requirement");
      expect(transcript.turns.length).toBeGreaterThan(0);
    } finally {
      release();
      controller.abort();
      runtime.dispose();
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
