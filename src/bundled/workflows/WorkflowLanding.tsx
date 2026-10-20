import { WORKFLOW_CHANNEL_BATCH } from "../../features/workflows/queries";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import type { ChannelSummary } from "../../features/relay/contracts";
import type {
  WorkflowCapability,
  WorkflowDefinition,
  WorkflowDefinitions,
  WorkflowOperation,
  WorkflowView,
} from "../../features/workflows/types";
import {
  ArrowRightIcon,
  DotsThreeIcon,
  CalendarIcon,
  ChatCircleIcon,
  GitPullRequestIcon,
  LightningIcon,
  EyeIcon,
  PencilSimpleIcon,
  PlayIcon,
  TrashIcon,
  PlusIcon,
  SmileyIcon,
  TimerIcon,
  WebhooksLogoIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
} from "../../shared/design-system/ui/Menu";
import { Switch } from "../../shared/design-system/ui/Switch";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { SwitchPreferenceRow } from "../../shared/design-system/ui/SwitchPreferenceRow";
import { WorkflowDeletionNotices } from "./WorkflowDeletionNotices";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { messages } from "./WorkflowOperations";
import { ConfirmAction } from "./ConfirmAction";
import { WorkflowRuns } from "./WorkflowRuns";
import { getWorkflowActivationWarning } from "./workflowActivationWarning";
import {
  workflowCardPresentation,
  type WorkflowCardIcon,
} from "./workflowCardPresentation";
import {
  readWorkflowDocumentFields,
  yamlWithWorkflowEnabled,
} from "./workflowYamlDocument";

const ICONS: Record<WorkflowCardIcon, typeof LightningIcon> = {
  delay: TimerIcon,
  diff: GitPullRequestIcon,
  message: ChatCircleIcon,
  reaction: SmileyIcon,
  schedule: CalendarIcon,
  webhook: WebhooksLogoIcon,
  workflow: LightningIcon,
};

const EMPTY_DEFINITIONS: WorkflowDefinitions = Object.freeze({
  items: Object.freeze([]),
  partial: false,
});

type DefinitionsSnapshot = ReturnType<
  WorkflowView<WorkflowDefinitions>["snapshot"]
>;

/** Whether this workflow's configuration still has a write in flight or a save
 * awaiting readback. Delivered run requests never lock configuration, and a
 * save is resolved once a newer head replaces it; the relay's expected-revision
 * check still rejects stale saves. */
export function workflowOperationLocked(
  operations: readonly WorkflowOperation[],
  definition: WorkflowDefinition,
) {
  let newestSave: WorkflowOperation | undefined;
  for (let index = operations.length - 1; index >= 0; index--) {
    const operation = operations[index];
    if (
      !operation ||
      operation.outcome === "rejected" ||
      operation.workflow.channelId !== definition.channelId ||
      operation.workflow.id !== definition.id ||
      operation.workflow.owner !== definition.owner
    )
      continue;
    if (operation.action === "delete" || operation.outcome === "pending")
      return true;
    if (operation.action === "save") newestSave ??= operation;
  }
  return !!newestSave && saveAwaitsReadback(newestSave, definition);
}

/** A save is resolved once its exact revision, or a newer head, is read. */
export function saveAwaitsReadback(
  save: WorkflowOperation,
  definition: WorkflowDefinition,
) {
  return (
    save.eventId !== definition.revision &&
    definition.createdAt <= save.createdAt
  );
}

function useLandingDefinitions(
  capability: WorkflowCapability,
  channels: readonly ChannelSummary[],
  refreshRequest: number,
  retryRequest: number,
  operationRefreshKey: string,
  saveReadback: Pick<WorkflowDefinition, "channelId" | "revision"> | undefined,
) {
  // Mount already reads current definitions; only consume subsequent notifications.
  const observedRefresh = useRef(refreshRequest);
  const observedReadback = useRef(saveReadback);
  const store = useMemo(() => {
    let snapshots: Readonly<Record<string, DefinitionsSnapshot>> = {};
    let paused = false;
    let state = { snapshots, paused };
    let channelIds: readonly string[] = [];
    const queued = new Map<string, boolean>();
    const listeners = new Set<() => void>();
    type Read = {
      ids: readonly string[];
      ifStale: boolean;
      view: WorkflowView<WorkflowDefinitions>;
      stop(): void;
    };
    let active: Read | undefined;
    let invalidated = false;
    // Retain one completed view to observe session clear/access loss even after
    // discovery finishes. All other views are disposed; at most two are live.
    let retained: Read | undefined;
    const emit = () => {
      state = { snapshots, paused };
      for (const listener of listeners) listener();
    };
    const release = (read: Read | undefined) => {
      read?.stop();
      read?.view.dispose();
    };
    const purge = (snapshot: DefinitionsSnapshot) => {
      invalidated = true;
      paused = false;
      queued.clear();
      const previous = active;
      active = undefined;
      release(previous);
      snapshots = Object.fromEntries(
        channelIds.map((id) => [
          id,
          {
            status: snapshot.status,
            data: EMPTY_DEFINITIONS,
            ...(snapshot.error ? { error: snapshot.error } : {}),
          },
        ]),
      );
      emit();
    };
    const failure = (id: string) => ({
      status: "error" as const,
      data: snapshots[id]?.data ?? EMPTY_DEFINITIONS,
      error: "Workflow read unavailable. Retry; this is not proof of deletion.",
    });
    const definitionsFor = (id: string, data: WorkflowDefinitions) => ({
      items: data.items.filter((row) => row.channelId === id),
      partial: data.partialChannelIds?.includes(id) ?? data.partial,
    });
    const hasCopiedData = (data: WorkflowDefinitions | undefined) =>
      !!data &&
      (data.items.length > 0 ||
        data.partial ||
        (data.partialChannelIds?.length ?? 0) > 0);
    const record = (owned: Read, snapshot: DefinitionsSnapshot) => {
      for (const id of owned.ids) {
        const previous = snapshots[id]?.data;
        snapshots = {
          ...snapshots,
          [id]: {
            ...snapshot,
            data:
              snapshot.status === "loading" || snapshot.status === "error"
                ? previous && hasCopiedData(previous)
                  ? previous
                  : definitionsFor(id, snapshot.data)
                : definitionsFor(id, snapshot.data),
          },
        };
      }
    };
    const pause = (owned: Read, snapshot: DefinitionsSnapshot) => {
      paused = true;
      for (const id of owned.ids) queued.set(id, false);
      if (active) {
        for (const id of active.ids) queued.set(id, false);
        if (active !== owned) release(active);
      }
      active = undefined;
      if (retained !== owned) release(retained);
      retained = owned;
      record(owned, snapshot);
      emit();
    };
    const observe = (ids: readonly string[], ifStale: boolean): Read => {
      const view = capability.definitions(ids);
      const owned = { ids, ifStale, view, stop: () => {} };
      owned.stop = view.subscribe(() => {
        if (active !== owned && retained !== owned) return;
        const snapshot = view.snapshot();
        if (snapshot.status === "idle" || snapshot.status === "unavailable") {
          purge(snapshot);
        } else if (snapshot.status === "error") {
          pause(owned, snapshot);
        } else {
          record(owned, snapshot);
          emit();
        }
      });
      return owned;
    };
    const readNext = () => {
      if (active || paused) return;
      const ids = channelIds
        .filter((id) => queued.has(id))
        .slice(0, WORKFLOW_CHANNEL_BATCH);
      const first = ids[0];
      if (!first) return;
      const ifStale = ids.every((id) => queued.get(id));
      for (const id of ids) queued.delete(id);
      let owned: Read;
      try {
        owned = observe(ids, ifStale);
        active = owned;
        void owned.view
          .refresh({ ifStale: owned.ifStale })
          .catch(() => {
            if (active === owned) pause(owned, failure(first));
          })
          .finally(() => {
            if (active !== owned) return;
            const snapshot = owned.view.snapshot();
            if (snapshot.status === "error") {
              pause(owned, snapshot);
              return;
            }
            record(owned, snapshot);
            release(retained);
            retained = owned;
            active = undefined;
            emit();
            readNext();
          });
      } catch {
        release(active);
        active = undefined;
        for (const id of ids) {
          snapshots = { ...snapshots, [id]: failure(id) };
          queued.set(id, false);
        }
        paused = true;
        emit();
      }
    };
    return {
      snapshot: () => state,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      channels(ids: readonly string[]) {
        // Membership changes re-establish authorized interest after a secure
        // purge. A session clear alone never restarts discovery.
        if (invalidated) snapshots = {};
        invalidated = false;
        channelIds = ids;
        const wanted = new Set(ids);
        if (active?.ids.some((id) => !wanted.has(id))) {
          const previous = active;
          active = undefined;
          for (const id of previous.ids)
            if (wanted.has(id)) queued.set(id, previous.ifStale);
          release(previous);
        }
        if (retained?.ids.some((id) => !wanted.has(id))) {
          release(retained);
          retained = undefined;
          // Keep copied snapshots subscribed to session invalidation without
          // rereading a completed channel just to replace the observer.
          const replacement = ids[0];
          if (replacement && !active) retained = observe([replacement], true);
        }
        for (const id of queued.keys()) if (!wanted.has(id)) queued.delete(id);
        snapshots = Object.fromEntries(
          Object.entries(snapshots).filter(([id]) => wanted.has(id)),
        );
        for (const id of ids)
          if (!snapshots[id]) {
            snapshots = {
              ...snapshots,
              [id]: { status: "loading", data: EMPTY_DEFINITIONS },
            };
            queued.set(id, true);
          }
        emit();
        readNext();
      },
      retry() {
        paused = false;
        readNext();
        emit();
      },
      refresh(ids = channelIds, afterPending = false) {
        invalidated = false;
        if (!afterPending) paused = false;
        for (const id of ids)
          if (channelIds.includes(id)) queued.set(id, false);
        // A pending read already satisfies refresh; never cancel and repeat it.
        if (active && !afterPending)
          for (const id of active.ids) queued.delete(id);
        readNext();
        emit();
      },
      dispose() {
        const previous = active;
        active = undefined;
        queued.clear();
        release(previous);
        release(retained);
        retained = undefined;
        snapshots = {};
        paused = false;
        state = { snapshots, paused };
      },
    };
  }, [capability]);
  const channelIdsKey = channels
    .map((channel) => channel.id)
    .sort()
    .join(":");
  useEffect(() => () => store.dispose(), [store]);
  useEffect(() => {
    store.channels(channelIdsKey ? channelIdsKey.split(":") : []);
  }, [channelIdsKey, store]);
  useEffect(() => {
    if (observedRefresh.current === refreshRequest) return;
    observedRefresh.current = refreshRequest;
    store.refresh();
  }, [refreshRequest, store]);
  useEffect(() => {
    if (retryRequest) store.retry();
  }, [retryRequest, store]);
  useEffect(() => {
    if (operationRefreshKey)
      store.refresh(
        operationRefreshKey.split(":").map((key) => key.split("/")[0] ?? ""),
        true,
      );
  }, [operationRefreshKey, store]);
  useEffect(() => {
    // The receipt-triggered read may finish before the saved head is visible.
    // Verified editor readback must also invalidate the landing’s copied result.
    if (observedReadback.current === saveReadback) return;
    observedReadback.current = saveReadback;
    if (
      saveReadback &&
      !store
        .snapshot()
        .snapshots[saveReadback.channelId]?.data.items.some(
          (definition) => definition.revision === saveReadback.revision,
        )
    )
      store.refresh([saveReadback.channelId], true);
  }, [saveReadback, store]);
  return {
    ...useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot),
    refresh: store.refresh,
  };
}

function WorkflowIcon({ kind }: { kind: WorkflowCardIcon }) {
  const Icon = ICONS[kind];
  return <Icon size={20} strokeWidth={2.5} aria-hidden="true" />;
}

function WorkflowCard({
  capability,
  channel,
  definition,
  detailTarget,
  locked,
  operations,
  selected,
  viewer,
  onError,
  onOpen,
  onDelete,
  onSelect,
  onRun,
}: {
  capability: WorkflowCapability;
  channel: ChannelSummary;
  definition: WorkflowDefinition;
  detailTarget: HTMLElement | null;
  locked: boolean;
  operations: readonly WorkflowOperation[];
  selected: boolean;
  viewer: string;
  onSelect: () => void;
  onRun: (eventId: string) => void;
  onError: (message: string | null) => void;
  onDelete: (definition: WorkflowDefinition) => void;
  onOpen: (definition: WorkflowDefinition, channel: ChannelSummary) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deletion = [...operations]
    .reverse()
    .find(
      (operation) =>
        operation.action === "delete" &&
        operation.outcome !== "rejected" &&
        operation.workflow.id === definition.id &&
        operation.workflow.owner === definition.owner &&
        operation.workflow.channelId === definition.channelId,
    );
  const [confirmEnable, setConfirmEnable] = useState(false);
  // The change and the revision it was submitted against.
  const [submitted, setSubmitted] = useState<{
    operationId: string;
    revision: string;
  } | null>(null);
  // History reads only the workflow's identity, which the card key fixes.
  const [history] = useState(definition);
  const openRef = useRef<HTMLButtonElement>(null);
  const wasSelected = useRef(selected);
  useEffect(() => {
    // Closing the detail returns lost focus to the card that opened it.
    if (
      wasSelected.current &&
      !selected &&
      (!document.activeElement || document.activeElement === document.body)
    )
      openRef.current?.focus();
    wasSelected.current = selected;
  }, [selected]);
  // Like the editor, a created run rereads history so it is shown.
  const createdRun = [...operations]
    .reverse()
    .find(
      (operation) =>
        operation.action === "trigger" &&
        !!operation.runId &&
        operation.workflow.channelId === definition.channelId &&
        operation.workflow.owner === definition.owner &&
        operation.workflow.id === definition.id,
    )?.eventId;
  const fields = readWorkflowDocumentFields(definition.yaml);
  const presentation = workflowCardPresentation(definition.yaml);
  const enabled = fields.enabled !== false;
  const readonly = definition.owner !== viewer;
  const submittedOperation = operations.find(
    (operation) => operation.eventId === submitted?.operationId,
  );
  const awaitingReadback =
    submitted?.revision === definition.revision &&
    submittedOperation?.outcome !== "rejected";
  const toggleReason = readonly
    ? "Only the author can change this workflow."
    : locked || awaitingReadback
      ? "Waiting for the submitted change to be resolved."
      : !fields.editable
        ? "Correct the YAML before changing the configured state."
        : !capability.availability.save
          ? "Saving is unavailable from this host."
          : undefined;
  const reasonId = useId();
  const warning = getWorkflowActivationWarning(definition.yaml);
  const name = fields.name || "Unnamed or malformed workflow";
  const runDisabled =
    readonly ||
    locked ||
    awaitingReadback ||
    !!deletion ||
    !capability.availability.trigger;
  const runNow = () => {
    if (runDisabled) return;
    try {
      onRun(capability.trigger(definition));
      onError(null);
    } catch (cause) {
      onError(
        cause instanceof Error ? cause.message : "Run could not be submitted.",
      );
    }
  };
  const toggle = (next: boolean) => {
    const yaml = yamlWithWorkflowEnabled(definition.yaml, next);
    if (yaml === null) {
      onError("This workflow cannot be changed from the landing page.");
      return;
    }
    try {
      const operationId = capability.save({
        channelId: channel.id,
        existing: definition,
        yaml,
      });
      setSubmitted({ operationId, revision: definition.revision });
      onError(null);
    } catch (cause) {
      onError(
        cause instanceof Error
          ? cause.message
          : "The workflow status could not be submitted.",
      );
    }
  };

  const triggerArt = presentation.triggerEmoji ? (
    <span className="workflow-card-emoji text-body">
      {presentation.triggerEmoji}
    </span>
  ) : (
    <WorkflowIcon kind={presentation.triggerIcon} />
  );
  const controls = (
    <div className="workflow-card-switch">
      <IconButton
        size="sm"
        variant="ghost"
        aria-label={`Run now: ${name}`}
        title="Run now"
        disabled={runDisabled}
        icon={<PlayIcon size="1rem" aria-hidden="true" />}
        onClick={runNow}
      />
      {fields.editable && (
        <Switch
          aria-label={`Enabled in configuration: ${name}`}
          aria-describedby={toggleReason ? reasonId : undefined}
          checked={enabled}
          disabled={!!toggleReason}
          onCheckedChange={(next) => {
            if (next === enabled) return;
            if (next && warning) setConfirmEnable(true);
            else toggle(next);
          }}
        />
      )}
      <MenuRoot>
        <MenuTrigger
          render={
            <IconButton
              aria-label={`Actions for ${name}`}
              size="sm"
              variant="ghost"
              icon={<DotsThreeIcon size="1rem" aria-hidden="true" />}
            />
          }
        />
        <MenuPopup size="compact" align="end">
          <MenuItem
            disabled={!!deletion}
            onClick={() => onOpen(definition, channel)}
          >
            <MenuIcon>
              {readonly ? (
                <EyeIcon size={14} />
              ) : (
                <PencilSimpleIcon size={14} />
              )}
            </MenuIcon>
            {readonly ? "View workflow" : "Edit workflow"}
          </MenuItem>
          <MenuItem
            tone="danger"
            disabled={
              readonly ||
              locked ||
              awaitingReadback ||
              !capability.availability.delete
            }
            onClick={() => setConfirmDelete(true)}
          >
            <MenuIcon>
              <TrashIcon size={14} />
            </MenuIcon>
            Delete workflow
          </MenuItem>
        </MenuPopup>
      </MenuRoot>
    </div>
  );
  const status = (
    <>
      {deletion && (
        <span role="status">
          {deletion.outcome === "pending"
            ? "Deleting…"
            : "Deletion unconfirmed"}
        </span>
      )}
      {!fields.editable && <span>Unreadable configuration</span>}
      {toggleReason && (
        <span id={reasonId} hidden>
          {toggleReason}
        </span>
      )}
    </>
  );
  const updated = (
    <time dateTime={new Date(definition.createdAt * 1000).toISOString()}>
      {new Date(definition.createdAt * 1000).toLocaleDateString()}
    </time>
  );
  const open = (
    <Button
      ref={openRef}
      aria-label={`Open ${name}`}
      aria-pressed={selected}
      data-workflow-card-open=""
      disabled={!!deletion}
      onClick={onSelect}
      variant="ghost"
    >
      Open {name}
    </Button>
  );
  const detail = (
    <section className="workflow-detail" aria-label={name}>
      <div className="workflow-detail-hero">
        <div className="workflow-detail-flow" aria-hidden="true">
          <span className="workflow-detail-icon">{triggerArt}</span>
          {presentation.actionIcons.map((action) => (
            <span className="workflow-detail-step" key={action.key}>
              <ArrowRightIcon size="0.875rem" />
              <span className="workflow-detail-icon">
                <WorkflowIcon kind={action.icon} />
              </span>
            </span>
          ))}
        </div>
        <h2 className="text-heading">{name}</h2>
        <p className="text-body-sm text-secondary">
          {presentation.description}
        </p>
        <p className="text-caption text-subtle">
          #{channel.name} · {updated}
        </p>
        <div className="workflow-detail-actions">
          <Button variant="primary" disabled={runDisabled} onClick={runNow}>
            <PlayIcon size="1rem" aria-hidden="true" />
            Run now
          </Button>
          <Button
            variant="outline"
            disabled={!!deletion}
            onClick={() => onOpen(definition, channel)}
          >
            {readonly ? (
              <EyeIcon size="1rem" aria-hidden="true" />
            ) : (
              <PencilSimpleIcon size="1rem" aria-hidden="true" />
            )}
            {readonly ? "View workflow" : "Edit workflow"}
          </Button>
          <MenuRoot>
            <MenuTrigger
              render={
                <IconButton
                  aria-label={`Actions for ${name}`}
                  size="md"
                  variant="outline"
                  icon={<DotsThreeIcon size="1rem" aria-hidden="true" />}
                />
              }
            />
            <MenuPopup size="compact" align="end">
              <MenuItem
                tone="danger"
                disabled={
                  readonly ||
                  locked ||
                  awaitingReadback ||
                  !capability.availability.delete
                }
                onClick={() => setConfirmDelete(true)}
              >
                <MenuIcon>
                  <TrashIcon size={14} />
                </MenuIcon>
                Delete workflow
              </MenuItem>
            </MenuPopup>
          </MenuRoot>
        </div>
      </div>
      {fields.editable && (
        <SettingsGroup>
          <SwitchPreferenceRow
            label="Enabled in configuration"
            description={
              toggleReason ??
              "Saved configuration only. Turning off does not confirm runs have stopped or cancel active runs."
            }
            checked={enabled}
            disabled={!!toggleReason}
            onCheckedChange={(next) => {
              if (next === enabled) return;
              if (next && warning) setConfirmEnable(true);
              else toggle(next);
            }}
          />
        </SettingsGroup>
      )}
      <WorkflowRuns
        key={createdRun ?? ""}
        capability={capability}
        workflow={history}
      />
    </section>
  );
  return (
    <>
      {selected && detailTarget && createPortal(detail, detailTarget)}
      <article className="workflow-card" data-selected={selected || undefined}>
        {open}
        <div className="workflow-card-content">
          <div className="workflow-card-topline">
            <div className="workflow-card-flow" aria-hidden="true">
              <span className="workflow-card-icon">{triggerArt}</span>
              {presentation.actionIcons.length > 0 && (
                <>
                  <ArrowRightIcon
                    className="workflow-card-arrow"
                    size="0.875rem"
                    aria-hidden="true"
                  />
                  {presentation.actionIcons.slice(0, 3).map((action) => (
                    <span className="workflow-card-icon" key={action.key}>
                      <WorkflowIcon kind={action.icon} />
                    </span>
                  ))}
                </>
              )}
            </div>
            {controls}
          </div>
          <h2 className="workflow-card-name text-label">{name}</h2>
          <p className="workflow-card-description text-body-sm text-secondary">
            {presentation.description}
          </p>
          <div className="workflow-card-meta text-caption text-subtle">
            <span className="workflow-card-identity">
              #{channel.name}
              {status}
            </span>
            {updated}
          </div>
        </div>
      </article>
      {confirmDelete && (
        <ConfirmAction
          title="Delete this workflow?"
          description="The saved workflow may remain visible. Work already running may continue."
          action="Delete workflow"
          cancel="Cancel"
          destructive
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            onDelete(definition);
          }}
        />
      )}
      {confirmEnable && (
        <ConfirmAction
          title={warning?.title ?? "Turn on this workflow?"}
          description={
            warning?.description ??
            "The relay may run this workflow as soon as its trigger matches."
          }
          action="Turn on"
          cancel="Keep off"
          onCancel={() => setConfirmEnable(false)}
          onConfirm={() => {
            setConfirmEnable(false);
            toggle(true);
          }}
        />
      )}
    </>
  );
}

function WorkflowChannelCards({
  capability,
  channel,
  detailTarget,
  operations,
  selected,
  snapshot,
  viewer,
  onOpen,
  onDelete,
  onSelect,
  onRun,
  onError,
}: {
  capability: WorkflowCapability;
  channel: ChannelSummary;
  detailTarget: HTMLElement | null;
  operations: readonly WorkflowOperation[];
  selected: string | undefined;
  snapshot: DefinitionsSnapshot | undefined;
  viewer: string;
  onSelect: (key: string | undefined) => void;
  onRun: (eventId: string) => void;
  onError: (message: string | null) => void;
  onDelete: (definition: WorkflowDefinition) => void;
  onOpen: (definition: WorkflowDefinition, channel: ChannelSummary) => void;
}) {
  if (!snapshot) return null;
  if (snapshot.status === "idle" || snapshot.status === "unavailable")
    return null;

  return (
    <>
      {snapshot.data.items.map((definition) => {
        const key = workflowKey(definition);
        return (
          <WorkflowCard
            capability={capability}
            channel={channel}
            definition={definition}
            detailTarget={detailTarget}
            key={key}
            locked={workflowOperationLocked(operations, definition)}
            onError={onError}
            onRun={onRun}
            onOpen={onOpen}
            onDelete={onDelete}
            onSelect={() => onSelect(selected === key ? undefined : key)}
            operations={operations}
            selected={selected === key}
            viewer={viewer}
          />
        );
      })}
      {snapshot.data.partial && (
        <div className="workflow-state-card text-body-sm text-secondary">
          #{channel.name} returned a partial workflow list.
        </div>
      )}
    </>
  );
}

const workflowKey = (definition: WorkflowDefinition) =>
  `${definition.channelId}:${definition.owner}:${definition.id}`;

export function WorkflowLanding({
  capability,
  channels,
  filter = "",
  refreshRequest,
  saveReadback,
  viewer,
  onCreate,
  onOpen,
  onDelete,
  detailTarget,
  selected,
  onSelect,
}: {
  capability: WorkflowCapability;
  channels: readonly ChannelSummary[];
  /** Element that receives the selected workflow's detail. */
  detailTarget: HTMLElement | null;
  selected: string | undefined;
  /** Reports the selected workflow and its name, or clears the selection. */
  onSelect: (key: string | undefined, name?: string) => void;
  /** Channel ID to show; every channel is still read. Empty shows all. */
  filter?: string;
  refreshRequest: number;
  saveReadback?: Pick<WorkflowDefinition, "channelId" | "revision"> | undefined;
  viewer: string;
  onCreate: () => void;
  onDelete: (definition: WorkflowDefinition) => void;
  onOpen: (definition: WorkflowDefinition, channel: ChannelSummary) => void;
}) {
  const operations = useSyncExternalStore(
    capability.operations.subscribe,
    capability.operations.snapshot,
    capability.operations.snapshot,
  );
  const [retryRequest, setRetryRequest] = useState(0);
  // Feedback outlives the card, which a filter may unmount.
  const [runRequests, setRunRequests] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dismissingRun, setDismissingRun] = useState(false);
  const dismissRun = async (eventId: string) => {
    if (dismissingRun) return;
    setDismissingRun(true);
    try {
      await capability.operations.dismiss(eventId);
      setRunRequests((current) => current.filter((id) => id !== eventId));
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Couldn't dismiss this notice. Try again.",
      );
    } finally {
      setDismissingRun(false);
    }
  };
  const runRequest = (eventId: string) =>
    setRunRequests((current) => [...current, eventId]);
  const operationRefreshKey = operations
    .filter(
      (operation) =>
        (operation.action === "save" || operation.action === "delete") &&
        (operation.outcome === "unknown" || operation.outcome === "succeeded"),
    )
    .map(
      (operation) =>
        `${operation.workflow.channelId}/${operation.eventId}/${operation.outcome}${operation.action === "delete" ? `/${operation.delivery}/${!!operation.error}` : ""}`,
    )
    .join(":");
  const { snapshots, paused, refresh } = useLandingDefinitions(
    capability,
    channels,
    refreshRequest,
    retryRequest,
    operationRefreshKey,
    saveReadback,
  );
  const visible = filter
    ? channels.filter((channel) => channel.id === filter)
    : channels;
  const reading = visible.some(
    (channel) =>
      !snapshots[channel.id] || snapshots[channel.id]?.status === "loading",
  );
  const items = visible.flatMap(
    (channel) => snapshots[channel.id]?.data.items ?? [],
  );
  const selectedItem = items.find(
    (definition) => workflowKey(definition) === selected,
  );
  const selectedName = selectedItem
    ? readWorkflowDocumentFields(selectedItem.yaml).name ||
      "Unnamed or malformed workflow"
    : undefined;
  useEffect(() => {
    // The detail follows the workflow; a vanished selection closes the pane.
    if (selected && !reading && !selectedName) onSelect(undefined);
    else if (selected && selectedName) onSelect(selected, selectedName);
  }, [onSelect, reading, selected, selectedName]);
  const cleared = visible.some(
    (channel) =>
      snapshots[channel.id]?.status === "idle" ||
      snapshots[channel.id]?.status === "unavailable",
  );
  const settledEmpty =
    !paused &&
    !reading &&
    visible.every(
      (channel) =>
        snapshots[channel.id]?.status === "ready" &&
        !snapshots[channel.id]?.data.items.length &&
        !snapshots[channel.id]?.data.partial,
    );
  return (
    <>
      <WorkflowDeletionNotices
        operations={operations}
        snapshots={snapshots}
        onCheck={refresh}
        onDismiss={(operation) =>
          capability.operations.dismiss(operation.eventId)
        }
      />
      {settledEmpty ? (
        <EmptyState
          icon={<LightningIcon size="1.5rem" aria-hidden="true" />}
          title={filter ? "No workflows in this channel yet." : "Workflows"}
          description="Automations that keep your community moving."
          action={
            capability.availability.save && (
              <Button onClick={onCreate}>
                <PlusIcon size="1rem" aria-hidden="true" />
                New workflow
              </Button>
            )
          }
        />
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: Escape from a card or its portaled detail clears the selection, as on Agents.
        <div
          className="workflow-collection"
          onKeyDown={(event) => {
            const target = event.target as Element;
            if (
              event.key === "Escape" &&
              selected &&
              !event.nativeEvent.isComposing &&
              !event.defaultPrevented &&
              (event.currentTarget.contains(target) ||
                target.closest(".workflow-detail"))
            ) {
              event.preventDefault();
              onSelect(undefined);
            }
          }}
        >
          {visible.map((channel) => (
            <WorkflowChannelCards
              capability={capability}
              channel={channel}
              detailTarget={detailTarget}
              key={channel.id}
              onOpen={onOpen}
              onDelete={onDelete}
              onSelect={onSelect}
              onRun={runRequest}
              onError={setError}
              operations={operations}
              selected={selected}
              snapshot={snapshots[channel.id]}
              viewer={viewer}
            />
          ))}
        </div>
      )}
      <p
        className="workflow-page-status text-body-sm text-secondary"
        role="status"
      >
        {paused
          ? "Workflow discovery paused. Some channels could not be checked. Loaded workflows are still shown."
          : reading
            ? "Reading workflows…"
            : cleared
              ? "Workflow data cleared or unavailable. Refresh to check access."
              : null}
        {paused && (
          <Button
            size="sm"
            onClick={() => setRetryRequest((request) => request + 1)}
          >
            Retry
          </Button>
        )}
      </p>
      {operations
        .filter(
          (run) =>
            runRequests.includes(run.eventId) && run.outcome !== "pending",
        )
        .map((run) => (
          <ToastNotice
            key={run.eventId}
            title={messages.trigger[run.outcome]}
            {...(run.outcome === "rejected"
              ? {
                  description:
                    run.error || "The relay did not create a workflow run.",
                }
              : {})}
            tone={
              run.outcome === "succeeded"
                ? "success"
                : run.outcome === "unknown"
                  ? "warning"
                  : "error"
            }
            timeout={run.outcome === "succeeded" ? 4000 : 0}
            {...(run.outcome === "succeeded"
              ? {
                  onDismiss: () =>
                    setRunRequests((current) =>
                      current.filter((eventId) => eventId !== run.eventId),
                    ),
                }
              : {})}
          >
            {run.outcome !== "succeeded" && (
              <Button
                size="compact"
                disabled={dismissingRun}
                onClick={() => void dismissRun(run.eventId)}
              >
                Dismiss notice
              </Button>
            )}
          </ToastNotice>
        ))}
      {error && (
        <ToastNotice
          key={error}
          title={error}
          onDismiss={() => setError(null)}
        />
      )}
      <p className="workflow-page-footnote text-caption text-subtle">
        Saved configuration only. Turning off does not confirm runs have stopped
        or cancel active runs.
      </p>
    </>
  );
}
