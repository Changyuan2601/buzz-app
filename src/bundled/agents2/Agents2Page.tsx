import { useState } from "react";
import { useAgents2 } from "../../features/agents2/react";
import type { Agents2 } from "../../features/agents2/service";
import type { Panels } from "../../features/panels/service";
import type { RelayData } from "../../features/relay/service";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { PlusIcon } from "../../shared/design-system/icons";
import { NewAgentCard } from "./NewAgentCard";
import { AgentInventory } from "./AgentInventory";
import { AgentProfileDialog } from "./AgentProfileDialog";
import styles from "./Agents2Page.module.css";

// Inventory owns opening intent. Profile content is always the registered owner.
export function Agents2Page({
  agents2,
  relay,
  panels,
}: {
  agents2: Agents2;
  relay: RelayData;
  panels?: Panels;
}) {
  const { snapshot, types } = useAgents2(agents2);
  const [focused, setFocused] = useState<string>();
  const [opening, setOpening] = useState<{ pubkey?: string }>();
  const open = (pubkey: string) => setOpening({ pubkey });
  const create = () => setOpening({});
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Agents2">
        <div className="flex h-full min-h-0 flex-col">
          <PanelHeader
            title={<PanelHeaderLabel title="Agents2" />}
            actions={
              types.length > 0 && snapshot.status === "ready" ? (
                <IconButton
                  size="sm"
                  aria-label="Create agent"
                  icon={<PlusIcon size={16} />}
                  onClick={create}
                />
              ) : undefined
            }
          />
          <div className={styles.inventory}>
            {snapshot.status === "unavailable" ? (
              <EmptyState
                icon="✦"
                title="Agents2 runs in the desktop app"
                description="Agent keys stay in the desktop app's native custody."
              />
            ) : snapshot.status === "error" ? (
              <EmptyState
                icon="!"
                title="Agents could not load"
                description={snapshot.error ?? "Try again."}
              />
            ) : snapshot.agents.length ? (
              <AgentInventory
                agents={snapshot.agents}
                selected={focused}
                typeOf={(item) => types.find((type) => type.key === item.type)}
                onSelect={setFocused}
                onBuild={open}
                onCreate={types.length ? create : undefined}
                creating={false}
              />
            ) : snapshot.status === "ready" ? (
              types.length ? (
                <div className={styles.emptyInventory}>
                  <div className={styles.emptyCreation}>
                    <NewAgentCard onCreate={create} />
                  </div>
                  <p className="text-body-sm text-secondary">
                    Create an agent to work with you.
                  </p>
                </div>
              ) : (
                <EmptyState
                  icon="✦"
                  title="No agents yet"
                  description="Enable an agent type plugin to make one."
                />
              )
            ) : null}
          </div>
        </div>
        {opening && (
          <AgentProfileDialog
            agents2={agents2}
            relay={relay}
            panels={panels}
            pubkey={opening.pubkey}
            onClose={() => setOpening(undefined)}
          />
        )}
      </FullPageSurface>
    </div>
  );
}
