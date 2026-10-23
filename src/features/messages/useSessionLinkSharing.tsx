import { useRef, useState } from "react";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
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
  /** Captured members missing from at least one chat; unknown when a read failed. */
  count?: number;
  busy: boolean;
  error?: string;
  /** Share can't succeed for this consent; only link-only remains. */
  blocked?: string;
  tried?: boolean;
  started?: boolean;
};

/** A reason that retrying this consent can't change. */
class Unshareable extends Error {}

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
    request.tried = true;
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
      // Check every source before starting any grant. A copied card is not authority.
      const sources: ChannelSummary[] = [];
      for (const id of request.sources) {
        sources.push(await session.channelWrites.refreshMembership(id));
        check();
      }
      const blocked = shareBlocker(session, sources, request.audience);
      if (blocked) throw new Unshareable(blocked);
      for (const source of sources) {
        if (soloShareAttempt(session, source.id)) throw new Error(competing);
      }
      request.started = true;
      for (const source of sources) {
        check();
        const grants = request.grants.get(source.id);
        if (!grants)
          throw new Error(
            "Sharing intent is unavailable. Close and send again.",
          );
        await grantSoloChatAccess(
          session,
          source.id,
          request.audience.filter(
            (key) =>
              !grants.get(key)?.confirmed && !source.members?.includes(key),
          ),
          grants,
          request.signal,
          check,
          true,
          source.channelType === "solo",
          true,
          // A dispatched addition may finish; a changed draft stops the next one.
          check,
        );
      }
      check();
      request.finish(true);
    } catch (reason) {
      if (!request.signal.aborted) {
        const message =
          reason instanceof Error ? reason.message : String(reason);
        const { error: _, ...rest } = request;
        setPending({
          ...rest,
          busy: false,
          ...(reason instanceof Unshareable
            ? { blocked: message }
            : { error: message }),
        });
      }
    } finally {
      adding.current = false;
    }
  }
  return {
    async prepare(
      sources: readonly string[],
      signal: AbortSignal,
      current: () => boolean,
    ): Promise<boolean> {
      signal.throwIfAborted();
      // Detached composers have no membership-grant capability. Keep their existing link-only path.
      if (!session) return true;
      const destination = session.channels
        .list()
        .channels.find((channel) => channel.id === channelId);
      // This slice covers channel/thread sharing. DMs, Solo sends and new-chat creation keep their current behavior.
      if (
        !sources.length ||
        !["stream", "forum"].includes(destination?.channelType ?? "")
      )
        return true;
      // Capture the audience before asking so consent names who gets access,
      // and skip asking when everyone already has access. Share grants exactly
      // this audience; a failed read falls back to Share's own capture.
      const audience = await destinationShareAudience(
        session,
        channelId,
        signal,
      ).catch(() => undefined);
      signal.throwIfAborted();
      const known = audience && (await readSources(session, sources));
      signal.throwIfAborted();
      const missing =
        audience && known && missingAccess(known, audience).length;
      if (missing === 0) return true;
      // Surface known failures before consent instead of after Share.
      const blocked =
        audience && known && shareBlocker(session, known, audience);
      const busy = known?.some((source) =>
        soloShareAttempt(session, source.id),
      );
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
          ...(audience ? { audience } : {}),
          ...(missing === undefined ? {} : { count: missing }),
          ...(blocked ? { blocked } : busy ? { error: competing } : {}),
          busy: false,
        });
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
        description={pending?.blocked ?? consentDescription(pending)}
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
            {!pending?.blocked && (
              <Button
                variant="prominent"
                disabled={pending?.busy}
                onClick={() => void share()}
              >
                {pending?.busy
                  ? "Sharing…"
                  : pending?.error && pending.tried
                    ? "Retry share and send"
                    : "Share and send"}
              </Button>
            )}
          </>
        }
      >
        {pending?.error && (
          <p role="alert">
            {pending.error}
            {pending.tried && " Your message has not been sent."}
            {pending.started &&
              " Some people may already have access; closing does not revoke it."}
          </p>
        )}
      </Dialog>
    ),
  };
}

function consentDescription(pending: Pending | undefined) {
  const channel = pending?.channelName
    ? `#${pending.channelName}`
    : "this channel";
  const count = pending?.count;
  const audience =
    count === undefined
      ? `the current members of ${channel}`
      : `the ${count} other ${count === 1 ? "member" : "members"} of ${channel}`;
  return `Share gives ${audience}, including agents, access to the full chat history and future messages. Sending only the link leaves access unchanged.`;
}

const competing =
  "Finish the existing Share operation for this chat, then retry.";

/** Fresh source rosters, or undefined when any can't be read. */
async function readSources(session: RelaySession, sources: readonly string[]) {
  try {
    const known: ChannelSummary[] = [];
    for (const id of sources)
      known.push(await session.channelWrites.refreshMembership(id));
    return known;
  } catch {
    return undefined;
  }
}

/** Captured members Share would grant: those missing from at least one chat. */
function missingAccess(
  sources: readonly ChannelSummary[],
  audience: readonly string[],
) {
  return audience.filter((key) =>
    sources.some((source) => !source.members?.includes(key)),
  );
}

/** Failures no retry of this consent can fix. */
function shareBlocker(
  session: RelaySession,
  sources: readonly ChannelSummary[],
  audience: readonly string[],
) {
  if (sources.some((source) => !canShareConversation(session, source)))
    return "You can’t share access to this chat, so some people may not be able to open it. Send the link only, or ask its owner to share it.";
  if (missingAccess(sources, audience).length > 100)
    return "This channel has too many members to share with at once. Send the link only, or share with people directly.";
  return undefined;
}
