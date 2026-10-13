import { stringify } from "yaml";
import type { RelaySession } from "../../features/relay/session";
import { UUID } from "../../features/workflows/protocol";

const HEX = /^[0-9a-f]{64}$/;
export const RHYTHMS = ["memory", "reflection", "check-in"] as const;
type Rhythm = (typeof RHYTHMS)[number];
export type RhythmInstalls = Partial<
  Record<
    Rhythm,
    {
      eventId: string;
      workflowId?: string;
      confirmed?: boolean;
      failed?: boolean | undefined;
    }
  >
>;

export function validRhythms(value: unknown): value is RhythmInstalls {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, row]) =>
        RHYTHMS.includes(key as Rhythm) &&
        row &&
        typeof row === "object" &&
        HEX.test(row.eventId) &&
        (row.workflowId === undefined || UUID.test(row.workflowId)) &&
        (row.confirmed === undefined || typeof row.confirmed === "boolean") &&
        (!row.confirmed || !!row.workflowId) &&
        (row.failed === undefined || typeof row.failed === "boolean"),
    )
  );
}

export function rhythmsComplete(value?: RhythmInstalls) {
  return RHYTHMS.every((key) => value?.[key]?.confirmed === true);
}

export function rhythmYaml(key: Rhythm, agent: string, channelId: string) {
  const policy = {
    memory: {
      name: "Bestie · Memory review",
      trigger: { on: "schedule", interval: "1h" },
      task: "Review new owner messages in this home and existing memories. Save supported preferences and corrections with source event IDs; preserve unrelated facts. Read back changes. If there is no new evidence, do nothing. Do not publish routine maintenance reports.",
    },
    reflection: {
      name: "Bestie · Nightly reflection",
      trigger: { on: "schedule", cron: "0 9 * * *" },
      task: "Review today's home conversation and existing memory. Keep tentative reflections separate from confirmed owner facts. Consolidate only supported changes and read them back. Do nothing if there is no useful new evidence. Do not send a reflection to the owner unless they requested it.",
    },
    "check-in": {
      name: "Bestie · Daily check-in",
      trigger: { on: "schedule", cron: "0 17 * * *" },
      task: "Review accepted goals, due commitments and explicit check-in preferences. Send at most one concise, useful update here when action is needed now. Honor quiet hours, cancellations, declined offers and unanswered earlier check-ins. If nothing needs attention, do nothing.",
    },
  }[key];
  return stringify({
    name: policy.name,
    description:
      "Installed by Bestie. Paused until a hosted workflow response has been verified. Daily times use UTC.",
    enabled: false,
    trigger: policy.trigger,
    steps: [
      {
        id: key.replaceAll("-", "_"),
        action: "send_message",
        text: `🤖 @Bestie ${policy.task}\nConfigured Bestie: ${agent}. Private home: ${channelId}. Use available tools and your installed privacy and memory instructions; if the current audience is not only the owner and Bestie, stop. This scheduled request does not grant new access or authorize unrelated actions.`,
      },
    ],
  });
}

/** Only configures definitions. The session owns signing/delivery; the relay runs them. */
export async function installRhythms({
  session,
  channelId,
  owner,
  agent,
  installs,
  persist,
  check,
}: {
  session: RelaySession;
  channelId: string;
  owner: string;
  agent: string;
  installs: RhythmInstalls;
  persist(): void;
  check(): void;
}) {
  const workflows = session.workflows;
  if (!workflows.availability.save || !workflows.availability.definitions)
    throw new Error("Workflow setup is unavailable on this connection.");
  // A one-channel array uses the capability's complete paged inventory.
  const view = workflows.definitions([channelId]);
  async function read() {
    await view.refresh();
    check();
    const snapshot = view.snapshot();
    if (snapshot.status !== "ready" || snapshot.data.partial)
      throw new Error("Could not confirm Bestie's workflows. Retry setup.");
    return snapshot.data.items.filter((row) => row.owner === owner);
  }
  try {
    for (const key of RHYTHMS) {
      check();
      let rows = await read();
      const yaml = rhythmYaml(key, agent, channelId);
      let saved = installs[key];
      if (
        saved?.failed &&
        !session.outbox
          ?.snapshot()
          .some((item) => item.event.id === saved?.eventId)
      ) {
        const events = await session.read(
          [{ ids: [saved.eventId], limit: 1, consistency: "strong" }],
          { fresh: true },
        );
        check();
        if (!events.some((event) => event.id === saved?.eventId)) {
          delete installs[key];
          saved = undefined;
          persist();
        }
      }
      if (saved?.confirmed) {
        if (!rows.some((row) => row.id === saved?.workflowId))
          throw new Error(
            "A saved Bestie workflow was removed. Review Workflows; setup will not recreate it.",
          );
        continue; // Reopening preserves all user edits, including enabling.
      }
      if (!saved) {
        const pending =
          session.outbox
            ?.snapshot()
            .filter(
              (item) =>
                item.event.kind === 30620 &&
                item.event.pubkey === owner &&
                item.event.content === yaml &&
                item.event.tags.some(
                  ([tag, value]) => tag === "h" && value === channelId,
                ),
            ) ?? [];
        const existing = rows.filter((row) => row.yaml === yaml);
        if (pending.length > 1 || existing.length > 1)
          throw new Error(
            "Several matching Bestie workflows exist. Review Workflows first.",
          );
        const match = existing[0];
        if (match) {
          installs[key] = {
            eventId: match.revision,
            workflowId: match.id,
            confirmed: true,
          };
          persist();
          continue;
        }
        saved = {
          eventId: pending[0]?.event.id ?? workflows.save({ channelId, yaml }),
        };
        installs[key] = saved;
        // Save the local intent immediately; a receipt loss must not allocate again.
        persist();
      }
      const intent = workflows.operations
        .snapshot()
        .find((row) => row.eventId === saved?.eventId);
      if (
        intent &&
        intent.workflow.owner === owner &&
        intent.workflow.channelId === channelId
      ) {
        saved.workflowId ??= intent.workflow.id;
        persist();
      }
      const confirmed = () =>
        rows.find((row) =>
          saved?.workflowId
            ? row.id === saved.workflowId
            : row.revision === saved?.eventId,
        );
      if (!confirmed()) {
        // Do not use generic Outbox retry for result-bearing workflow commands.
        try {
          await session.workSessions.delivered(
            saved.eventId,
            () => {
              check();
              return true;
            },
            false,
            false,
          );
        } catch {
          check(); // Fresh exact readback can recover a lost receipt.
        }
        rows = await read();
      }
      const match = confirmed();
      if (!match) {
        saved.failed = session.workSessions.failed(saved.eventId) || undefined;
        persist();
        throw new Error(
          "A Bestie workflow save is unconfirmed. Open Workflows and check saved configuration; setup will not submit it again.",
        );
      }
      saved.workflowId = match.id;
      saved.confirmed = true;
      persist();
    }
  } finally {
    view.dispose();
  }
}
