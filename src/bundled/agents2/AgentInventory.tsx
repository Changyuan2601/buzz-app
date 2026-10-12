import { useRef, type KeyboardEvent } from "react";
import type {
  Agent,
  RegisteredAgentType,
} from "../../features/agents2/service";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { CollectionCard } from "../../shared/design-system/ui/CollectionCard";
import { NewAgentCard } from "./NewAgentCard";
import styles from "./Agents2Page.module.css";

/** The type's one-line summary of an agent; its title when it has none. */
export function summaryOf(agent: Agent, type: RegisteredAgentType | undefined) {
  if (!type) return "Type unavailable";
  try {
    return type.summary?.(agent).trim() || type.title;
  } catch {
    return type.title;
  }
}

/** The grid as one listbox: a single tab stop, arrows move the selection. */
export function AgentInventory({
  agents,
  selected,
  typeOf,
  onSelect,
  onBuild,
  onCreate,
  creating,
}: {
  agents: readonly Agent[];
  selected: string | undefined;
  typeOf(agent: Agent): RegisteredAgentType | undefined;
  onSelect(pubkey?: string): void;
  onBuild(pubkey: string): void;
  onCreate: (() => void) | undefined;
  creating: boolean;
}) {
  const grid = useRef<HTMLElement>(null);
  const index = agents.findIndex((agent) => agent.pubkey === selected);
  const columns = () =>
    grid.current
      ? getComputedStyle(grid.current).gridTemplateColumns.split(" ").length
      : 1;
  const onKeyDown = (event: KeyboardEvent) => {
    const last = agents.length - 1;
    const focused = Array.from(
      grid.current?.querySelectorAll('[role="button"]') ?? [],
    ).indexOf(document.activeElement as Element);
    const from = focused >= 0 ? focused : index;
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: columns(),
      ArrowUp: -columns(),
    };
    let next: number | undefined;
    if (event.key in step) {
      const delta = step[event.key] ?? 0;
      next = from < 0 ? 0 : from + delta;
      if (next < 0 || next > last)
        next = Math.abs(delta) === 1 ? Math.min(Math.max(next, 0), last) : from;
    } else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Escape" && selected) {
      event.preventDefault();
      onSelect();
      return;
    }
    if (next === undefined) return;
    event.preventDefault();
    onSelect(agents[next]?.pubkey);
    grid.current
      ?.querySelectorAll<HTMLElement>('[role="button"]')
      [next]?.focus();
  };
  return (
    <div className={styles.inventoryCollection}>
      {onCreate && (
        <div className={styles.creationCell}>
          <NewAgentCard onCreate={onCreate} disabled={creating} />
        </div>
      )}
      <section
        ref={grid}
        data-creation={onCreate ? "" : undefined}
        aria-label="Agents"
        className={styles.grid}
        onKeyDown={onKeyDown}
      >
        {agents.map((agent, position) => {
          const type = typeOf(agent);
          const active = agent.pubkey === selected;
          return (
            <CollectionCard
              key={agent.pubkey}
              role="button"
              data-unavailable={type ? undefined : ""}
              tabIndex={active || (index < 0 && position === 0) ? 0 : -1}
              onClick={() => {
                onSelect(agent.pubkey);
                onBuild(agent.pubkey);
              }}
              artwork={
                <Avatar
                  alt=""
                  fallback={agent.name}
                  size="fill"
                  shape="squircle"
                />
              }
              title={agent.name}
              description={summaryOf(agent, type)}
            />
          );
        })}
      </section>
    </div>
  );
}
