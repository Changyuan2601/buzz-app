import type { Profile } from "../../features/relay/contracts";
import { publicKeyLabels } from "../../shared/identity/public-key";
import styles from "./Channels.module.css";

export function WorkingAgentsBadge({
  agents,
  profiles,
  channelName,
}: {
  agents: readonly string[];
  profiles: ReadonlyMap<string, Profile>;
  channelName: string;
}) {
  if (!agents.length) return null;
  const labels = publicKeyLabels(agents);
  const name = (agent: string) =>
    profiles.get(agent)?.name ?? labels.get(agent) ?? "Agent";
  return (
    <span
      className={styles.thinkingBadge}
      data-channel-working=""
      data-indicator-layer="working"
      role="img"
      aria-label={`${agents.map(name).join(", ")} working in ${channelName}`}
    >
      <i aria-hidden="true" />
      <i aria-hidden="true" />
      <i aria-hidden="true" />
    </span>
  );
}
