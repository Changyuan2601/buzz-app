import { useEffect, useState } from "react";
import { communityDestination } from "../communities/destination";
import { registerBrokerCommunity } from "../relay/transport";
import { avatarPreview } from "./avatar-upload";

/** A protected image must not mount before its destination is registered. */
export function useAvatarPreview(
  value: string,
  community?: string,
  size?: "small",
) {
  const source = avatarPreview(value, community, size);
  const destination =
    source?.startsWith("/api/relay/") && community
      ? communityDestination(community).id
      : undefined;
  const [registered, setRegistered] = useState<string>();
  useEffect(() => {
    if (!destination) return;
    const request = new AbortController();
    setRegistered(undefined);
    void registerBrokerCommunity(destination, request.signal).then(
      () => {
        if (!request.signal.aborted) setRegistered(destination);
      },
      () => {
        // Keep the existing initials fallback; never expose an unregistered URL.
      },
    );
    return () => request.abort();
  }, [destination]);
  return !destination || registered === destination ? source : undefined;
}
