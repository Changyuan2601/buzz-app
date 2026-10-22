import type { ReactNode } from "react";
import { AvatarArtworkContext } from "../../shared/design-system/ui/Avatar";
import { agentAvatars } from "./avatar-packs";
import { PackedAgentAvatar } from "./PackedAgentAvatar";

const packsBySource = new Map(
  agentAvatars.flatMap((avatar) => [
    [avatar.url, avatar] as const,
    [avatar.preview, avatar] as const,
  ]),
);
function renderArtwork(src: string) {
  const avatar = packsBySource.get(src);
  return avatar ? <PackedAgentAvatar avatar={avatar} /> : null;
}

/** One pack renderer for all avatars, including portalled profiles and menus. */
export function AgentAvatarArtworkProvider({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <AvatarArtworkContext value={renderArtwork}>
      {children}
    </AvatarArtworkContext>
  );
}
