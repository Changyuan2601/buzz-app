import { useRef, useState } from "react";
import type { RelaySession } from "../relay/session";
import type { MemberAdditionIntent } from "../channel-members/members";
import { trackMemberAdditionReceipts } from "../channel-members/operations";
import {
  canShareConversation,
  destinationShareAudience,
  grantSoloChatAccess,
} from "../solo/share";
import { soloShareAttempt } from "../solo/share-attempt";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";

type Pending = {
  sources: readonly string[];
  signal: AbortSignal;
  current(): boolean;
  finish(send: boolean): void;
  grants: Map<string, Map<string, MemberAdditionIntent>>;
  channelName: string;
  audience?: readonly string[];
  busy: boolean;
  error?: string;
};

/** Consent only. Existing membership receipts own grants; the composer owns the one message/reply. */
export function useSessionLinkSharing(
  session: RelaySession | undefined,
  channelId: string,
  restoreFocus: () => void,
) {
  const [pending, setPending] = useState<Pending>();
  const adding = useRef(false);
  const safeAction = useRef<HTMLButtonElement>(null);
  async function share() {
    if (!session || !pending || adding.current) return;
    const request = pending;
    adding.current = true;
    setPending({ ...request, busy: true });
    const check = () => {
      request.signal.throwIfAborted();
      if (!request.current())
        throw new Error("The draft changed. Close this dialog and send again.");
    };
    try {
      check();
      // Capture once for this consent. A retry never silently widens its audience.
      request.audience ??= await destinationShareAudience(
        session,
        channelId,
        request.signal,
      );
      check();
      if (request.audience.length > 100)
        throw new Error(
          "This channel has too many members to share with at once. Send the link only, or share with people directly.",
        );
      // Check every source before starting any grant. A copied card is not authority.
      for (const id of request.sources) {
        const source = await session.channelWrites.refreshMembership(id);
        check();
        if (!canShareConversation(session, source))
          throw new Error(
            "You can’t share access to one of these chats. Send the link only, or ask its owner to share it.",
          );
        if (soloShareAttempt(session, id))
          throw new Error(
            "Finish the existing Share operation for this chat, then retry.",
          );
      }
      for (const id of request.sources) {
        check();
        const grants = request.grants.get(id);
        if (!grants)
          throw new Error(
            "Sharing intent is unavailable. Close and send again.",
          );
        const source = session.channels
          .list()
          .channels.find((channel) => channel.id === id);
        await grantSoloChatAccess(
          session,
          id,
          request.audience.filter((key) => !grants.get(key)?.confirmed),
          grants,
          request.signal,
          () => {},
          true,
          source?.channelType === "solo",
          true,
        );
      }
      check();
      request.finish(true);
    } catch (reason) {
      if (!request.signal.aborted)
        setPending({
          ...request,
          busy: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
    } finally {
      adding.current = false;
    }
  }
  return {
    prepare(
      sources: readonly string[],
      signal: AbortSignal,
      current: () => boolean,
    ): Promise<boolean> {
      signal.throwIfAborted();
      // Detached composers have no membership-grant capability. Keep their existing link-only path.
      if (!session) return Promise.resolve(true);
      const destination = session.channels
        .list()
        .channels.find((channel) => channel.id === channelId);
      // This slice covers channel/thread sharing. DMs, Solo sends and new-chat creation keep their current behavior.
      if (
        !sources.length ||
        !["stream", "forum"].includes(destination?.channelType ?? "")
      )
        return Promise.resolve(true);
      return new Promise((resolve) => {
        const grants = new Map(
          sources.map((id) => [id, new Map<string, MemberAdditionIntent>()]),
        );
        const stop = trackMemberAdditionReceipts(session.outbox, () =>
          [...grants.values()].flatMap((map) => [...map.values()]),
        );
        let settled = false;
        const finish = (send: boolean) => {
          if (settled) return;
          settled = true;
          stop?.();
          signal.removeEventListener("abort", abort);
          setPending(undefined);
          resolve(send);
        };
        const abort = () => finish(false);
        signal.addEventListener("abort", abort, { once: true });
        setPending({
          sources,
          signal,
          current,
          finish,
          grants,
          channelName: destination?.name ?? "",
          busy: false,
        });
        // Capture the audience on open so consent names who gets access.
        // Share grants exactly this audience; a failed read falls back to Share's capture.
        destinationShareAudience(session, channelId, signal).then(
          (audience) =>
            setPending((current) =>
              current?.finish === finish && !current.audience
                ? { ...current, audience }
                : current,
            ),
          () => {},
        );
      });
    },
    dialog: (
      <Dialog
        open={!!pending}
        title={
          pending?.sources.length === 1
            ? "Share access to this chat?"
            : "Share access to these chats?"
        }
        description={`Share gives ${audienceLabel(pending)}, including agents, access to the full chat history and future messages. Sending only the link leaves access unchanged.`}
        onOpenChange={(open) => {
          if (!open) pending?.finish(false);
        }}
        preventClose={!!pending?.busy}
        initialFocus={safeAction}
        finalFocus={() => {
          restoreFocus();
          return false;
        }}
        actions={
          <>
            <Button
              ref={safeAction}
              disabled={pending?.busy}
              onClick={() => pending?.finish(true)}
            >
              Send link only
            </Button>
            <Button
              variant="prominent"
              disabled={pending?.busy}
              onClick={() => void share()}
            >
              {pending?.busy
                ? "Sharing…"
                : pending?.error
                  ? "Retry share and send"
                  : "Share and send"}
            </Button>
          </>
        }
      >
        {pending?.error && (
          <p role="alert">
            {pending.error} Your message has not been sent. Some people may
            already have access; closing does not revoke it.
          </p>
        )}
      </Dialog>
    ),
  };
}

function audienceLabel(pending: Pending | undefined) {
  const channel = pending?.channelName
    ? `#${pending.channelName}`
    : "this channel";
  const count = pending?.audience?.length;
  if (count === undefined) return `the current members of ${channel}`;
  return `the ${count} other ${count === 1 ? "member" : "members"} of ${channel}`;
}
