// @vitest-environment node
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { McpHandler, HostMcpServer } from "../../features/host/service";
import { AppServer } from "./rpc";
import { nativeHookState } from "./hooks";
import { callbackHookArgs, openHookBridge } from "./hook-bridge";

const binary = process.env.CODEX_FACADE_BINARY;
it.skipIf(!binary)(
  "blocks a real Codex native command through its thread-bound callback",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "buzz-hook-facade-"));
    const marker = join(home, "executed");
    const servers: ReturnType<typeof createServer>[] = [];
    const listen = async (
      handler: (
        req: IncomingMessage,
        res: ServerResponse,
      ) => void | Promise<void>,
    ) => {
      const server = createServer(handler);
      servers.push(server);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No address");
      return `http://127.0.0.1:${address.port}`;
    };
    const serve = async (handler: McpHandler): Promise<HostMcpServer> => {
      const token = crypto.randomUUID();
      const url = await listen(async (req, res) => {
        if (req.headers.authorization !== `Bearer ${token}`) {
          res.writeHead(401);
          res.end();
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        let body = "";
        for await (const data of req) body += data;
        const wire = JSON.parse(body);
        if (wire.id == null) {
          res.writeHead(202);
          res.end();
          return;
        }
        try {
          const result = await handler(wire);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: wire.id,
              error: { code: -32603, message: String(error) },
            }),
          );
        }
      });
      return {
        url: `${url}/mcp`,
        headers: [{ name: "Authorization", value: `Bearer ${token}` }],
        close: async () => {},
        closed: new Promise(() => {}),
      };
    };
    let requests = 0;
    const model = await listen(async (req, res) => {
      for await (const _data of req) {
        /* drain */
      }
      requests++;
      const item =
        requests === 1
          ? {
              id: "fc_1",
              type: "function_call",
              call_id: "call_1",
              name: "exec_command",
              arguments: JSON.stringify({
                cmd: `touch ${marker}`,
                max_output_tokens: 100,
              }),
            }
          : {
              id: "msg_done",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "Done", annotations: [] }],
            };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [type, data] of [
        [
          "response.created",
          {
            response: {
              id: `r${requests}`,
              object: "response",
              status: "in_progress",
              output: [],
            },
          },
        ],
        ["response.output_item.added", { output_index: 0, item }],
        ["response.output_item.done", { output_index: 0, item }],
        [
          "response.completed",
          {
            response: {
              id: `r${requests}`,
              object: "response",
              status: "completed",
              output: [item],
              usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
            },
          },
        ],
      ])
        res.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`,
        );
      res.end();
    });
    const observed: string[] = [];
    const bridge = await openHookBridge(serve, async (_session, event) => {
      observed.push(event);
      return event === "PreToolUse"
        ? {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "Fixture blocks the command",
            },
          }
        : {};
    });
    const rpc = new AppServer();
    let stderr = "";
    try {
      await rpc.open(async (_id, options) => {
        const child = spawn(
          binary ?? "",
          [
            "app-server",
            ...callbackHookArgs,
            "-c",
            'model_provider="fixture"',
            "-c",
            `model_providers.fixture={name="Fixture",base_url="${model}",wire_api="responses",requires_openai_auth=false}`,
          ],
          {
            env: { ...process.env, CODEX_HOME: home },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        child.stdout.on("data", (data) => options?.onStdout?.(data.toString()));
        child.stderr.on("data", (data) => {
          stderr += data.toString();
          options?.onStderr?.(data.toString());
        });
        return {
          write: async (text) => {
            child.stdin.write(text);
          },
          end: async () => {
            child.stdin.end();
          },
          kill: async () => {
            child.kill();
          },
          exited: new Promise((resolve) => child.on("exit", resolve)),
        };
      }, home);
      const state = await nativeHookState(rpc, home);
      const started = await rpc.request<{ thread: { id: string } }>(
        "thread/start",
        {
          cwd: home,
          model: "gpt-5.4",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          ephemeral: true,
          config: {
            mcp_servers: bridge.config,
            "hooks.state": state,
            "features.hooks": true,
            "features.plugins": false,
            "features.apps": false,
            web_search: "disabled",
          },
        },
      );
      bridge.bind(started.thread.id);
      let done!: () => void;
      const completed = new Promise<void>((resolve) => {
        done = resolve;
      });
      rpc.onMessage((wire) => {
        if (wire.method === "turn/completed") done();
      });
      await rpc.request("turn/start", {
        threadId: started.thread.id,
        input: [{ type: "text", text: "Run fixture", text_elements: [] }],
      });
      await completed;
      expect(observed, stderr).toContain("PreToolUse");
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await bridge.close();
      await rpc.close();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
      await rm(home, { recursive: true, force: true });
    }
  },
  60_000,
);
