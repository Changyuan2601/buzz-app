import { useEffect, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import { AgentChoice } from "./AgentChoice";

/** The selected target is a composer choice; only relay membership grants access. */
export function SessionAgentControl({
  session,
  channelId,
  value,
  onChange,
  disabled,
}: {
  session: RelaySession;
  channelId: string;
  value: string;
  onChange: (key: string) => void;
  disabled: boolean;
}) {
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  const channel = list.channels.find((item) => item.id === channelId);
  const parent = list.channels.find(
    (item) => item.id === channel?.parentChannelId,
  );
  const memberKey = channel?.members?.join(":") ?? "";
  useEffect(() => {
    if (memberKey)
      void session.profiles
        .ensure(memberKey.split(":"), "background")
        .catch(() => {});
  }, [session, memberKey]);
  return (
    <AgentChoice
      session={session}
      value={value}
      onChange={onChange}
      disabled={disabled}
      emptyLabel="Choose follow-up assistant"
      clearLabel="No assistant"
      sessionMembers={channel?.members ?? []}
      parentMembers={
        channel?.parentChannelId ? (parent?.members ?? []) : undefined
      }
      parentName={parent?.name}
    />
  );
}
