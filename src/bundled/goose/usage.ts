// The token use of an agent's goose sessions, as goose records it on each of
// their replies. goose owns the sessions; nothing here writes or keeps them.
import { promptSections } from "../../features/agents/activity-transcript";
import type {
  SessionUsage,
  UsageObservation,
} from "../../features/agents/service";
import { withRevision } from "../../features/agents/session-usage";
import type { GooseHistory, Message } from "./transcript";

type Json = Record<string, unknown>;

const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

/** Where Buzz started the session, and what was asked, from its first
 * prompt's context and event. */
function buzzStart(messages: readonly Message[]) {
  const first = messages.find(
    (message) =>
      message.role === "user" && message.metadata?.userVisible !== false,
  );
  const sections = promptSections(
    (first?.content ?? []).map((block) => str(block.text)).join("\n"),
  );
  const field = (name: string) =>
    sections
      .find((section) => section.tag === "context")
      ?.body.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1]
      ?.trim();
  const channelId = field("Channel")?.match(/\(#([^)]+)\)$/)?.[1];
  if (!channelId) return undefined;
  const root = field("Session scope") === "thread" && field("Thread root");
  const title = sections
    .find((section) => section.tag === "buzz-event")
    ?.body.match(/^Content: (.*)$/m)?.[1]
    ?.trim();
  return {
    channelId,
    ...(root ? { root } : {}),
    ...(title ? { title } : {}),
  };
}

/** A session's model requests. goose counts a reply's cached prompt tokens in
 * its input, and prices the replies it can. */
export function sessionUsage(
  id: string,
  messages: readonly Message[],
): Omit<SessionUsage, "revision"> | undefined {
  const start = buzzStart(messages);
  const times = messages.map((message) => message.created * 1000);
  if (!start || !times.length) return undefined;
  const observations: UsageObservation[] = [];
  for (const message of messages) {
    const usage = object(message.metadata?.usage);
    if (message.role !== "assistant" || !usage) continue;
    const inference = object(message.metadata?.inference);
    const prompt = count(usage.inputTokens);
    const cacheRead = count(usage.cacheReadTokens);
    const cacheWrite = count(usage.cacheWriteTokens);
    const output = count(usage.outputTokens);
    const cost = usage.cost;
    observations.push({
      ...(message.id ? { requestId: message.id } : {}),
      at: message.created * 1000,
      model:
        str(inference?.requestedModel) ||
        str(inference?.resolvedModel) ||
        "goose",
      tokens: {
        // The uncached input is known only with both cache counts.
        ...(prompt !== undefined &&
        cacheRead !== undefined &&
        cacheWrite !== undefined
          ? { input: Math.max(0, prompt - cacheRead - cacheWrite) }
          : {}),
        ...(output !== undefined ? { output } : {}),
        ...(cacheRead !== undefined ? { cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cacheWrite } : {}),
      },
      ...(typeof cost === "number" && Number.isFinite(cost)
        ? { cost: { usd: cost, source: str(usage.costSource) || "goose" } }
        : {}),
    });
  }
  return {
    id,
    ...start,
    startedAt: Math.min(...times),
    lastAt: Math.max(...times),
    gaps: [],
    observations,
  };
}

/** The agent's goose sessions in `workspace` used since `since`. */
export async function readUsage(
  history: GooseHistory,
  agent: string,
  workspace: string,
  since: number,
  signal: AbortSignal,
): Promise<SessionUsage[]> {
  const sessions = (await history.sessions(agent, workspace, since, signal))
    .flatMap(({ sessionId, messages }) => {
      const session = sessionUsage(sessionId, messages);
      return session && session.lastAt >= since ? [session] : [];
    })
    .sort((a, b) => b.lastAt - a.lastAt);
  return Promise.all(sessions.map(withRevision));
}
