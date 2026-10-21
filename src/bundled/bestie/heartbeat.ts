import { parse, stringify } from "yaml";
import type { RelaySession } from "../../features/relay/session";
import type { WorkflowDefinition } from "../../features/workflows/types";

export const HEARTBEAT_NAME = "Bestie · Hourly upkeep";
const STEP = "upkeep";

/** Marks the heartbeat for one agent, so a renamed workflow is still found. */
const marker = (agent: string) => `Bestie heartbeat for ${agent}.`;
// Unfolded, so the YAML reads as the owner will see it in Workflows.
const format = { lineWidth: 0 };

/** Whether `yaml` is the heartbeat for `agent`, however it was reformatted. */
function marks(yaml: string, agent: string) {
  try {
    const description = (parse(yaml) as { description?: unknown } | null)
      ?.description;
    return (
      typeof description === "string" && description.includes(marker(agent))
    );
  } catch {
    return false;
  }
}

/** The relay wakes an agent only through `@<display name>` of a channel member,
 * matched case-insensitively at each run, so the text must carry its current name. */
export function wakeText(name: string) {
  return `🤖 @${name} Hourly upkeep wake. Follow "Hourly upkeep" in your instructions. This is an internal maintenance wake, not a user message: do not reply in chat unless the checklist says a message is warranted.`;
}

export function heartbeatYaml(agent: string, name: string) {
  return stringify(
    {
      name: HEARTBEAT_NAME,
      description: `${marker(agent)} Bestie keeps the @mention below matching Bestie's current name. Times are UTC.`,
      enabled: true,
      trigger: { on: "schedule", cron: "0 * * * *" },
      steps: [{ id: STEP, action: "send_message", text: wakeText(name) }],
    },
    format,
  );
}

type Step = { id?: unknown; action?: unknown; text?: unknown };

/** The heartbeat's YAML with its wake addressed to `name`, keeping owner edits. */
function readdressed(row: WorkflowDefinition, name: string) {
  const definition = parse(row.yaml) as { steps?: Step[] } | null;
  const step = definition?.steps?.find(
    (item) => item?.id === STEP && item.action === "send_message",
  );
  if (!step) return;
  const text = wakeText(name);
  if (step.text === text) return row.yaml;
  step.text = text;
  return stringify(definition, format);
}

/** Why the relay can't address a wake to `name` in a home shared with `ownerName`. */
export function unaddressable(name: string | undefined, ownerName?: string) {
  if (!name?.trim()) return "Bestie has no display name to wake it by.";
  if (ownerName?.trim().toLowerCase() === name.trim().toLowerCase())
    return `You and Bestie are both named ${name}, so a scheduled @${name} can't tell you apart. Rename one of you.`;
}

/** Saves, or readdresses, the one hourly workflow that wakes `agent` in its home.
 * Only the session signs; the relay runs it. Returns the workflow's id. */
export async function ensureHeartbeat({
  session,
  channelId,
  owner,
  agent,
  name,
  check,
}: {
  session: RelaySession;
  channelId: string;
  owner: string;
  agent: string;
  name: string;
  check(): void;
}) {
  const workflows = session.workflows;
  if (!workflows.availability.save || !workflows.availability.definitions)
    throw new Error("Scheduled wakes are unavailable on this connection.");
  const view = workflows.definitions(channelId);
  try {
    const read = async () => {
      await view.refresh();
      check();
      const snapshot = view.snapshot();
      if (snapshot.status !== "ready" || snapshot.data.partial)
        throw new Error("Could not read Bestie's scheduled wake. Retry.");
      return snapshot.data.items.filter(
        (row) => row.owner === owner && marks(row.yaml, agent),
      );
    };
    const rows = await read();
    if (rows.length > 1)
      throw new Error(
        "Bestie has several hourly wakes. Delete the extras in Workflows.",
      );
    const existing = rows[0];
    let yaml = heartbeatYaml(agent, name);
    if (existing) {
      const next = readdressed(existing, name);
      if (next === undefined)
        throw new Error(
          `Bestie's hourly wake no longer has its "${STEP}" message step. Delete it in Workflows to recreate it.`,
        );
      if (next === existing.yaml) return existing.id;
      yaml = next;
    }
    const eventId = workflows.save({
      channelId,
      yaml,
      ...(existing ? { existing } : {}),
    });
    const active = () => {
      check();
      return true;
    };
    await session.channelWrites.delivered(eventId, active, false, false);
    const saved = (await read()).find((row) => row.yaml === yaml);
    if (!saved)
      throw new Error(
        "Bestie's hourly wake was sent but not confirmed. Retry, or check Workflows.",
      );
    return saved.id;
  } finally {
    view.dispose();
  }
}
