import {
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Agent, Agents } from "../../features/agents/service";
import { relayOrigin } from "../../features/communities/destination";
import type { Navigation } from "../../features/navigation/controller";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowsClockwiseIcon,
  ChartBarIcon,
} from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { Select } from "../../shared/design-system/ui/Select";
import styles from "./Usage.module.css";
import { DailyCostChart, type Series } from "./DailyCostChart";
import { amount, cost, count, percent } from "./format";
import {
  type AgentUsage,
  merge,
  modelName,
  since,
  stats,
  type Total,
} from "./stats";

const RANGES = [7, 30];
/** The chart's series colors. */
const SERIES = 4;
const ALL = "all";

type Load = Readonly<{
  loading: boolean;
  /** When the shown usage was read. */
  now: number;
  usage: readonly AgentUsage[];
  /** Agents whose sessions could not be read this time. */
  failed: readonly Agent[];
}>;
const keyOf = (agent: Agent) => `${agent.pubkey}:${agent.type}`;
/** The agent as a read sees it: a rename or new configuration reads again. */
const readKey = (agent: Agent) =>
  JSON.stringify([keyOf(agent), agent.name, agent.config]);

/** Reads each agent's sessions from its type, `READ_DAYS` back for every
 * period, again when the agents or `reload` change; earlier results stay shown
 * meanwhile. Each read is merged
 * over what earlier ones found, and an agent that cannot be read keeps it. */
function useUsage(agents: Agents, keys: string, reload: number) {
  const [load, setLoad] = useState<Load>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh reads the same agents again.
  useEffect(() => {
    const wanted = new Set(keys.split("\n"));
    const types = agents.types();
    const targets = agents
      .snapshot()
      .agents.filter((agent) => wanted.has(readKey(agent)));
    const controller = new AbortController();
    const now = Date.now();
    setLoad((current) => current && { ...current, loading: true });
    void Promise.allSettled(
      targets.map(async (agent) => {
        const read = types.find((type) => type.key === agent.type)?.usage;
        if (!read) throw new Error("No usage");
        return {
          agent,
          harness: agent.type,
          sessions: await read(agent, {
            since: since(now),
            signal: controller.signal,
          }),
        };
      }),
    ).then((results) => {
      if (controller.signal.aborted) return;
      setLoad((current) => ({
        loading: false,
        now,
        usage: targets.flatMap((agent, index) => {
          const kept = current?.usage.find(
            (entry) => keyOf(entry.agent) === keyOf(agent),
          );
          const result = results[index];
          if (result?.status !== "fulfilled") return kept ? [kept] : [];
          return [
            {
              ...result.value,
              sessions: merge(kept?.sessions ?? [], result.value.sessions),
            },
          ];
        }),
        failed: targets.filter(
          (_, index) => results[index]?.status === "rejected",
        ),
      }));
    });
    return () => controller.abort();
  }, [agents, keys, reload]);
  return load;
}

export function UsagePage({
  agents,
  open,
}: {
  agents: Agents;
  open: Navigation["open"];
}) {
  const snapshot = useSyncExternalStore(
    agents.subscribe,
    agents.snapshot,
    agents.snapshot,
  );
  const types = useSyncExternalStore(
    agents.subscribe,
    agents.types,
    agents.types,
  );
  const [days, setDays] = useState(30);
  const [chosenAgent, setAgentFilter] = useState(ALL);
  const [chosenHarness, setHarnessFilter] = useState(ALL);
  const [reload, setReload] = useState(0);
  const harnesses = types.filter((type) => type.usage);
  // Only agents here run sessions on this computer.
  const targets = snapshot.agents.filter(
    (agent) =>
      agent.place === "here" &&
      harnesses.some((type) => type.key === agent.type),
  );
  const keys = targets.map(readKey).join("\n");
  const load = useUsage(
    agents,
    snapshot.status === "ready" ? keys : "",
    reload,
  );
  const usedHarnesses = harnesses.filter((type) =>
    targets.some((agent) => agent.type === type.key),
  );
  // A choice that is gone, with its menu perhaps, filters nothing.
  const agentFilter = targets.some((agent) => agent.pubkey === chosenAgent)
    ? chosenAgent
    : ALL;
  const harnessFilter = usedHarnesses.some((type) => type.key === chosenHarness)
    ? chosenHarness
    : ALL;
  // Colors follow the harness, not its rank or the filters; harnesses past
  // the chart's colors share the last as Other.
  const own =
    usedHarnesses.length > SERIES
      ? usedHarnesses.slice(0, SERIES - 1)
      : usedHarnesses;
  const rest = usedHarnesses.slice(own.length);
  const series: Series[] = [
    ...own.map((type, index) => ({
      key: type.key,
      label: type.title,
      color: `var(--chart-series-${index + 1})`,
      harnesses: [type.key],
    })),
    ...(rest.length
      ? [
          {
            key: "other",
            label: "Other",
            color: `var(--chart-series-${SERIES})`,
            harnesses: rest.map((type) => type.key),
          },
        ]
      : []),
  ];
  const colorOf = (harness: string) =>
    series.find((entry) => entry.harnesses.includes(harness))?.color ??
    `var(--chart-series-${SERIES})`;
  const titleOf = (harness: string) =>
    harnesses.find((type) => type.key === harness)?.title ?? harness;
  const shown = useMemo(() => {
    if (!load) return undefined;
    const included = (agent: Agent) =>
      (agentFilter === ALL || agent.pubkey === agentFilter) &&
      (harnessFilter === ALL || agent.type === harnessFilter);
    const failed = load.failed.filter(included);
    return {
      result: stats(
        load.usage.filter((entry) => included(entry.agent)),
        load.now,
        days,
        new Set(failed.map((agent) => agent.type)),
      ),
      unread: failed.length > 0,
    };
  }, [load, agentFilter, harnessFilter, days]);
  const result = shown?.result;
  const loading = !load || load.loading;
  const refresh = useRef<HTMLButtonElement>(null);
  const retrying = useRef(false);
  // A retry that succeeds removes its button: focus moves to Refresh, unless
  // it moved elsewhere.
  useEffect(() => {
    if (!retrying.current || loading) return;
    retrying.current = false;
    if (!load?.failed.length && document.activeElement === document.body)
      refresh.current?.focus();
  }, [load, loading]);

  let body: ReactNode;
  if (snapshot.status === "error" || snapshot.status === "unavailable")
    body = (
      <EmptyState
        icon={<ChartBarIcon size="1.5rem" />}
        title="Agents aren’t available"
        description={
          snapshot.error ?? "Connect to a community to see your agents’ usage."
        }
      />
    );
  else if (snapshot.status !== "ready" || (targets.length && !result))
    body = <p className={styles.status}>Reading your agents’ sessions…</p>;
  else if (!targets.length || !result)
    body = (
      <EmptyState
        icon={<ChartBarIcon size="1.5rem" />}
        title="No agent usage to show"
        description="Usage reads the sessions your Claude Code, Codex and goose agents run on this computer. Add one from Agents to see what it spends."
      />
    );
  else
    body = (
      <Dashboard
        days={days}
        result={result}
        unread={shown?.unread ?? false}
        series={
          harnessFilter === ALL
            ? series
            : series.filter((entry) => entry.harnesses.includes(harnessFilter))
        }
        colorOf={colorOf}
        titleOf={titleOf}
        open={open}
        filters={
          <div className={styles.filters}>
            <Select
              label="Period"
              size="sm"
              value={String(days)}
              groups={[
                {
                  label: "Period",
                  options: RANGES.map((range) => ({
                    value: String(range),
                    label: `Last ${range} days`,
                  })),
                },
              ]}
              onValueChange={(value) => setDays(Number(value))}
            />
            {targets.length > 1 && (
              <Select
                label="Agent"
                size="sm"
                value={agentFilter}
                groups={[
                  {
                    label: "Agent",
                    options: [
                      { value: ALL, label: "All agents" },
                      ...targets.map((agent) => ({
                        value: agent.pubkey,
                        label: agent.name,
                      })),
                    ],
                  },
                ]}
                onValueChange={setAgentFilter}
              />
            )}
            {usedHarnesses.length > 1 && (
              <Select
                label="Harness"
                size="sm"
                value={harnessFilter}
                groups={[
                  {
                    label: "Harness",
                    options: [
                      { value: ALL, label: "All harnesses" },
                      ...usedHarnesses.map((type) => ({
                        value: type.key,
                        label: type.title,
                      })),
                    ],
                  },
                ]}
                onValueChange={setHarnessFilter}
              />
            )}
          </div>
        }
        notice={
          load?.failed.length ? (
            <p className={styles.notice} role="status">
              Couldn’t read the sessions of{" "}
              {load.failed.map((agent) => agent.name).join(", ")}
              {load.failed.some((agent) =>
                load.usage.some((entry) => keyOf(entry.agent) === keyOf(agent)),
              )
                ? "; showing what was read before. "
                : ". "}
              <Button
                size="sm"
                variant="ghost"
                loading={loading}
                onClick={() => {
                  retrying.current = true;
                  setReload((value) => value + 1);
                }}
              >
                Try again
              </Button>
            </p>
          ) : undefined
        }
      />
    );

  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Usage">
        <div className="flex h-full min-h-0 flex-col">
          <PanelHeader
            title={
              <PanelHeaderLabel
                title="Usage"
                icon={<ChartBarIcon size="1rem" />}
              />
            }
            actions={
              targets.length > 0 && (
                <IconButton
                  ref={refresh}
                  size="sm"
                  variant="ghost"
                  icon={<ArrowsClockwiseIcon size="1rem" aria-hidden="true" />}
                  aria-label="Refresh usage"
                  title="Refresh usage"
                  loading={loading}
                  onClick={() => setReload((value) => value + 1)}
                />
              )
            }
          />
          <div className={styles.scroll} aria-busy={loading}>
            {body}
          </div>
        </div>
      </FullPageSurface>
    </div>
  );
}

function Dashboard({
  days,
  result,
  unread,
  series,
  colorOf,
  titleOf,
  open,
  filters,
  notice,
}: {
  days: number;
  result: ReturnType<typeof stats>;
  /** Whether a read of an agent shown failed. */
  unread: boolean;
  series: readonly Series[];
  colorOf(harness: string): string;
  titleOf(harness: string): string;
  open: Navigation["open"];
  filters: ReactNode;
  notice: ReactNode;
}) {
  const period = `last ${days} days`;
  const top = result.agents[0];
  const spent = result.cost.value ?? 0;
  const before = result.previousCost?.value ?? 0;
  // Compared only when both periods were read and fully counted.
  const change =
    before > 0 && !result.cost.partial && !result.previousCost?.partial
      ? (spent - before) / before
      : undefined;
  const maxAgent = Math.max(
    ...result.agents.map((entry) => entry.cost.value ?? 0),
    0,
  );
  const harnessCount = new Set(result.agents.map((entry) => entry.harness))
    .size;
  return (
    <div className={styles.body}>
      {filters}
      {notice}
      {!result.sessions && unread ? (
        <EmptyState
          icon={<ChartBarIcon size="1.5rem" />}
          title="No sessions read"
          description="The sessions that couldn’t be read may include some from this period. Try again to read them."
        />
      ) : !result.sessions ? (
        <EmptyState
          icon={<ChartBarIcon size="1.5rem" />}
          title="No sessions in this period"
          description="Your agents ran no sessions here in the selected period. Choose a longer period or another agent."
        />
      ) : (
        <>
          <p className={styles.summary}>
            {result.agents.length === 1 && top ? (
              <>
                <b>{top.agent.name}</b> ran{" "}
                <b>{count(result.sessions, "session")}</b>
              </>
            ) : (
              <>
                Your <b>{result.agents.length} agents</b> ran{" "}
                <b>{count(result.sessions, "session")}</b>
              </>
            )}
            {harnessCount > 1 && (
              <>
                {" "}
                across <b>{harnessCount} harnesses</b>
              </>
            )}{" "}
            in the {period}.
            {top && result.agents.length > 1 && spent > 0 && (
              <>
                {" "}
                <b>{top.agent.name}</b> accounts for{" "}
                <b>{percent((top.cost.value ?? 0) / spent)}</b> of the{" "}
                {result.cost.partial ? "counted cost" : "cost"}
                {top.model && (
                  <>
                    , mostly on <b>{modelName(top.model)}</b>
                  </>
                )}
                .
              </>
            )}
          </p>
          <section className={styles.hero} aria-label="Estimated cost">
            <p className={styles.label}>Estimated cost · {period}</p>
            <p className={styles.heroValue}>{amount(result.cost, cost)}</p>
            <p className={styles.meta}>
              {change === undefined ? null : Math.abs(change) < 0.005 ? (
                <span>No change from the previous {days} days</span>
              ) : (
                <span className={styles.delta}>
                  {change > 0 ? (
                    <ArrowUpIcon size="0.875rem" aria-hidden="true" />
                  ) : (
                    <ArrowDownIcon size="0.875rem" aria-hidden="true" />
                  )}
                  {percent(Math.abs(change))} {change > 0 ? "more" : "less"}{" "}
                  than the previous {days} days
                </span>
              )}
              {result.cost.value !== undefined && (
                <span>{cost(spent / days)} a day</span>
              )}
              {result.cost.partial && <span>Partial</span>}
            </p>
            <p className={styles.footnote}>{footnote(result)}</p>
          </section>
          <div className={styles.tiles}>
            <Tile
              label="Tokens"
              value={amount(result.tokens, count)}
              detail={partly(
                result.tokens,
                `${amount(result.output, count)} output`,
              )}
            />
            <Tile
              label="Cache hit rate"
              value={result.cacheHit ? amount(result.cacheHit, percent) : "—"}
              detail={
                result.cacheHit?.partial
                  ? "Of the prompts with cache counts"
                  : "Prompt tokens read from cache"
              }
            />
            <Tile
              label="Sessions"
              value={String(result.sessions)}
              detail={`By ${count(result.agents.length, "agent")}`}
            />
          </div>
          <section className={styles.section}>
            <InlineHeader title="Daily cost" />
            <DailyCostChart days={result.days} series={series} />
          </section>
          <div className={styles.columns}>
            <section className={styles.section}>
              <InlineHeader title="By agent" />
              <ul className={styles.list}>
                {result.agents.map((entry) => (
                  <li key={entry.agent.pubkey} className={styles.agentRow}>
                    <Avatar
                      src={entry.agent.picture}
                      alt=""
                      fallback={entry.agent.name}
                      size="small"
                    />
                    <div className={styles.agentText}>
                      <span className={styles.name}>{entry.agent.name}</span>
                      <span className={styles.label}>
                        {[
                          titleOf(entry.harness),
                          entry.model && modelName(entry.model),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      <span className={styles.track} aria-hidden="true">
                        <span
                          className={styles.bar}
                          style={{
                            inlineSize: `${maxAgent ? ((entry.cost.value ?? 0) / maxAgent) * 100 : 0}%`,
                            background: colorOf(entry.harness),
                          }}
                        />
                      </span>
                    </div>
                    <Amount total={entry.cost} />
                  </li>
                ))}
              </ul>
            </section>
            <section className={styles.section}>
              <InlineHeader title="Costliest sessions" />
              <ul className={styles.list}>
                {result.costliest.map(({ agent, session, cost: total }) => {
                  const label = (
                    <span className={styles.sessionText}>
                      <span className={styles.name}>
                        {session.title ?? "Untitled session"}
                      </span>
                      <span className={styles.label}>
                        {[
                          agent.name,
                          new Date(session.lastAt).toLocaleDateString(
                            undefined,
                            { month: "short", day: "numeric" },
                          ),
                          session.gaps.length > 0 && "partly read",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                  );
                  const channelId = session.channelId;
                  return (
                    <li key={`${agent.pubkey}:${session.id}`}>
                      {channelId ? (
                        <NavigationItem
                          label={label}
                          trailing={<Amount total={total} />}
                          aria-label={`${session.title ?? "Untitled session"}, ${agent.name}, ${costLabel(total)}. Open conversation`}
                          onClick={() =>
                            void open({
                              version: 1,
                              kind: "conversation",
                              scope: {
                                viewer: agent.owner,
                                communityOrigin: relayOrigin(agent.relay),
                              },
                              channelId,
                              ...(session.root
                                ? {
                                    messageId: session.root,
                                    threadRootId: session.root,
                                  }
                                : {}),
                            })
                          }
                        />
                      ) : (
                        <div className={styles.staticRow}>
                          {label}
                          <Amount total={total} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

/** What the cost leaves out, and why. */
function footnote(result: ReturnType<typeof stats>) {
  const notes = [
    "Estimated from the session files on this computer, not your bill: at Anthropic API rates where the harness recorded no cost.",
    "Covers the history each harness keeps; Claude Code keeps 30 days by default.",
  ];
  if (result.unpriced.length)
    notes.push(
      `Not counted: ${result.unpriced.join(", ")}, which have no known rates.`,
    );
  if (result.incomplete)
    notes.push(
      `${count(result.incomplete, "session")} could not be fully read.`,
    );
  return notes.join(" ");
}

const partly = (total: Total, text: string) =>
  total.partial ? `${text} · partial` : text;
const costLabel = (total: Total) =>
  total.value === undefined
    ? "cost unavailable"
    : partly(total, cost(total.value));

/** A cost in a list row: `—` when unknown, marked when partial. */
function Amount({ total }: { total: Total }) {
  return (
    <span className={styles.value} title={costLabel(total)}>
      {total.value === undefined
        ? "—"
        : `${cost(total.value)}${total.partial ? "+" : ""}`}
    </span>
  );
}

function Tile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className={styles.tile}>
      <p className={styles.label}>{label}</p>
      <p className={styles.tileValue}>{value}</p>
      <p className={styles.label}>{detail}</p>
    </div>
  );
}
