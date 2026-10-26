import type { EventData } from "../relay/events";
import { agentAudience } from "../relay/audience";
import { foldProfiles } from "../relay/profiles";
import type { Context } from "@deepseek-ai/cordis";
import { createContributions } from "../../plugins/contributions";

/** A mention admitted to a harness session. Hooks receive a snapshot,
 * so a send already in flight cannot acknowledge a later mention. */
export type AgentHookMessage = Readonly<{
  id: string;
  channel: string;
  root?: string;
  topLevel?: boolean;
  deliveredAt: number;
  /** Profile hint, not an authorization decision. Absent when the profile is unavailable. */
  authorIsAgent?: boolean;
  audience?: "everyone" | "agents";
}>;
/** Shared sender facts for policies in either harness. */
export function hookMessageSource(event: EventData, profile?: EventData) {
  return {
    authorIsAgent: !!(
      profile && foldProfiles([profile]).get(event.pubkey)?.isAgent
    ),
    audience: agentAudience(event)
      ? ("agents" as const)
      : ("everyone" as const),
  };
}
/** Native input and output belong to the selected harness. Buzz supplies
 * conversation facts separately, without interpreting the plugin's policy. */
export type AgentHookEvent = Readonly<{
  harness: "claude-code" | "codex";
  event: string;
  input: Readonly<Record<string, unknown>>;
  agent: string;
  session: string;
  messages: readonly AgentHookMessage[];
  context: Readonly<{ channel?: string; root?: string; topLevel?: boolean }>;
  /** Codex MCP callbacks can also be called by a model. Only host tool
   * observations attest that a Buzz tool actually completed. */
  source: "harness" | "host";
}>;
export type HookOutput = Readonly<Record<string, unknown>>;
export type AgentHook = Readonly<{
  id: string;
  harness: AgentHookEvent["harness"];
  event: string;
  matcher?: string;
  /** Limit to native callbacks or verified host observations; absent accepts both. */
  source?: AgentHookEvent["source"];
  /** Codex's native MCP input template. Claude supplies its raw SDK input. */
  input?: Readonly<Record<string, unknown>>;
  run(event: AgentHookEvent): void | HookOutput | Promise<undefined | HookOutput>;
}>;
export type RegisteredAgentHook =
  import("../../plugins/contributions").Contribution<AgentHook>;
export type AgentHooks = {
  registerHook(hook: AgentHook): void;
  hooks(harness: AgentHook["harness"]): readonly RegisteredAgentHook[];
  hook(key: string, event: AgentHookEvent): Promise<HookOutput>;
};
export function createAgentHooks(root: Context) {
  const hooks = createContributions<AgentHook>(root);
  return {
    register: hooks.register,
    subscribe: hooks.subscribe,
    snapshot: (harness: AgentHook["harness"]) =>
      hooks.snapshot().filter((hook) => hook.harness === harness),
    async run(key: string, event: AgentHookEvent): Promise<HookOutput> {
      const hook = hooks
        .snapshot()
        .find(
          (hook) =>
            hook.key === key &&
            hook.harness === event.harness &&
            hook.event === event.event &&
            (!hook.source || hook.source === event.source),
        );
      return (await hook?.run(event)) ?? {};
    },
  };
}
/** Configuration fingerprints exclude live callback implementations. */
export function hookDefinitions(hooks: readonly RegisteredAgentHook[]) {
  return hooks.map(({ key, event, matcher, input, source }) => ({
    key,
    event,
    matcher,
    input,
    source,
  }));
}
