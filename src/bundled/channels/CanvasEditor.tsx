import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  MAX_MARKDOWN_LENGTH,
  safeLinkUrl,
  scanMarkdown,
} from "../../features/relay/message-content";
import markdownStyles from "../../features/messages/Messages.module.css";
import type { ChannelCanvas } from "../../features/channel-templates/capability";
import type { ProfileQueries } from "../../features/relay/profile-directory";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { CanvasHistory } from "./CanvasHistory";
import type { RelayEvent } from "../../features/relay/events";
import {
  readView,
  replaceView,
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import styles from "./ChannelTemplates.module.css";
import panelStyles from "./Canvas.module.css";

type Draft = { content: string; base: string | null };
const markdownComponents: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      children
    ),
  img: ({ alt }) => alt ?? null,
};

function CanvasPreview({ content }: { content: string }) {
  const plain =
    content.length > MAX_MARKDOWN_LENGTH || scanMarkdown(content).tooDeep;
  return (
    <div className={plain ? markdownStyles.plainText : markdownStyles.text}>
      {plain ? (
        content
      ) : (
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={markdownComponents}
          urlTransform={(url) => safeLinkUrl(url) ?? ""}
        >
          {content}
        </Markdown>
      )}
    </div>
  );
}

export function CanvasEditor({
  canvas,
  profiles,
  scope,
  channelId,
  readOnly = false,
}: {
  canvas: ChannelCanvas;
  profiles: ProfileQueries;
  scope: string;
  channelId: string;
  readOnly?: boolean;
}) {
  const panelId = useId();
  const [tab, setTab] = useState<"edit" | "history">("edit");
  const [preview, setPreview] = useState(false);
  const previewButton = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const key = `canvas-draft-v1:${channelId}`;
  const draftRevision = useSyncExternalStore(
    useCallback((notify) => subscribeView(scope, notify), [scope]),
    () => viewRevision(scope, key),
  );
  const retiredDraft = useRef(false);
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
  const editor = useRef<HTMLTextAreaElement>(null);
  const recovery = useRef<HTMLButtonElement>(null);
  const [recovering, setRecovering] = useState(false);
  // The tab host places focus when Canvas opens, and a recovery button holds
  // it while its read is pending. Take it into the editor once a read lands
  // only if it is still there; never pull it back from elsewhere.
  const handoff = useRef<Element | null>(null);
  useEffect(() => {
    const host = editor.current?.closest("[data-panel-workspace]");
    handoff.current = host?.contains(document.activeElement)
      ? document.activeElement
      : null;
  }, []);
  useEffect(() => {
    const previous = handoff.current;
    if (!previous || !loaded || busy) return;
    handoff.current = null;
    if (
      previous === document.activeElement ||
      (document.activeElement === document.body &&
        (!previous.isConnected || previous === saveButton.current))
    )
      (preview ? previewButton.current : editor.current)?.focus();
  }, [loaded, busy, preview]);
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
        if (generation === operation.current) {
          // Focus stays on the renewed recovery button.
          handoff.current = null;
          setError(String(reason));
        }
      } finally {
        if (generation === operation.current) setBusy(false);
      }
    },
    [canvas, channelId, saved, loaded, scope, key, base],
  );
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  useEffect(() => {
    if (draftRevision !== "null") {
      retiredDraft.current = false;
      return;
    }
    if (!loaded || busy || retiredDraft.current) return;
    retiredDraft.current = true;
    void load(true);
  }, [draftRevision, loaded, busy, load]);
  const recover = (replace: boolean) => {
    handoff.current = recovery.current;
    setRecovering(true);
    void load(replace).finally(() => setRecovering(false));
  };
  const dirty = (head?.id ?? null) !== base || draft !== (head?.content ?? "");
  const restore = async (revision: RelayEvent) => {
    if (readOnly) return;
    const generation = ++operation.current;
    // Keep a clean snapshot stable if another editor opens during this write.
    if (viewRevision(scope, key) === "null")
      writeView(scope, key, { content: draft, base });
    const stored = viewRevision(scope, key);
    setBusy(true);
    try {
      const event = await canvas.save(channelId, revision.content, head?.id);
      // A write can land after this editor closed. Retire the unchanged draft
      // unless a reopened editor has replaced it since.
      if (!dirty) {
        retiredDraft.current = true;
        replaceView(scope, key, stored, null);
      }
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
    if (readOnly) return;
    handoff.current = document.activeElement;
    const generation = ++operation.current;
    // Keep a clean snapshot stable if another editor opens during this write.
    if (viewRevision(scope, key) === "null")
      writeView(scope, key, { content: draft, base });
    const stored = viewRevision(scope, key);
    setBusy(true);
    setError("");
    try {
      const event = await canvas.save(channelId, draft, base ?? undefined);
      // Retire the saved draft even if this editor has closed since.
      retiredDraft.current = true;
      replaceView(scope, key, stored, null);
      if (generation === operation.current) {
        setHead(event);
        setBase(event.id);
      }
    } catch (reason) {
      if (generation === operation.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (generation === operation.current) setBusy(false);
    }
  };
  const actions =
    tab === "edit" ? (
      <>
        <Button
          ref={previewButton}
          disabled={!loaded || busy}
          onClick={() => setPreview(!preview)}
        >
          {preview ? "Edit" : "Preview"}
        </Button>
        {(error || recovering) && (
          <Button
            ref={recovery}
            loading={busy}
            onClick={() => {
              if (!loaded) recover(false);
              else setConfirmReload(true);
            }}
          >
            {loaded ? "Reload saved Canvas" : "Retry loading"}
          </Button>
        )}
        <Button
          ref={saveButton}
          variant="prominent"
          loading={busy}
          title={loaded && !dirty && !busy ? "No changes to save" : undefined}
          disabled={
            readOnly ||
            !loaded ||
            !dirty ||
            !canvas.available ||
            (head?.id ?? null) !== base
          }
          onClick={() => void save()}
        >
          Save Canvas
        </Button>
      </>
    ) : undefined;
  const body = (
    <>
      <div className={panelStyles.body}>
        {readOnly && (
          <p role="status">Archived channel. Canvas is read-only.</p>
        )}
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
          className={panelStyles.edit}
        >
          <p className="text-secondary">Shared Markdown for this channel.</p>
          {readOnly && loaded && dirty && (
            <p role="status">
              Showing your unsaved local draft. Open History to view saved
              versions.
            </p>
          )}
          <div className={panelStyles.document}>
            <Textarea
              ref={editor}
              data-tab-focus
              readOnly={readOnly || busy}
              hidden={preview}
              aria-label="Canvas Markdown"
              aria-describedby={`${panelId}-status`}
              variant="code"
              rows={16}
              value={draft}
              disabled={!loaded}
              onChange={(e) => {
                setDraft(e.target.value);
                writeView(scope, key, { content: e.target.value, base });
              }}
            />
            {preview && (
              <section
                className={panelStyles.preview}
                aria-label="Canvas preview"
              >
                <CanvasPreview content={draft} />
              </section>
            )}
            <div
              id={`${panelId}-status`}
              role="status"
              className={panelStyles.status}
            >
              {loaded && dirty ? "Unsaved changes" : ""}
            </div>
          </div>
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
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
              readOnly={readOnly}
              refreshHead={() => load()}
              restore={restore}
            />
          )}
        </div>
      </div>
      <Dialog
        size="compact"
        open={confirmReload}
        onOpenChange={setConfirmReload}
        dismissOnOutsideClick
        initialFocus={cancelReload}
        // A reload that lands before this closes has removed its button.
        finalFocus={() =>
          recovery.current ?? (preview ? previewButton.current : editor.current)
        }
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
                recover(true);
              }}
            >
              Discard and reload
            </Button>
          </>
        }
      >
        Discard your draft and reload the saved Canvas?
      </Dialog>
    </>
  );
  return (
    <section
      className={panelStyles.panel}
      aria-label="Channel Canvas"
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key === "Escape" && busy) event.stopPropagation();
      }}
    >
      <div className={panelStyles.scroll}>{body}</div>
      {actions && <footer className={panelStyles.footer}>{actions}</footer>}
    </section>
  );
}
