import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ComponentProps } from "react";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import {
  sameLabels,
  type ChannelDetails,
} from "../relay/channel-details-protocol";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { sessionShareAttempt, useSessionShareAttempts } from "./share-attempt";
import {
  sessionConversion,
  updateSessionConversion,
  useSessionConversions,
  type SessionConversion,
} from "./conversion";
import { sessionMetadata } from "./metadata";
import { applySharedChannelDetails } from "./share";

/** Presentation gating only; fresh signed details authorize the actual write. */
export function canConvertSession(
  session: RelaySession,
  channel?: ChannelSummary,
) {
  return !!(
    session.channelDetails?.available &&
    channel &&
    (channel.channelType === "session" ||
      !!sessionConversion(session, channel.id) ||
      (channel.channelType === "stream" &&
        session.mePlacement.has(channel.id))) &&
    !channel.parentChannelId &&
    !channel.cached &&
    !channel.readOnly &&
    !channel.archived
  );
}

/** Confirm metadata, remove this viewer’s Me placement, then hand off navigation. */
export function ConvertSession({
  session,
  id,
  signal,
  close,
  finalFocus,
  onConverted,
}: {
  session: RelaySession;
  id: string;
  signal?: AbortSignal | undefined;
  close(): void;
  onConverted?: (() => void) | undefined;
  finalFocus?: ComponentProps<typeof Dialog>["finalFocus"];
}) {
  const details = session.channelDetails;
  const sharing = useSessionShareAttempts(session).has(id);
  const receipt = useSessionConversions(session).get(id);
  const placement = useSyncExternalStore(
    session.mePlacement.subscribe,
    session.mePlacement.snapshot,
  );
  const converted = !!receipt?.converted;
  const notify = useToastNotification();
  const attempt = useSyncExternalStore(details.subscribe, () =>
    details.snapshot(id),
  );
  const [base, setBase] = useState<ChannelDetails>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const lifetime = useRef<AbortController | undefined>(undefined);
  const pending = useRef(false);
  const metadata = base && sessionMetadata(base.description);
  const conversionAttempt =
    attempt?.draft.description === "" ? attempt : undefined;
  const matchingAttempt = !!(
    base &&
    conversionAttempt &&
    conversionAttempt.draft.name === base.name &&
    conversionAttempt.draft.ttlSeconds === base.ttlSeconds &&
    (conversionAttempt.draft.labels === undefined ||
      sameLabels(conversionAttempt.draft.labels, base.labels ?? [])) &&
    (base.description === "" || (metadata && !metadata.parentId))
  );
  const eligible = !!base?.canEdit && !!metadata && !metadata.parentId;
  const removalOnly =
    !!receipt?.removalOnly ||
    (!receipt &&
      !!base &&
      !metadata &&
      placement.status === "ready" &&
      session.mePlacement.has(id));
  // Another details surface may have confirmed the same publication and retired
  // its receipt. Require fresh exact intent evidence, not absence of an attempt.
  const confirmedElsewhere = !!(
    base &&
    receipt &&
    !attempt &&
    base.description === receipt.draft.description &&
    base.name === receipt.draft.name &&
    base.visibility === receipt.draft.visibility &&
    base.ttlSeconds === receipt.draft.ttlSeconds
  );
  const canFinish = converted || confirmedElsewhere || removalOnly;
  // Uncertain intent belongs to the details owner, including the chosen privacy.
  const selectedVisibility =
    receipt?.draft.visibility ??
    conversionAttempt?.draft.visibility ??
    visibility;

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const active = AbortSignal.any([
      controller.signal,
      ...(signal ? [signal] : []),
    ]);
    setBase(undefined);
    setVisibility("private");
    setError("");
    setBusy(false);
    pending.current = false;
    void details
      .load(id, active)
      .then((next) => {
        if (!active.aborted) setBase(next);
      })
      .catch((reason) => {
        if (!active.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => controller.abort();
  }, [details, id, signal]);

  const run = async (action: "convert" | "reload" | "check" | "finish") => {
    const controller = lifetime.current;
    if (
      !controller ||
      controller.signal.aborted ||
      signal?.aborted ||
      pending.current
    )
      return;
    const active = AbortSignal.any([
      controller.signal,
      ...(signal ? [signal] : []),
    ]);
    pending.current = true;
    setBusy(true);
    setError("");
    let exact: SessionConversion | undefined;
    try {
      if (action === "reload") {
        const next = await details.load(id, active);
        if (!active.aborted) setBase(next);
      } else {
        if (sessionConversion(session, id)?.running)
          throw new Error("Conversion is already in progress in another view.");
        if (
          action !== "finish" &&
          (!base ||
            (action === "check"
              ? !matchingAttempt || attempt?.status !== "unconfirmed"
              : !eligible || !!attempt))
        )
          return;
        if (action === "finish" && !canFinish) return;
        if (action === "convert" && sessionShareAttempt(session, id))
          throw new Error(
            "Finish sharing or choose Start over before converting.",
          );
        if (!session.mePlacement.available)
          throw new Error(
            "Solo placement is unavailable on this connection. Try conversion on a supported connection.",
          );
        if (!base && !receipt) return;
        exact = sessionConversion(session, id) ?? {
          draft: {
            name: base?.name ?? "",
            description: "",
            visibility: selectedVisibility,
            ttlSeconds: base?.ttlSeconds,
          },
          ...(removalOnly ? { removalOnly: true } : {}),
        };
        exact.running = true;
        updateSessionConversion(session, id, exact);
        if (!exact.converted) {
          // Establish that Me can be read before changing the channel. The
          // preference owner refreshes again when removing, never overwrites blind.
          await session.mePlacement.refresh();
          active.throwIfAborted();
          if (session.mePlacement.snapshot().status !== "ready")
            throw new Error(
              "Solo placement could not be read. Retry before converting.",
            );
          if (action === "check") await details.check(id, active);
          else if (action === "finish") {
            const fresh = await details.load(id, active);
            if (
              exact.removalOnly
                ? !!sessionMetadata(fresh.description)
                : fresh.description !== exact.draft.description ||
                  fresh.name !== exact.draft.name ||
                  fresh.visibility !== exact.draft.visibility ||
                  fresh.ttlSeconds !== exact.draft.ttlSeconds
            )
              throw new Error(
                "Channel settings changed. Reload details before continuing.",
              );
          } else if (base)
            await applySharedChannelDetails(
              session,
              id,
              exact.draft,
              base,
              active,
            );
          exact.converted = true;
          updateSessionConversion(session, id, exact);
        }
        active.throwIfAborted();
        await session.mePlacement.set(id, false, { signal: active });
        active.throwIfAborted();
        if (
          session.mePlacement.snapshot().status !== "ready" ||
          session.mePlacement.has(id)
        )
          throw new Error("Removal from Solo could not be confirmed.");
        updateSessionConversion(session, id, undefined);
        if (!active.aborted) {
          notify(
            exact.removalOnly
              ? "Moved to Multiplayer."
              : "Converted to channel.",
            "success",
          );
          close();
          onConverted?.();
        }
      }
    } catch (reason) {
      if (!active.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (exact) {
        delete exact.running;
        if (sessionConversion(session, id) === exact)
          updateSessionConversion(
            session,
            id,
            exact.converted || details.snapshot(id) ? exact : undefined,
          );
      }
      if (!controller.signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <Dialog
      open
      title={removalOnly ? "Move to Multiplayer" : "Convert to channel"}
      description={
        removalOnly
          ? "Remove this conversation from Solo and open it in Multiplayer. Channel settings, history and members stay the same."
          : "Move this conversation from Solo to Multiplayer. History, Canvas, members and lifetime stay the same."
      }
      onOpenChange={(open) => {
        if (!open) close();
      }}
      preventClose={busy}
      finalFocus={finalFocus}
      actions={
        <>
          <Button onClick={close} disabled={busy}>
            {converted ? "Close" : "Cancel"}
          </Button>
          {canFinish ? (
            <Button
              variant="prominent"
              disabled={busy || !!receipt?.running || !!signal?.aborted}
              onClick={() => void run("finish")}
            >
              {removalOnly ? "Move to Multiplayer" : "Finish conversion"}
            </Button>
          ) : attempt?.status === "unconfirmed" && matchingAttempt ? (
            <Button
              disabled={busy || !!receipt?.running || !!signal?.aborted}
              onClick={() => void run("check")}
            >
              Check status
            </Button>
          ) : (
            <Button
              variant="prominent"
              disabled={
                busy ||
                !!receipt?.running ||
                sharing ||
                !!attempt ||
                !eligible ||
                !!signal?.aborted
              }
              onClick={() => void run("convert")}
            >
              Convert to channel
            </Button>
          )}
        </>
      }
    >
      {!removalOnly && (
        <Field label="Visibility" nativeLabel={false}>
          <RadioGroup
            aria-label="Visibility"
            value={selectedVisibility}
            disabled={
              busy ||
              converted ||
              !!receipt?.running ||
              sharing ||
              !!attempt ||
              !eligible ||
              !!signal?.aborted
            }
            onValueChange={(value) => {
              if (value === "private" || value === "public")
                setVisibility(value);
            }}
          >
            <Radio
              value="private"
              label="Private"
              description="Only channel members will have access."
            />
            <Radio
              value="public"
              label="Public"
              description="Everyone in this community will be able to view this channel’s full history."
            />
          </RadioGroup>
        </Field>
      )}
      {converted && !removalOnly && (
        <p role="status">Channel converted. Finish removing it from Solo.</p>
      )}
      {sharing && !converted && (
        <p role="status">
          Finish sharing or choose Start over before converting.
        </p>
      )}
      {!base && !error && <p role="status">Loading session details…</p>}
      {base && !base.canEdit && !canFinish && (
        <p role="status">You don’t have permission to convert this session.</p>
      )}
      {base?.canEdit && !eligible && !matchingAttempt && !canFinish && (
        <p role="status">Only a standalone session can be converted.</p>
      )}
      {attempt && !matchingAttempt && !converted && (
        <p role="status">
          Finish the existing channel details change before converting.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {error && !converted && (
        <Button
          disabled={busy || !!signal?.aborted}
          onClick={() => void run("reload")}
        >
          Reload session details
        </Button>
      )}
    </Dialog>
  );
}
