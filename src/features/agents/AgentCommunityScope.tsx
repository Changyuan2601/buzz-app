import { useSyncExternalStore } from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { communityPresentation } from "../communities/community-icon";
import type { CommunityReader } from "../communities/service";

const noSubscribe = () => () => {};
const descriptions = {
  Memory:
    "Memories are specific to this community and aren’t shared with other communities.",
  Attention:
    "Attention is specific to this community and isn’t shared with other communities.",
};

export function AgentCommunityScope({
  relay,
  scope,
  communities,
}: {
  relay: string | undefined;
  scope: "Memory" | "Attention";
  communities: CommunityReader | undefined;
}) {
  const known = useSyncExternalStore(
    communities?.subscribe ?? noSubscribe,
    () => communities?.snapshot(),
  );
  if (!relay) return null;
  const { name, src } = communityPresentation(relay, known?.memberships);
  return (
    <PopoverRoot>
      <PopoverTrigger
        openOnHover="preview"
        render={
          <IconButton
            aria-label={`${scope} scope: ${name}`}
            variant="avatar"
            shape="squircle"
            size="xs"
            icon={
              <span className="inline-flex h-4 w-4">
                <Avatar
                  src={src}
                  alt=""
                  fallback={name}
                  shape="squircle"
                  size="fill"
                />
              </span>
            }
          />
        }
      />
      <PopoverPopup side="top" align="center" aria-label={`${scope} scope`}>
        <div className="mb-2 flex items-center gap-2 text-body-sm">
          <Avatar
            src={src}
            alt=""
            fallback={name}
            shape="squircle"
            size="small"
          />
          <span className="min-w-0 break-words">{name}</span>
        </div>
        <p className="m-0 text-body-sm text-subtle">{descriptions[scope]}</p>
      </PopoverPopup>
    </PopoverRoot>
  );
}
