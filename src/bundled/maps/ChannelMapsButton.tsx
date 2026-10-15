import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { MapIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";

export function ChannelMapsButton({
  channel,
  session,
  toggle,
  pressed = false,
}: {
  channel: ChannelSummary;
  session: RelaySession;
  toggle(): void;
  pressed?: boolean;
}) {
  const eligible = (item: ChannelSummary | undefined) =>
    !!item &&
    !item.cached &&
    !item.archived &&
    !item.readOnly &&
    !!session.viewer &&
    !!item.members?.includes(session.viewer);
  if (!eligible(channel)) return null;
  return (
    <IconButton
      size="sm"
      aria-label={pressed ? "Close channel map" : "Open channel map"}
      title={pressed ? "Close channel map" : "Open channel map"}
      aria-pressed={pressed}
      icon={<MapIcon size="1rem" aria-hidden="true" />}
      onClick={() => {
        if (
          !session.viewer ||
          !eligible(
            session.channels
              .list()
              .channels.find((item) => item.id === channel.id),
          )
        )
          return;
        toggle();
      }}
    />
  );
}
