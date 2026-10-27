import { useSyncExternalStore, type ComponentProps } from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
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
  Avatar:
    "This avatar is specific to this community and isn’t shared with other communities.",
};

export function useAgentScopeCommunity(
  relay: string | undefined,
  communities: CommunityReader | undefined,
) {
  const known = useSyncExternalStore(
    communities?.subscribe ?? noSubscribe,
    () => communities?.snapshot(),
  );
  return relay ? communityPresentation(relay, known?.memberships) : undefined;
}

export function AgentCommunityScope({
  community,
  scope,
  open,
  onOpenChange,
}: {
  community: ReturnType<typeof communityPresentation> | undefined;
  scope: keyof typeof descriptions;
  open?: boolean | undefined;
  onOpenChange?: ComponentProps<typeof PopoverRoot>["onOpenChange"];
}) {
  if (!community) return null;
  const { name, src } = community;
  return (
    <PopoverRoot open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        openOnHover="preview"
        render={
          scope === "Avatar" ? (
            <Button
              variant="plain"
              size="inline"
              aria-label={`Only in ${name}`}
              style={{ maxWidth: "100%" }}
            >
              <span className="flex min-w-0 flex-wrap items-center gap-2 text-subtle">
                Only in{" "}
                <Avatar
                  src={src}
                  alt=""
                  fallback={name}
                  shape="squircle"
                  size="compact"
                />
                <span className="min-w-0 break-words">{name}</span>
              </span>
            </Button>
          ) : (
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
          )
        }
      />
      <PopoverPopup
        side={scope === "Avatar" ? "bottom" : "top"}
        align={scope === "Avatar" ? "start" : "center"}
        aria-label={`${scope} scope`}
      >
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
