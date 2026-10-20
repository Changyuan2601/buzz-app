import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { communityDestination } from "../features/communities/destination";
import type {
  CommunityReader,
  Membership,
} from "../features/communities/service";
import { CheckIcon } from "../shared/design-system/icons";
import { Avatar } from "../shared/design-system/ui/Avatar";
import { communityIcon } from "../features/communities/community-icon";
import { NavigationItem } from "../shared/design-system/ui/NavigationItem";
import { Tooltip } from "../shared/design-system/ui/Tooltip";
import { useToastNotification } from "../shared/design-system/ui/Toast";

/** A community reference is a copy action, not a Settings destination. */
export function CommunityAddress({
  community,
  communities,
}: {
  community: Membership;
  communities: CommunityReader;
}) {
  const icon = useSyncExternalStore(communities.subscribe, () => {
    const current =
      communities
        .snapshot()
        .memberships.find((entry) => entry.id === community.id) ?? community;
    return current.publishedIcon ?? communityIcon(current.icon);
  });
  const destination = communityDestination(community.id);
  return (
    <CopyAddress
      key={destination.url}
      url={destination.url}
      host={destination.name}
      community={community}
      icon={icon}
    />
  );
}

function CopyAddress({
  url,
  host,
  community,
  icon,
}: {
  url: string;
  host: string;
  community: Membership;
  icon: string | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const [hint, setHint] = useState(false);
  const visible = useRef(false);
  const pointerType = useRef("");
  const attempt = useRef(0);
  const notify = useToastNotification();
  useEffect(
    () => () => {
      attempt.current++;
    },
    [],
  );
  const copy = async () => {
    const current = ++attempt.current;
    setCopied(false);
    try {
      await navigator.clipboard.writeText(url);
      if (current === attempt.current) {
        setCopied(true);
        if (!visible.current || pointerType.current === "touch")
          notify("Community URL copied.", "success");
      }
    } catch {
      if (current === attempt.current)
        notify("Couldn’t copy the community URL.", "error");
    }
  };
  return (
    <>
      <Tooltip
        content={
          copied ? (
            <>
              <CheckIcon size={12} aria-hidden="true" /> Copied
            </>
          ) : (
            "Copy"
          )
        }
        follow="pointer"
        open={hint}
        onOpenChange={(open) => {
          visible.current = open;
          setHint(open);
          if (!open) setCopied(false);
        }}
        closeOnClick={false}
        disableHoverablePopup
      >
        <NavigationItem
          aria-label={`Copy community URL, ${host}`}
          label={host}
          icon={
            <Avatar
              src={icon}
              alt=""
              fallback={community.name}
              shape="squircle"
              size="compact"
            />
          }
          onPointerDown={(event) => {
            pointerType.current = event.pointerType;
          }}
          onPointerLeave={() => {
            visible.current = false;
            setHint(false);
            setCopied(false);
          }}
          onClick={(event) => {
            // This action must not trigger stacked navigation's content handoff.
            event.stopPropagation();
            void copy();
          }}
        />
      </Tooltip>
      <span className="sr-only" role="status">
        {copied ? "Community URL copied." : ""}
      </span>
    </>
  );
}
