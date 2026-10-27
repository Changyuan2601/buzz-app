// Agent tools a plugin adds from the screens' page, for agents the service
// runs in another page. The screens' page lists each tool with the service
// and answers its calls. A call carries the agent's client as a handle: its
// values, and its methods, which the screens' page calls back over the port.
// So a plugin that adds tools without an agent entry keeps working, though
// its tools wait on the screens' page.
import type { BuzzClient, Context } from "../../buzz-mcp/client";
import { fromBase64, toBase64 } from "../../buzz-mcp/app-client";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { Reply } from "../../buzz-mcp/tools";

/** The plugin that adds a tool, as its page's plugin runtime names it. */
export type ToolOwner = Readonly<{ id: string; revision: string }>;
export type ToolListing = Pick<
  AddedTool,
  "name" | "description" | "inputSchema"
> &
  Readonly<{ owner: ToolOwner }>;

const VALUES = [
  "pubkey",
  "key",
  "owner",
  "relayAuthor",
  "signingAuthority",
] as const satisfies readonly (keyof BuzzClient)[];
const METHODS = [
  "agentTypes",
  "createAgent",
  "updateAgent",
  "handoff",
  "query",
  "searchProfiles",
  "publish",
  "upload",
  "media",
  "gitAuth",
  "read",
  "memories",
  "remember",
  "templates",
] as const satisfies readonly (keyof BuzzClient)[];
type Method = (typeof METHODS)[number];

/** The agent's client as one call carries it. Its thread tabs and attention
 * stay behind: what they read is the service's page's. */
export type ClientHandle = Readonly<{
  id: number;
  values: Readonly<Partial<Record<(typeof VALUES)[number], string>>>;
  methods: readonly Method[];
}>;
export type ToolCall = Readonly<{
  id: number;
  name: string;
  client: ClientHandle;
  context: Context;
  args: Record<string, unknown>;
}>;

type Bytes = Readonly<{ $bytes: string }>;
const isBytes = (value: unknown): value is Bytes =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Bytes).$bytes === "string";
/** Bytes as JSON carries them. */
export const wire = (value: unknown) =>
  value instanceof Uint8Array ? { $bytes: toBase64(value) } : value;
export const unwire = (value: unknown) =>
  isBytes(value) ? fromBase64(value.$bytes) : value;

/** The service's side: each listed tool, added with `addTool` until it is
 * withdrawn, forwards its calls with `post`. */
export function serveTools(
  addTool: (tool: AddedTool, owner: ToolOwner) => () => void,
  post: (call: ToolCall) => void,
) {
  const added = new Map<string, () => void>();
  const clients = new Map<number, BuzzClient>();
  const waiting = new Map<
    number,
    Readonly<{
      name: string;
      resolve(reply: Reply): void;
      reject(error: Error): void;
    }>
  >();
  let next = 0;
  /** Ends the calls of tools `gone` picks, which will not be answered. */
  const abandon = (gone: (name: string) => boolean, why: string) => {
    for (const pending of waiting.values())
      if (gone(pending.name)) pending.reject(new Error(why));
  };
  const forward = async (
    name: string,
    client: BuzzClient,
    context: Context,
    args: Record<string, unknown>,
  ) => {
    const id = ++next;
    clients.set(id, client);
    try {
      return await new Promise<Reply>((resolve, reject) => {
        waiting.set(id, { name, resolve, reject });
        post({
          id,
          name,
          client: {
            id,
            values: Object.fromEntries(
              VALUES.flatMap((value) =>
                typeof client[value] === "string"
                  ? [[value, client[value]]]
                  : [],
              ),
            ),
            methods: METHODS.filter(
              (method) => typeof client[method] === "function",
            ),
          },
          context,
          args,
        });
      });
    } finally {
      waiting.delete(id);
      clients.delete(id);
    }
  };
  return {
    list(tool: ToolListing) {
      // Listed again: the page that added it reloaded, or added it anew.
      abandon(
        (name) => name === tool.name,
        `The page that adds agent tool ${tool.name} reloaded`,
      );
      added.get(tool.name)?.();
      try {
        added.set(
          tool.name,
          addTool(
            {
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              call: (client, context, args) =>
                forward(tool.name, client, context, args),
            },
            tool.owner,
          ),
        );
      } catch (error) {
        added.delete(tool.name);
        console.error(`Agent tool ${tool.name} was not added`, error);
      }
    },
    withdraw(name: string) {
      added.get(name)?.();
      added.delete(name);
    },
    settle(id: number, outcome: { reply: Reply } | { error: string }) {
      const pending = waiting.get(id);
      if (!pending) return;
      if ("reply" in outcome) pending.resolve(outcome.reply);
      else pending.reject(new Error(outcome.error));
    },
    /** A call the screens' page makes on the client of a call in progress. */
    async client(id: number, method: string, args: readonly unknown[]) {
      const client = clients.get(id);
      const run = client?.[method as Method] as
        | ((...args: unknown[]) => unknown)
        | undefined;
      if (!client || !METHODS.includes(method as Method) || !run)
        throw new Error("That tool call has finished");
      return wire(await run.apply(client, args.map(unwire)));
    },
    stop() {
      for (const remove of added.values()) remove();
      added.clear();
      abandon(() => true, "The agents connection is closed.");
    },
  };
}

/** The screens' page's side: it lists each tool it adds with `list`, and
 * answers the service's calls of them with `settle`, calling the agent's
 * client back with `call`. */
export function toolsClient(
  send: Readonly<{
    list(tool: ToolListing): void;
    withdraw(name: string): void;
    settle(id: number, outcome: { reply: Reply } | { error: string }): void;
    call(client: number, method: Method, args: unknown[]): Promise<unknown>;
  }>,
) {
  const tools = new Map<
    string,
    Readonly<{ tool: AddedTool; listing: ToolListing }>
  >();
  const handle = ({ id, values, methods }: ClientHandle): BuzzClient =>
    Object.freeze({
      ...values,
      ...Object.fromEntries(
        methods.map((method) => [
          method,
          (...args: unknown[]) => {
            const answer = send.call(id, method, args.map(wire)).then(unwire);
            if (method !== "handoff") return answer;
            // It answers nothing; a failure is the service's to report.
            answer.catch(() => {});
          },
        ]),
      ),
    }) as unknown as BuzzClient;
  return {
    /** Lists `owner`'s `tool` with the service until the returned withdraw. */
    add(tool: AddedTool, owner: ToolOwner) {
      const listing: ToolListing = {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        owner,
      };
      const entry = Object.freeze({ tool, listing });
      tools.set(tool.name, entry);
      send.list(listing);
      return () => {
        if (tools.get(tool.name) !== entry) return;
        tools.delete(tool.name);
        send.withdraw(tool.name);
      };
    },
    async answer({ id, name, client, context, args }: ToolCall) {
      const tool = tools.get(name)?.tool;
      try {
        if (!tool) throw new Error(`Agent tool ${name} is no longer added`);
        send.settle(id, {
          reply: await tool.call(handle(client), context, args),
        });
      } catch (error) {
        send.settle(id, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    /** The service's page reloaded: it lists them again. */
    relist() {
      for (const { listing } of tools.values()) send.list(listing);
    },
  };
}
