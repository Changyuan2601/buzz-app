// An agent as a card: its portrait large, its name, and one line about it.
// Pack avatars play their animation; any other picture shows still.
import type { ComponentProps, ReactNode } from "react";
import { agentAvatars } from "../../features/agents/avatar-packs";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import { useAvatarPreview } from "../../features/profiles/use-avatar-preview";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import styles from "./AgentCard.module.css";
import { PackedAgentAvatar } from "./PackedAgentAvatar";

type Portrayed = Readonly<{ name: string; picture?: string | undefined }>;

/** An agent's picture: a pack avatar animates, any other shows through its
 * community's media access. */
export function AgentPortrait({
  agent,
  community,
}: {
  agent: Portrayed;
  community?: string | undefined;
}) {
  const pack = agentAvatars.find((avatar) => avatar.url === agent.picture);
  const src = useAvatarPreview(
    pack ? "" : (agent.picture ?? ""),
    community,
    "small",
  );
  if (pack) return <PackedAgentAvatar avatar={pack} />;
  return (
    <Avatar
      src={src}
      alt=""
      fallback={agent.name}
      size="fill"
      shape="squircle"
    />
  );
}

export function AgentCard({
  agent,
  community,
  detail,
  icon,
  tag,
  children,
  menu,
  ...props
}: Omit<ComponentProps<"div">, "className" | "children"> & {
  /** A short status beside the name, such as "Default agent". */
  tag?: ReactNode;
  agent: Portrayed;
  community?: string | undefined;
  /** One line under the name, such as its model. */
  detail?: ReactNode;
  icon?: ReactNode;
  /** Actions below the detail. */
  children?: ReactNode;
  menu?: ReactNode;
}) {
  return (
    <div {...props} className={styles.card}>
      {menu && <div className={styles.menu}>{menu}</div>}
      <span className={styles.portrait} aria-hidden="true">
        <AgentPortrait agent={agent} community={community} />
      </span>
      <span className={`${styles.name} text-label`}>{agent.name}</span>
      {tag && <span className={styles.tag}>{tag}</span>}
      {detail && (
        <span className={styles.detail}>
          {icon}
          <span className={styles.detailText}>{detail}</span>
        </span>
      )}
      {children && <span className={styles.actions}>{children}</span>}
    </div>
  );
}

/** A team as a card: its first members' portraits overlapped, its name, and
 * who is on it. */
export function TeamCard({
  name,
  members,
  note,
  ...props
}: Omit<ComponentProps<typeof SurfaceButton>, "className" | "children"> & {
  name: string;
  note?: string | undefined;
  members: readonly (Portrayed & { community?: string | undefined })[];
}) {
  return (
    <SurfaceButton {...props} type="button" className={styles.card}>
      <span className={styles.crew} aria-hidden="true">
        {members.slice(0, 3).map((member, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: members may share names; order is stable.
          <span key={index} className={styles.crewPortrait}>
            <AgentPortrait agent={member} community={member.community} />
          </span>
        ))}
      </span>
      <span className={`${styles.name} text-label`}>{name}</span>
      <span className={styles.detail}>
        <span className={styles.detailText}>
          {members.map((member) => member.name).join(", ") || "No members"}
        </span>
      </span>
      {note && <span className={styles.detailText}>{note}</span>}
    </SurfaceButton>
  );
}
