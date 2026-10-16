import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import type { ChannelLifecycleCapability } from "../../features/relay/channel-lifecycle";
import type { ChannelLifecycleAction } from "../../features/relay/channel-lifecycle-protocol";
import { Dialog, type DialogProps } from "../../shared/design-system/ui/Dialog";
import {
  ToastNotice,
  useToastNotification,
} from "../../shared/design-system/ui/Toast";

const copy = {
  archive: {
    pending: "Archiving channel…",
    done: "Channel archived",
    title: "Archive channel",
    detail:
      "Archive this channel for everyone and remove it from the sidebar. Messages are kept. Find it in search and open Settings to unarchive it later.",
  },
  unarchive: {
    pending: "Unarchiving channel…",
    done: "Channel unarchived",
    title: "Unarchive channel",
    detail:
      "Unarchive this channel for everyone and return it to the sidebar. Members can send messages again.",
  },
  delete: {
    pending: "Deleting channel…",
    done: "Channel deleted",
    title: "Delete channel",
    detail: "This deletes the channel for everyone. You can’t undo this.",
  },
  leave: {
    pending: "Leaving channel…",
    done: "Channel left",
    title: "Leave channel",
    detail:
      "Leave this channel and remove it from your sidebar. You may need an invitation to rejoin a private channel.",
  },
  hide: {
    pending: "Hiding conversation…",
    done: "Conversation hidden",
    title: "Hide conversation",
    detail:
      "Hide this conversation from your sidebar only. Messages and membership are kept; other participants are not removed.",
  },
} as const;

// Enter confirms reversible actions; irreversible ones default to Cancel.
const reversible = new Set<ChannelLifecycleAction>([
  "archive",
  "unarchive",
  "hide",
]);

export function ChannelLifecycleDialog({
  channelId,
  channelName,
  action,
  lifecycle,
  close,
  completed,
  onSubmit,
  failed,
  finalFocus,
}: {
  channelId: string;
  channelName: string;
  action: ChannelLifecycleAction;
  lifecycle: ChannelLifecycleCapability;
  close(): void;
  completed(): void;
  onSubmit?(): void;
  failed?(title: string, message: string): void;
  finalFocus?: DialogProps["finalFocus"];
}) {
  const callbacks = useRef({ completed, failed });
  useLayoutEffect(() => {
    callbacks.current = { completed, failed };
  });
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const confirms = reversible.has(action);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const notify = useToastNotification();
  const operation = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    return () => {
      operation.current?.abort();
    };
  }, []);
  const submit = async () => {
    if (operation.current || error) return;
    const controller = new AbortController();
    operation.current = controller;
    onSubmit?.();
    setBusy(true);
    setError("");
    try {
      await lifecycle.run(action, channelId, controller.signal);
      if (!controller.signal.aborted) {
        notify(`${copy[action].done}: ${channelName}`, "success");
        callbacks.current.completed();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        if (callbacks.current.failed)
          callbacks.current.failed(`${copy[action].title} failed`, message);
        else setError(message);
      }
    } finally {
      operation.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  // Keep the owner mounted while closing the modal, so shared focus restoration
  // runs and the caller's duplicate gate remains held until the result settles.
  return (
    <>
      {(busy || error) && (
        <ToastNotice
          title={busy ? copy[action].pending : `${copy[action].title} failed`}
          description={busy ? channelName : error}
          tone={busy ? "info" : "error"}
          {...(!busy && { onDismiss: close })}
        />
      )}
      <Dialog
        open={!busy && !error}
        dismissOnOutsideClick
        initialFocus={confirms ? confirm : cancel}
        // Cancellation remains sidebar-owned; resolve the surviving submission
        // target when the popup closes, after Settings may have remounted.
        finalFocus={busy || error ? finalFocus : false}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title={
          action === "delete"
            ? `Delete ${channelName}?`
            : `${copy[action].title}: ${channelName}`
        }
        description={copy[action].detail}
        actions={
          <>
            <Button
              ref={cancel}
              type="button"
              variant={confirms ? "subtle" : "prominent"}
              onClick={close}
            >
              Cancel
            </Button>
            <Button
              type="button"
              ref={confirm}
              variant={
                action === "delete"
                  ? "destructive"
                  : confirms
                    ? "prominent"
                    : "subtle"
              }
              onClick={() => void submit()}
            >
              {copy[action].title}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </>
  );
}
