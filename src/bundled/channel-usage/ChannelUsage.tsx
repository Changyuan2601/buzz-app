import { useRef, useState } from "react";
import type { RelaySession } from "../../features/relay/session";
import { useListedChannel } from "../../features/relay/listed-channel";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import { formatPublicKey } from "../../shared/identity/public-key";
import { Button } from "../../shared/design-system/ui/Button";
import { Select } from "../../shared/design-system/ui/Select";
import { useUsageArchive } from "./use-usage-archive";
import { aggregateSessionUsage } from "../../features/agents/usage";
import type {
  Counters,
  UsageRecord,
  UsageSession,
} from "../../features/agents/usage";
import styles from "./ChannelUsage.module.css";

const number = (value?: number) =>
  value === undefined ? "—" : value.toLocaleString("en-US");
const usd = (value?: number) =>
  value === undefined
    ? "—"
    : `$${value.toFixed(value < 0.01 && value > 0 ? 4 : 2)}`;
const date = (value: number) => new Date(value).toLocaleString();
function total(record: UsageRecord | null) {
  const counters = record?.cumulative;
  if (counters?.totalTokens !== undefined)
    return `${number(counters.totalTokens)} tokens`;
  if (
    counters?.inputTokens !== undefined ||
    counters?.outputTokens !== undefined
  )
    return `Input ${number(counters.inputTokens)} / Output ${number(counters.outputTokens)}`;
  return "—";
}
function Breakdown({ counts }: { counts: Counters | null | undefined }) {
  return (
    <dl className={styles.breakdown}>
      <dt>Provider total tokens</dt>
      <dd>{number(counts?.totalTokens)}</dd>
      <dt>Input</dt>
      <dd>{number(counts?.inputTokens)}</dd>
      <dt>Output</dt>
      <dd>{number(counts?.outputTokens)}</dd>
      <dt>Cache reads</dt>
      <dd>{number(counts?.cacheReadTokens)}</dd>
      <dt>Cache writes</dt>
      <dd>{number(counts?.cacheWriteTokens)}</dd>
      <dt>Estimated USD</dt>
      <dd>{usd(counts?.costUsd)}</dd>
    </dl>
  );
}
function Turns({ group, name }: { group: UsageSession; name: string }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <section>
      <h3>Recorded turns · {group.turns.length} · newest first</h3>
      <section
        className={styles.turnList}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded turn list supports keyboard scrolling.
        tabIndex={0}
        aria-label={`${name} recorded turns`}
      >
        {group.turns.map((row) => (
          <div key={row.id} className={styles.turn}>
            <div className={styles.turnHead}>
              <span>
                {row.turnId?.endsWith(":initial")
                  ? "Session setup"
                  : row.turnSeq === null
                    ? "—"
                    : `#${row.turnSeq}`}
              </span>
              <time dateTime={new Date(row.timestamp).toISOString()}>
                {date(row.timestamp)}
              </time>
              <span>{number(row.turn?.totalTokens)}</span>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`${expanded === row.id ? "Hide" : "Show"} turn ${row.turnSeq ?? row.id} details`}
                aria-expanded={expanded === row.id}
                onClick={() => setExpanded(expanded === row.id ? null : row.id)}
              >
                {usd(row.turn?.costUsd)} · {expanded === row.id ? "−" : "+"}
              </Button>
            </div>
            {expanded === row.id && (
              <div>
                {row.conflict ? (
                  <p>Conflicting turn records. Per-turn usage unavailable.</p>
                ) : !row.turn ? (
                  <p>Per-turn usage unavailable.</p>
                ) : (
                  <Breakdown counts={row.turn} />
                )}
                <details>
                  <summary>Identifiers and provenance</summary>
                  <dl className={styles.breakdown}>
                    <dt>Session</dt>
                    <dd>{row.sessionId ?? "Not reported"}</dd>
                    <dt>Turn</dt>
                    <dd>{row.turnId ?? "Not reported"}</dd>
                    <dt>Harness / model</dt>
                    <dd>
                      {row.harness} / {row.model ?? "Not reported"}
                    </dd>
                    <dt>Stop reason</dt>
                    <dd>{row.stopReason ?? "Not reported"}</dd>
                    <dt>Pricing identity</dt>
                    <dd>{row.pricing ?? "Not reported"}</dd>
                  </dl>
                </details>
              </div>
            )}
          </div>
        ))}
      </section>
    </section>
  );
}

/** Archive association is by selected channel; a thread does not confer attribution. */
export function ChannelUsage({
  session,
  channelId,
}: {
  session: RelaySession;
  channelId: string;
}) {
  const channel = useListedChannel(session.channels, channelId, (item) => item);
  const allowed =
    !!channel &&
    !channel.cached &&
    !channel.readOnly &&
    !channel.archived &&
    !!channel.members?.includes(session.viewer ?? "");
  const usage = useUsageArchive(
    session.agentActivity?.archive,
    channelId,
    allowed,
  );
  const resolve = useChannelIdentityNames(session, channelId);
  const agentPicker = useRef<HTMLDivElement>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  if (!allowed || !session.agentActivity?.archive) return null;
  const agents = [...new Set(usage.groups.map((group) => group.agent))];
  const activeAgent = agent && agents.includes(agent) ? agent : null;
  const groups = usage.groups.filter((group) => group.agent === activeAgent);
  const group =
    groups.find((group) => group.key === selected) ??
    (groups.length === 1 ? groups[0] : undefined);
  const totals = aggregateSessionUsage(groups);
  const label = (id: string) => resolve(id, formatPublicKey(id) ?? "Agent");
  return (
    <div className={styles.owner}>
      <fieldset className={styles.strip} aria-label="Channel session usage">
        <span>Channel session usage</span>
        <div className={styles.agentPicker} ref={agentPicker}>
          <Select
            label="Agent usage"
            variant="compact"
            value={activeAgent ?? ""}
            placeholder="Select agent"
            groups={[
              {
                label: "",
                options: agents.map((id) => {
                  const sessions = usage.groups.filter(
                    (group) => group.agent === id,
                  );
                  return {
                    value: id,
                    label: `${label(id)} · ${sessions.length === 1 ? total(sessions[0]?.latest ?? null) : `${sessions.length} sessions`}`,
                  };
                }),
              },
            ]}
            onValueChange={(id) => {
              setAgent(id);
              setSelected(null);
            }}
          />
        </div>
        {usage.status === "loading" && (
          <span role="status">Loading saved usage…</span>
        )}
        <Button size="xs" variant="ghost" onClick={usage.refresh}>
          Refresh
        </Button>
      </fieldset>
      {activeAgent && (
        <section className={styles.details} aria-label="Session usage details">
          <div className={styles.heading}>
            <h2>Session usage · {label(activeAgent)}</h2>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                agentPicker.current
                  ?.querySelector<HTMLElement>('[role="combobox"]')
                  ?.focus();
                setAgent(null);
              }}
            >
              Close
            </Button>
          </div>
          <section aria-label="All session totals">
            <h3>
              Totals across {groups.length}{" "}
              {groups.length === 1 ? "session" : "sessions"}
            </h3>
            <p>
              Latest reported counters per session, not thread attribution.
              Cache counts are part of input. — means not reported for every
              session.
            </p>
            {totals.complete < groups.length && (
              <p>
                Incomplete: {totals.complete} of {groups.length} sessions have
                trustworthy cumulative counters.
              </p>
            )}
            <Breakdown counts={totals.counters} />
          </section>
          <div className={styles.sessionPicker}>
            <Select
              label="Session"
              variant="compact"
              value={group?.key ?? ""}
              placeholder="Select session"
              groups={[
                {
                  label: "",
                  options: groups.map((entry, index) => ({
                    value: entry.key,
                    label: `${entry.sessionId ? "Session" : "Unidentified session"} ${index + 1} · ${entry.turns.length} ${entry.turns.length === 1 ? "turn" : "turns"} · ${entry.turns[0] ? date(entry.turns[0].timestamp) : "No turns"}`,
                  })),
                },
              ]}
              onValueChange={setSelected}
            />
          </div>
          {group && (
            <div key={group.key}>
              <p>
                {group.sessionId
                  ? `Session ${group.sessionId}`
                  : "Unidentified session"}{" "}
                ·{" "}
                {group.latest?.harness ??
                  group.turns[0]?.harness ??
                  "Not reported"}{" "}
                /{" "}
                {group.latest?.model ?? group.turns[0]?.model ?? "Not reported"}
              </p>
              <h3>Latest reported session counters</h3>
              <p>
                Last reported{" "}
                {group.latest ? date(group.latest.timestamp) : "Not reported"}
              </p>
              {!group.latest && <p>Session counters unavailable.</p>}
              <Breakdown counts={group.latest?.cumulative} />
              <p>Cache counts are part of input, not additional tokens.</p>
              <details>
                <summary>Session identity and pricing provenance</summary>
                <p>
                  {group.sessionId ?? "Not reported"} ·{" "}
                  {group.latest?.pricing ?? "Not reported"}
                </p>
              </details>
              <Turns group={group} name={label(activeAgent)} />
            </div>
          )}
        </section>
      )}
      {usage.status === "error" && (
        <p role="alert">Could not read saved usage. Use Refresh to retry.</p>
      )}
      {!agents.length && usage.status === "ready" && (
        <p>
          {usage.skipped || usage.unreadable
            ? "Some saved metrics could not be read. Usage history is incomplete."
            : usage.partial
              ? "No matching records in the saved history scanned."
              : "No matching records in the saved history searched."}
        </p>
      )}
      {!!agents.length && !!(usage.skipped || usage.unreadable) && (
        <p>
          Some saved metrics could not be read. Usage history is incomplete.
        </p>
      )}
      {usage.partial && (
        <p>Partial history: 2,000-record scan limit reached.</p>
      )}
    </div>
  );
}
