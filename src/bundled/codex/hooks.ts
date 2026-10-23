import type { Host, HostMcpServer } from "../../features/host/service";
import type { AppServer } from "./rpc";

export function hookToolName(name: string) {
  return name.startsWith("buzz") ? `mcp__buzz__${name.slice(4)}` : name;
}

const SERVER = "buzz_tool_hooks";
const TOOL = "before_tool";
/** JSON values as TOML inline values, for Codex's process-local overrides. */
const toml = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

/** An authenticated host transport. Only pre-tool evaluation is exposed over
 * MCP: a model calling this tool cannot forge a successful tool completion. */
export class CodexHooks {
  private server: HostMcpServer | undefined;
  private closed = false;
  constructor(
    private readonly serve: NonNullable<Host["serveMcp"]>,
    private readonly before: (
      input: Record<string, unknown>,
    ) => Promise<string | undefined>,
  ) {}
  async open() {
    const server = await this.serve(async (value) => {
      const wire = value as {
        id?: string | number;
        method?: string;
        params?: Record<string, unknown>;
      };
      const result = (result: unknown) => ({
        jsonrpc: "2.0",
        id: wire.id ?? 0,
        result,
      });
      if (wire.method === "initialize")
        return result({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: SERVER, version: "1" },
        });
      if (wire.method === "tools/list")
        return result({
          tools: [
            {
              name: TOOL,
              description: "Evaluate the host's pre-tool hooks.",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: true,
              },
            },
          ],
        });
      if (wire.method !== "tools/call") return result({});
      let reason: string | undefined;
      try {
        if (wire.params?.name !== TOOL) throw new Error("Unknown hook tool");
        reason = await this.before(
          (wire.params.arguments ?? {}) as Record<string, unknown>,
        );
      } catch (error) {
        reason = String(error);
      }
      return result({
        content: [
          {
            type: "text",
            text: JSON.stringify(reason ? { decision: "block", reason } : {}),
          },
        ],
      });
    });
    if (this.closed) {
      await server.close();
      throw new Error("The Codex hook bridge was closed");
    }
    this.server = server;
    const input = Object.fromEntries(
      ["session_id", "turn_id", "tool_use_id", "tool_name", "tool_input"].map(
        (key) => [key, `\${${key}}`],
      ),
    );
    return [
      "-c",
      `hooks.PreToolUse=${toml([{ matcher: ".*", hooks: [{ type: "mcp_tool", server: SERVER, tool: TOOL, input, timeout: 30 }] }])}`,
    ];
  }
  /** Trust only the exact bridge definition returned by this running binary.
   * Keep it in thread config; never write the user's persisted hook trust. */
  async config(rpc: AppServer, cwd: string) {
    if (!this.server) throw new Error("The Codex hook bridge is unavailable");
    const listed = await rpc.request<{
      data: {
        hooks: {
          key: string;
          currentHash: string;
          source: string;
          server?: string;
          tool?: string;
          eventName: string;
        }[];
      }[];
    }>("hooks/list", { cwds: [cwd] });
    const own = listed.data
      .flatMap((row) => row.hooks)
      .filter(
        (hook) =>
          hook.server === SERVER &&
          hook.tool === TOOL &&
          hook.eventName === "preToolUse" &&
          hook.source === "sessionFlags",
      );
    if (own.length !== 1)
      throw new Error(
        "This Codex version did not register Buzz's pre-tool hook",
      );
    return {
      server: {
        url: this.server.url,
        http_headers: Object.fromEntries(
          this.server.headers.map(({ name, value }) => [name, value]),
        ),
        enabled: true,
        required: true,
      },
      state: Object.fromEntries(
        own.map((hook) => [
          hook.key,
          { enabled: true, trusted_hash: hook.currentHash },
        ]),
      ),
    };
  }
  async close() {
    this.closed = true;
    const server = this.server;
    this.server = undefined;
    await server?.close();
  }
}
export const HOOK_SERVER = SERVER;
