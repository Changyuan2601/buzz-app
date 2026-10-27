// Hosted agent types a plugin registers whole from the screens' page, for
// agents the service runs in another page. Builderlab does: its provider
// steps use the sign-in that lives in its UI. The screens' page lists such a
// type with the service and keeps what it shows; the service adds a stand-in
// whose provider steps, and readiness checks, are answered back in the
// screens' page. The type's readiness crosses as data each time it changes.
import type { ToolOwner } from "./tool-port";
import type {
  AgentPresentation,
  AgentProviderSnapshot,
  AgentType,
  RemoteAgentType,
} from "./service";

const STEPS = [
  "provision",
  "activate",
  "profile",
  "interrupt",
  "remove",
] as const satisfies readonly (keyof RemoteAgentType)[];
type Step = (typeof STEPS)[number];
/** A provider step, or one of the type's readiness calls. */
export type HostedMethod = Step | "check" | "attention";

/** What of a hosted type the service needs, as data. */
export type HostedListing = Readonly<{
  id: string;
  title: string;
  description?: string;
  migrationWarning?: string;
  /** Its `defaults()`, which a hosted type's are as plain data. */
  defaults: ReturnType<AgentType["defaults"]>;
  /** The provider steps it has. */
  steps: readonly Step[];
  provider?: Readonly<{ snapshot: AgentProviderSnapshot; attention: boolean }>;
  owner: ToolOwner;
}>;
export type HostedCall = Readonly<{
  id: number;
  /** The type's key, `pluginId/id`. */
  type: string;
  method: HostedMethod;
  /** The step's input without its signal, which `abort` stands in for. */
  input?: Readonly<Record<string, unknown>>;
}>;
type Outcome = { value?: unknown } | { error: string };

/** What a hosted type shows, which stays in the screens' page. */
const SHOWN = [
  "icon",
  "Peek",
  "Create",
  "CreateModel",
  "tabs",
  "defaults",
  "importShared",
  "adopt",
  "carry",
  "describeMigration",
  "migrationWarning",
  "summary",
] as const satisfies readonly (keyof AgentPresentation)[];
/** Neither crosses nor is shown: a type with any of them needs an agent entry. */
const STAYS = [
  "run",
  "runOnce",
  "models",
  "usage",
  "sessions",
  "sessionControls",
  "syncedSettings",
  "resumes",
  "timeoutMs",
  "expose",
] as const satisfies readonly (keyof AgentType)[];

const keyOf = (owner: ToolOwner, id: string) => `${owner.id}/${id}`;
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The service's side: each listed type is added with `register` until it is
 * withdrawn, and its calls are forwarded with `post`; `abort` tells the
 * screens' page that a call's signal aborted. */
export function serveHosted(
  register: (type: AgentType, owner: ToolOwner) => () => void,
  post: (call: HostedCall) => void,
  abort: (id: number) => void,
) {
  const added = new Map<
    string,
    Readonly<{
      remove(): void;
      provide(snapshot: AgentProviderSnapshot, attention: boolean): void;
    }>
  >();
  const waiting = new Map<
    number,
    Readonly<{
      type: string;
      resolve(value: unknown): void;
      reject(error: Error): void;
    }>
  >();
  let next = 0;
  /** Ends the calls of types `gone` picks, which will not be answered. */
  const abandon = (gone: (type: string) => boolean, why: string) => {
    for (const pending of waiting.values())
      if (gone(pending.type)) pending.reject(new Error(why));
  };
  const forward = async (
    type: string,
    method: HostedMethod,
    input?: Readonly<Record<string, unknown>> & { signal?: AbortSignal },
  ) => {
    const id = ++next;
    const { signal, ...rest } = input ?? {};
    const aborted = () => abort(id);
    try {
      return await new Promise((resolve, reject) => {
        waiting.set(id, { type, resolve, reject });
        post({ id, type, method, ...(input && { input: rest }) });
        if (signal?.aborted) aborted();
        else signal?.addEventListener("abort", aborted, { once: true });
      });
    } finally {
      signal?.removeEventListener("abort", aborted);
      waiting.delete(id);
    }
  };
  return {
    list(listing: HostedListing) {
      const key = keyOf(listing.owner, listing.id);
      // Listed again: the page that registered it reloaded, or registered
      // it anew.
      abandon(
        (type) => type === key,
        `The page that registers agent type ${key} reloaded`,
      );
      added.get(key)?.remove();
      added.delete(key);
      const step =
        (name: Step) =>
        (input: Readonly<Record<string, unknown>> & { signal: AbortSignal }) =>
          forward(key, name, input);
      let readiness = listing.provider;
      const listeners = new Set<() => void>();
      const type: AgentType = {
        id: listing.id,
        title: listing.title,
        ...(listing.description !== undefined && {
          description: listing.description,
        }),
        ...(listing.migrationWarning !== undefined && {
          migrationWarning: listing.migrationWarning,
        }),
        defaults: () => listing.defaults,
        // Each step resolves with what the screens' page's step did.
        remote: Object.freeze({
          provision: step("provision"),
          activate: step("activate"),
          profile: step("profile"),
          remove: step("remove"),
          ...(listing.steps.includes("interrupt") && {
            interrupt: step("interrupt"),
          }),
        }) as unknown as RemoteAgentType,
        ...(readiness && {
          provider: Object.freeze({
            snapshot: () => readiness?.snapshot ?? { readiness: "checking" },
            subscribe(listener: () => void) {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
            check: () => forward(key, "check") as Promise<void>,
            get attentionAction() {
              return readiness?.attention
                ? () => void forward(key, "attention").catch(() => {})
                : undefined;
            },
          }),
        }),
      };
      try {
        added.set(key, {
          remove: register(type, listing.owner),
          provide(snapshot, attention) {
            readiness = { snapshot, attention };
            for (const listener of [...listeners]) listener();
          },
        });
      } catch (error) {
        console.error(`Agent type ${key} was not added`, error);
      }
    },
    withdraw(key: string) {
      added.get(key)?.remove();
      added.delete(key);
    },
    provide(key: string, snapshot: AgentProviderSnapshot, attention: boolean) {
      added.get(key)?.provide(snapshot, attention);
    },
    settle(id: number, outcome: Outcome) {
      const pending = waiting.get(id);
      if (!pending) return;
      if ("error" in outcome) pending.reject(new Error(outcome.error));
      else pending.resolve(outcome.value);
    },
    stop() {
      for (const { remove } of added.values()) remove();
      added.clear();
      abandon(() => true, "The agents connection is closed.");
    },
  };
}

/** The screens' page's side: it lists each hosted type a plugin registers
 * here with `list`, shows the rest of it with `present`, and answers the
 * service's calls of it with `settle`. */
export function hostedClient(
  send: Readonly<{
    list(listing: HostedListing): void;
    withdraw(key: string): void;
    provide(
      key: string,
      snapshot: AgentProviderSnapshot,
      attention: boolean,
    ): void;
    settle(id: number, outcome: Outcome): void;
  }>,
  present: (key: string, present: () => AgentPresentation) => () => void,
) {
  const types = new Map<
    string,
    Readonly<{ type: AgentType; listing: () => HostedListing }>
  >();
  const signals = new Map<number, AbortController>();
  return {
    /** Lists `owner`'s hosted `type` with the service, and shows it here,
     * until the returned withdraw. A type that runs its agents in this page
     * cannot be registered here: it needs an agent entry. */
    register(type: AgentType, owner: ToolOwner) {
      const key = keyOf(owner, type.id);
      if (!type.remote)
        throw new Error(
          `Agent type ${key} runs its agents in the page that shows them, which Buzz no longer does. Its plugin needs an agent entry.`,
        );
      const stays = STAYS.filter((field) => type[field] !== undefined);
      if (stays.length)
        throw new Error(
          `Agent type ${key} has ${stays.join(", ")}, which only an agent entry can give. Its plugin needs an agent entry.`,
        );
      const { provider, remote } = type;
      const listing = (): HostedListing => ({
        id: type.id,
        title: type.title,
        ...(type.description !== undefined && {
          description: type.description,
        }),
        ...(type.migrationWarning !== undefined && {
          migrationWarning: type.migrationWarning,
        }),
        defaults: type.defaults(),
        steps: STEPS.filter((step) => typeof remote[step] === "function"),
        ...(provider && {
          provider: {
            snapshot: provider.snapshot(),
            attention: Boolean(provider.attentionAction),
          },
        }),
        owner,
      });
      const entry = Object.freeze({ type, listing });
      types.set(key, entry);
      send.list(listing());
      const stopReadiness = provider?.subscribe(() => {
        if (types.get(key) === entry)
          send.provide(
            key,
            provider.snapshot(),
            Boolean(provider.attentionAction),
          );
      });
      const shown: AgentPresentation = {
        ...Object.fromEntries(
          SHOWN.flatMap((field) =>
            type[field] === undefined ? [] : [[field, type[field]]],
          ),
        ),
        ...(provider && {
          provider: {
            ...(provider.DialogBody && { DialogBody: provider.DialogBody }),
            ...(provider.DefaultControl && {
              DefaultControl: provider.DefaultControl,
            }),
          },
        }),
      };
      const hide = present(key, () => shown);
      return () => {
        if (types.get(key) !== entry) return;
        types.delete(key);
        stopReadiness?.();
        hide();
        send.withdraw(key);
      };
    },
    async answer({ id, type: key, method, input }: HostedCall) {
      const controller = new AbortController();
      signals.set(id, controller);
      try {
        const type = types.get(key)?.type;
        if (!type) throw new Error(`Agent type ${key} is no longer registered`);
        const run = async (): Promise<unknown> => {
          if (method === "check") return type.provider?.check();
          if (method === "attention") return type.provider?.attentionAction?.();
          const step = type.remote?.[method] as
            | ((input: unknown) => Promise<unknown>)
            | undefined;
          if (!step) throw new Error(`Agent type ${key} has no ${method}`);
          return step.call(type.remote, {
            ...input,
            signal: controller.signal,
          });
        };
        send.settle(id, { value: await run() });
      } catch (error) {
        send.settle(id, { error: messageOf(error) });
      } finally {
        signals.delete(id);
      }
    },
    abort: (id: number) => signals.get(id)?.abort(),
    /** The service's page reloaded: it lists them again. */
    relist() {
      for (const { listing } of types.values()) send.list(listing());
    },
  };
}
