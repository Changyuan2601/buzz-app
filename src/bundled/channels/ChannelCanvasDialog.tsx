import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChannelCanvas } from "../../features/channel-templates/capability";
import type { ProfileQueries } from "../../features/relay/profile-directory";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { CanvasHistory } from "./CanvasHistory";
import type { RelayEvent } from "../../features/relay/events";
import { readView, writeView } from "../../shared/view-state";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog, type DialogProps } from "../../shared/design-system/ui/Dialog";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import styles from "./ChannelTemplates.module.css";

type Draft = { content: string; base: string | null };
export function ChannelCanvasDialog({
  canvas,
  profiles,
  scope,
  channelId,
  open,
  onOpenChange,
  finalFocus,
}: {
  canvas: ChannelCanvas;
  profiles: ProfileQueries;
  scope: string;
  channelId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  finalFocus?: DialogProps["finalFocus"];
}) {
  const panelId = useId();
  const [tab, setTab] = useState<"edit" | "history">("edit");
  const key = `canvas-draft-v1:${channelId}`;
  const [saved] = useState(() => {
    const value = readView<unknown>(scope, key, null);
    if (!value || typeof value !== "object") return undefined;
    const raw = value as Partial<Draft>;
    return typeof raw.content === "string" &&
      (raw.base === null || typeof raw.base === "string")
      ? (raw as Draft)
      : undefined;
  });
  const [draft, setDraft] = useState(saved?.content ?? "");
  const [base, setBase] = useState<string | null>(saved?.base ?? null);
  const [head, setHead] = useState<RelayEvent>();
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const operation = useRef(0);
  const [confirmReload, setConfirmReload] = useState(false);
  const cancelReload = useRef<HTMLButtonElement>(null);
  useEffect(
    () => () => {
      operation.current++;
    },
    [],
  );
  const load = useCallback(
    async (replace = false) => {
      const generation = ++operation.current;
      setBusy(true);
      setError("");
      try {
        const event = await canvas.read(channelId);
        if (generation !== operation.current) return;
        setHead(event);
        setLoaded(true);
        if (replace || (!saved && !loaded)) {
          setDraft(event?.content ?? "");
          setBase(event?.id ?? null);
          writeView(scope, key, {
            content: event?.content ?? "",
            base: event?.id ?? null,
          });
        } else if ((event?.id ?? null) !== base)
          setError(
            "Canvas changed since this draft began. Your draft is kept. Copy any edits you want to keep before reloading the saved Canvas.",
          );
      } catch (reason) {
        if (generation === operation.current) setError(String(reason));
      } finally {
        if (generation === operation.current) setBusy(false);
      }
    },
    [canvas, channelId, saved, loaded, scope, key, base],
  );
  useEffect(() => {
    if (open && !loaded) void load();
  }, [open, loaded, load]);
  const dirty = (head?.id ?? null) !== base || draft !== (head?.content ?? "");
  const restore = async (revision: RelayEvent) => {
    const generation = ++operation.current;
    setBusy(true);
    try {
      const event = await canvas.save(channelId, revision.content, head?.id);
      if (generation !== operation.current) return;
      setHead(event);
      if (dirty) {
        setError(
          "Canvas was restored. Your unsaved draft is kept. Copy any edits you want to keep before reloading the saved Canvas.",
        );
      } else {
        setDraft(event.content);
        setBase(event.id);
        writeView(scope, key, { content: event.content, base: event.id });
        setError("");
      }
    } catch (reason) {
      // Save may replay the same signed event with its original precondition.
      // Even an error may follow a delivered write. Never adopt content, rebase
      // a draft, or start another restore on that uncertain outcome.
      try {
        const event = await canvas.read(channelId);
        if (generation === operation.current) setHead(event);
      } catch {
        /* Preserve the mutation error; explicit reload can retry. */
      }
      if (generation === operation.current)
        setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      if (generation === operation.current) setBusy(false);
    }
  };
  const save = async () => {
    const generation = ++operation.current;
    setBusy(true);
    setError("");
    try {
      const event = await canvas.save(channelId, draft, base ?? undefined);
      if (generation === operation.current) {
        setHead(event);
        setBase(event.id);
        writeView(scope, key, null);
        onOpenChange(false);
      }
    } catch (reason) {
      if (generation === operation.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (generation === operation.current) setBusy(false);
    }
  };
  return (
    <Dialog
      dismissOnOutsideClick
      open={open}
      onOpenChange={onOpenChange}
      finalFocus={finalFocus}
      preventClose={busy}
      title="Channel Canvas"
      closeLabel="Close Canvas"
      actions={
        tab === "edit" ? (
          <>
            {error && (
              <Button
                disabled={busy}
                onClick={() => {
                  if (!loaded) void load();
                  else setConfirmReload(true);
                }}
              >
                {loaded ? "Reload saved Canvas" : "Retry loading"}
              </Button>
            )}
            <Button
              variant="prominent"
              loading={busy}
              disabled={
                !loaded || !canvas.available || (head?.id ?? null) !== base
              }
              onClick={() => void save()}
            >
              Save Canvas
            </Button>
          </>
        ) : undefined
      }
    >
      <div className={styles.stack}>
        <Tabs
          variant="panel"
          label="Canvas views"
          value={tab}
          onValueChange={(next) => {
            if (!busy) setTab(next);
          }}
          items={[
            { value: "edit", label: "Edit", panelId: `${panelId}-edit` },
            {
              value: "history",
              label: "History",
              panelId: `${panelId}-history`,
            },
          ]}
        />
        <div
          hidden={tab !== "edit"}
          role="tabpanel"
          id={`${panelId}-edit`}
          aria-labelledby={`${panelId}-edit-tab`}
        >
          <div className={styles.stack}>
            <p className="text-secondary">
              Shared Markdown for this channel. Saves and restores check the
              loaded revision on supporting relays.
            </p>
            <Textarea
              aria-label="Canvas Markdown"
              variant="code"
              rows={16}
              value={draft}
              disabled={busy || !loaded}
              onChange={(e) => {
                setDraft(e.target.value);
                writeView(scope, key, { content: e.target.value, base });
              }}
            />
            {error && (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            )}
          </div>
        </div>
        <div
          hidden={tab !== "history"}
          role="tabpanel"
          id={`${panelId}-history`}
          aria-labelledby={`${panelId}-history-tab`}
        >
          {tab === "history" && (
            <CanvasHistory
              canvas={canvas}
              channelId={channelId}
              profiles={profiles}
              head={head}
              busy={busy}
              loaded={loaded}
              dirty={dirty}
              refreshHead={() => load()}
              restore={restore}
            />
          )}
        </div>
      </div>
      <Dialog
        size="compact"
        open={open && confirmReload}
        onOpenChange={setConfirmReload}
        dismissOnOutsideClick
        initialFocus={cancelReload}
        title="Reload saved Canvas?"
        actions={
          <>
            <Button ref={cancelReload} onClick={() => setConfirmReload(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmReload(false);
                void load(true);
              }}
            >
              Discard and reload
            </Button>
          </>
        }
      >
        Discard your draft and reload the saved Canvas?
      </Dialog>
    </Dialog>
  );
}
