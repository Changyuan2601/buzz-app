import type { Host, HostMcpServer } from "../../features/host/service";
import type { AppServer } from "./rpc";

const SERVER = "buzz_hooks";

/** JSON values as TOML inline values, for Codex's process-local overrides. */
const toml = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`)
      .join(",")}}`;
  if (value === null)
    throw new Error("Codex hook configuration cannot contain null TOML values");
  return JSON.stringify(value);
};

/** Authenticated transport for native callbacks. MCP input is not evidence that
 * a tool completed: verified Buzz completions are observed by the runtime. */
export class CodexHooks {
  private readonly servers = new Set<HostMcpServer>();
  private closed = false;
  constructor(
    private readonly serve: NonNullable<Host["serveMcp"]>,
    private readonly run: (
      key: string,
      input: Record<string, unknown>,
      agent?: string,
    ) => Promise<unknown>,
    private readonly nativeHooks: import("../../features/agents/native-hooks").NativeHookConfig = {},
    callbacks: readonly import("../../features/agents/hooks").RegisteredAgentHook[] = [],
  ) {
    this.callbacks = callbacks.filter((hook) => hook.source !== "host");
  }
  private readonly callbacks: readonly import("../../features/agents/hooks").RegisteredAgentHook[];
  get busy() {
    return this.servers.size > 0;
  }
  async open() {
    const hooks = new Map<string, unknown[]>(
      Object.entries(this.nativeHooks).map(([event, entries]) => [
        event,
        [...entries],
      ]),
    );
    for (const [index, hook] of this.callbacks.entries()) {
      const entries = hooks.get(hook.event) ?? [];
      hooks.set(hook.event, entries);
      entries.push({
        matcher: hook.matcher ?? ".*",
        hooks: [
          {
            type: "mcp_tool",
            server: SERVER,
            tool: `callback_${index}`,
            input: hook.input ?? {},
            timeout: 30,
          },
        ],
      });
    }
    return [...hooks].flatMap(([name, entries]) => [
      "-c",
      `hooks.${/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)}=${toml(entries)}`,
    ]);
  }
  /** Trust only Buzz-supplied process flags returned by this running binary.
   * Keep it in thread config; never write the user's persisted hook trust. */
  async config(rpc: AppServer, cwd: string, native = true, agent?: string) {
    if (this.closed) throw new Error("The Codex hook bridge was closed");
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
    const flags = listed.data
      .flatMap((row) => row.hooks)
      .filter((hook) => hook.source === "sessionFlags");
    const own = flags.filter(
      (hook) =>
        hook.server === SERVER && /^callback_\d+$/.test(hook.tool ?? ""),
    );
    if (
      this.callbacks.some(
        (_, index) =>
          own.filter((hook) => hook.tool === `callback_${index}`).length !== 1,
      )
    )
      throw new Error(
        "This Codex version did not register Buzz's native callbacks",
      );
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
          tools: this.callbacks.map((_hook, index) => ({
            name: `callback_${index}`,
            description: "Evaluate a plugin hook callback.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: true,
            },
          })),
        });
      if (wire.method !== "tools/call") return result({});
      const name = String(wire.params?.name ?? "");
      const index = /^callback_(\d+)$/.exec(name)?.[1];
      const hook =
        index === undefined ? undefined : this.callbacks[Number(index)];
      if (!hook) throw new Error("Unknown hook callback");
      const output = await this.run(
        hook.key,
        (wire.params?.arguments ?? {}) as Record<string, unknown>,
        agent,
      );
      return result({
        content: [{ type: "text", text: JSON.stringify(output ?? {}) }],
      });
    });
    if (this.closed) {
      await server.close();
      throw new Error("The Codex hook bridge was closed");
    }
    this.servers.add(server);
    const close = async () => {
      if (this.servers.delete(server)) await server.close();
    };
    return {
      close,
      server: {
        url: server.url,
        http_headers: Object.fromEntries(
          server.headers.map(({ name, value }) => [name, value]),
        ),
        enabled: true,
        required: true,
      },
      state: Object.fromEntries(
        flags.map((hook) => [
          hook.key,
          { enabled: native, trusted_hash: hook.currentHash },
        ]),
      ),
    };
  }
  async close() {
    this.closed = true;
    const servers = [...this.servers];
    this.servers.clear();
    await Promise.all(servers.map((server) => server.close()));
  }
}
export const HOOK_SERVER = SERVER;
