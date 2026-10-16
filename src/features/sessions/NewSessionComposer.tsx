import {
  canonicalDetailsName,
  detailsDraftErrors,
} from "../relay/channel-details-protocol";
import { readPending, type PendingStart } from "./pending-start";
import { DraftSessionSettings } from "./DraftSessionSettings";
import { NewSessionView } from "./SessionPresentation";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { GearIcon } from "../../shared/design-system/icons";
import {
  applySessionSetup,
  removedSectionMessage,
  loadSessionSetup,
  parseSessionSetup,
} from "./workspace";
import { Button } from "../../shared/design-system/ui/Button";
import { useEffect, useRef, useState } from "react";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import {
  readView,
  writeView,
  subscribeView,
  viewRevision,
} from "../../shared/view-state";
import { MessageComposer } from "../messages/MessageComposer";
import { AgentChoice } from "./AgentChoice";
import { SessionProjectControl } from "./SessionProjectControl";
import { writeSelectedAssistant } from "./selected-assistant";
import { composerMarkdown } from "../messages/composer-markdown";
import { mentionDraft, type MentionDraft } from "../messages/mention-draft";
import type { ConversationExtensions } from "../conversation/contracts";
import { sessionRecipients } from "./recipients";
import styles from "./Sessions.module.css";

/** Starting a new chat from a project starts it in that project, even when an
 * earlier draft there was switched to another one. */
function readDraftSettings(scope: string, draftKey: string) {
  const saved = readView<unknown>(scope, `${draftKey}:settings`, null);
  if (typeof saved === "string") return { canvas: saved, name: "" };
  const settings = saved && typeof saved === "object" ? saved : {};
  return {
    name: "name" in settings ? (settings.name as string) : "",
    canvas:
      "canvas" in settings && typeof settings.canvas === "string"
        ? settings.canvas
        : undefined,
    // Preserve malformed lifetime input for the existing visible validation.
    ttlSeconds: ("ttlSeconds" in settings ? settings.ttlSeconds : undefined) as
      | number
      | undefined,
  };
}

export function resetNewChatProject(
  scope: string,
  personal: boolean,
  sectionId: string,
) {
  const key = `${personal ? "me" : "sessions"}:section:${sectionId}`;
  // A submitted start owns its frozen project and must remain recoverable.
  if (readPending(scope, key)) return;
  const selected = readView<unknown>(scope, `${key}:new-project`, sectionId);
  // Instructions belong to the previous project; name and lifetime stay.
  if (selected !== sectionId)
    writeView(scope, `${key}:settings`, {
      ...readDraftSettings(scope, key),
      canvas: undefined,
    });
  writeView(scope, `${key}:new-project`, null);
}

export function NewSessionComposer({
  session,
  scope,
  onStarted,
  parent,
  sectionId,
  extensions,
  personal = false,
  standalone = false,
  focusRequest = 0,
  resumeDraftKey,
}: {
  personal?: boolean;
  resumeDraftKey?: string | undefined;
  standalone?: boolean;
  focusRequest?: number | AbortSignal;
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  onStarted: (id: string) => void;
  parent?: ChannelSummary | undefined;
  sectionId?: string | undefined;
}) {
  const namespace = personal ? "me" : "sessions";
  const draftKey =
    resumeDraftKey ??
    (parent
      ? `sessions:channel:${parent.id}`
      : sectionId
        ? `${namespace}:section:${sectionId}`
        : namespace);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState(() => {
    const receipt = readPending(scope, draftKey);
    if (receipt?.invitationId) return receipt.agent ?? "";
    const saved = readView<unknown>(
      scope,
      `${draftKey}:new-agent`,
      receipt?.agent ?? "",
    );
    return typeof saved === "string" && /^[0-9a-f]{64}$/.test(saved)
      ? saved
      : "";
  });
  const [selectedProject, setSelectedProject] = useState(() => {
    const saved = readView<unknown>(
      scope,
      `${draftKey}:new-project`,
      sectionId ?? "",
    );
    return typeof saved === "string" ? saved : (sectionId ?? "");
  });
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const [draftSettings, setDraftSettings] = useState(() =>
    readDraftSettings(scope, draftKey),
  );
  const draftCanvas = draftSettings.canvas;
  // Project entry can reset this draft while the composer stays mounted.
  // Observe only changed revisions so unrelated writes don't discard local edits
  // when ordinary view persistence is unavailable.
  useEffect(() => {
    const projectKey = `${draftKey}:new-project`;
    const settingsKey = `${draftKey}:settings`;
    let projectRevision = viewRevision(scope, projectKey);
    let settingsRevision = viewRevision(scope, settingsKey);
    return subscribeView(scope, () => {
      const nextProject = viewRevision(scope, projectKey);
      const nextSettings = viewRevision(scope, settingsKey);
      if (nextProject !== undefined && nextProject !== projectRevision) {
        projectRevision = nextProject;
        const project = readView<unknown>(scope, projectKey, sectionId ?? "");
        setSelectedProject(
          typeof project === "string" ? project : (sectionId ?? ""),
        );
      }
      if (nextSettings !== undefined && nextSettings !== settingsRevision) {
        settingsRevision = nextSettings;
        setDraftSettings(readDraftSettings(scope, draftKey));
      }
    });
  }, [scope, draftKey, sectionId]);
  const prompt = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusRequest)
      prompt.current
        ?.querySelector<HTMLElement>('textarea, [contenteditable="true"]')
        ?.focus();
  }, [focusRequest]);
  const [pending, setPending] = useState(() => readPending(scope, draftKey));
  const available = pending?.messageId
    ? session.workSessions.available
    : personal
      ? session.workSessions.available && session.mePlacement.available
      : session.workSessions.available;
  const [channelId] = useState(() => pending?.id ?? crypto.randomUUID());
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const save = (next: PendingStart) => {
    if (!writeView(scope, `${draftKey}:pending`, next))
      throw new Error(
        "Your session start couldn’t be saved on this device. No further changes were sent.",
      );
    setPending(next);
  };
  async function start(draft: MentionDraft) {
    if (
      submitting.current ||
      !(pending?.text ?? draft.text).trim() ||
      !available
    )
      return;
    submitting.current = true;
    setBusy(true);
    setEditing(false);
    setError(undefined);
    const current: PendingStart = pending
      ? {
          ...pending,
          ...(!pending.messageId
            ? { text: composerMarkdown(draft), draft }
            : {}),
        }
      : {
          id: channelId,
          ttlSeconds: draftSettings.ttlSeconds,
          name:
            typeof draftSettings.name === "string"
              ? canonicalDetailsName(draftSettings.name) ||
                automaticTitle(composerMarkdown(draft))
              : draftSettings.name,
          text: composerMarkdown(draft),
          draft,
        };

    const mentions = mentionDraft(current.draft).recipients.map(
      (item) => item.pubkey,
    );
    if (personal && !current.messageId) {
      if (!mentions.length && selectedAgent) current.agent = selectedAgent;
      else delete current.agent;
    }
    let recipients = [
      ...new Set(
        mentions.length ? mentions : current.agent ? [current.agent] : [],
      ),
    ];
    try {
      if (current.name !== undefined && typeof current.name !== "string")
        throw new Error("The saved session name could not be verified.");
      // Receipts from before optional naming have no frozen title.
      if (!current.name)
        current.name = automaticTitle(pending?.text ?? current.text);
      const errors = detailsDraftErrors({
        name: current.name ?? "Session",
        description: "",
        visibility: "private",
        ttlSeconds: current.ttlSeconds,
      });
      if (current.name !== undefined && errors.name)
        throw new Error(errors.name);
      const lifetimeError = errors.lifetime;
      if (lifetimeError || (parent && current.ttlSeconds !== undefined))
        throw new Error(
          lifetimeError ?? "Parent-linked sessions cannot set a lifetime.",
        );
      save(current); // Freeze validated name and lifetime before the first asynchronous start operation.
      if (current.setup !== undefined) {
        current.setup = parseSessionSetup(current.setup);
        if (
          current.setup.sectionId &&
          current.setup.sectionId !== selectedProject
        )
          throw new Error(
            "The saved session belongs to a different section. Reopen its original section to retry.",
          );
      }
      if (selectedProject && !current.setup && !current.creationId) {
        current.setup = await loadSessionSetup(
          session,
          selectedProject,
          personal,
        );
        if (!mounted.current) return;
      }
      if (!current.setup && !current.creationId && draftCanvas !== undefined) {
        current.setup = parseSessionSetup({
          ...(selectedProject ? { sectionId: selectedProject } : {}),
          canvas: draftCanvas,
          agents: [],
        });
      } else if (
        current.setup &&
        !current.creationId &&
        !pending?.setup &&
        draftCanvas !== undefined
      ) {
        current.setup = parseSessionSetup({
          ...current.setup,
          canvas: draftCanvas,
        });
      }
      save(current);
      if (personal && !current.messageId) {
        await session.agentChoices.refresh();
        if (!mounted.current) return;
        if (
          [...recipients, ...(current.setup?.agents ?? [])].some(
            (key) =>
              !session.agentChoices
                .snapshot()
                .selectable.some((agent) => agent.pubkey === key),
          )
        )
          throw new Error(
            "Solo chats can only use your available agents. Check mentions and section defaults.",
          );
      }
      if (parent && !current.messageId && recipients.length) {
        await session.agentChoices.refresh();
        if (!mounted.current) return;
        await session.workSessions.addAgents(
          parent.id,
          recipients,
          () => mounted.current,
        );
        if (!mounted.current) return;
      }
      if (!current.creationId) {
        if (personal) {
          await session.mePlacement.admit(current.id, {
            sectionId: current.setup?.sectionId,
          });
          if (!mounted.current) return;
        }
        current.creationId = session.workSessions.create(
          current.id,
          current.name,
          parent?.id,
          current.ttlSeconds,
          personal,
        );
        save({ ...current });
      }
      await session.workSessions.delivered(current.creationId);
      if (!mounted.current) return;
      await session.workSessions.refresh(
        current.id,
        parent ? { parent: parent.id } : undefined,
      );
      if (!mounted.current) return;
      if (personal && !current.messageId) {
        if (!current.placementDone) {
          await session.mePlacement.set(current.id, true, {
            sectionId: current.setup?.sectionId,
          });
          if (!mounted.current) return;
          current.placementDone = true;
          save({ ...current });
        } else {
          await session.mePlacement.refresh();
          if (!mounted.current) return;
          if (!session.mePlacement.has(current.id))
            throw new Error(
              "This conversation was moved out of Solo. Review its placement before retrying.",
            );
        }
      }
      if (current.setup && !current.setupDone && !current.messageId) {
        await applySessionSetup(
          session,
          current.id,
          current.setup,
          () => mounted.current,
          personal,
        );
        if (!mounted.current) return;
        current.setupDone = true;
        save({ ...current });
      }
      if (parent && !current.messageId) {
        await session.workSessions.addAgents(
          current.id,
          recipients,
          () => mounted.current,
        );
        if (!mounted.current) return;
      }
      if (!current.messageId && current.agent && !parent && !mentions.length) {
        if (!current.invitationId) {
          current.invitationId = session.workSessions.invite(
            current.id,
            current.agent,
          );
          save({ ...current });
        }
        await session.workSessions.delivered(current.invitationId);
        if (!mounted.current) return;
        await session.workSessions.refresh(current.id, {
          member: current.agent,
        });
        if (!mounted.current) return;
      }
      if (!current.messageId) {
        if (!parent && mentions.length) {
          await session.workSessions.addAgents(
            current.id,
            recipients,
            () => mounted.current,
          );
          if (!mounted.current) return;
        }
        if (!personal && !recipients.length) {
          const channel = session.channels
            .list()
            .channels.find((item) => item.id === current.id);
          if (!channel?.members)
            throw new Error("Refresh session participants before sending.");
          await Promise.all([
            session.profiles.ensure(channel.members, "background"),
            session.agentChoices.snapshot().status === "ready"
              ? Promise.resolve()
              : session.agentChoices.refresh(),
          ]);
          if (!mounted.current) return;
          recipients = [
            ...sessionRecipients(
              session.channels
                .list()
                .channels.find((item) => item.id === current.id),
              session.profiles.snapshot(),
              session.agentChoices.snapshot(),
              session.viewer,
              recipients,
            ),
          ];
        }
        if (personal) {
          if (!session.mePlacement.has(current.id))
            throw new Error(
              "This conversation is no longer in Solo. Open it in Multiplayer.",
            );
        }
        current.messageId = session.messages.send(
          current.id,
          current.text,
          recipients,
        );
        save({ ...current });
      }
      await session.workSessions.delivered(current.messageId);
      if (!mounted.current) return;
      writeView(scope, `${draftKey}:pending`, null);
      writeView(scope, `${draftKey}:settings`, null);
      writeView(scope, `${draftKey}:new-draft`, "");
      writeView(scope, `${draftKey}:new-agent`, "");
      writeView(scope, `${draftKey}:new-project`, null);
      writeSelectedAssistant(scope, current.id, selectedAgent);
      setPending(undefined);
      onStarted(current.id);
    } catch (reason) {
      if (!current.messageId && mounted.current) setEditing(true);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const failedId =
    pending &&
    [pending.messageId, pending.invitationId, pending.creationId].find(
      (id) => id && session.workSessions.failed(id),
    );
  async function editFailed() {
    if (!pending || !failedId || busy) return;
    setBusy(true);
    try {
      await session.workSessions.discardFailed(failedId);
      if (failedId === pending.creationId) {
        writeView(scope, `${draftKey}:pending`, null);
        setPending(undefined);
      } else {
        const next = { ...pending };
        if (failedId === next.invitationId) {
          delete next.invitationId;
          delete next.agent;
          setSelectedAgent("");
          writeView(scope, `${draftKey}:new-agent`, "");
        } else delete next.messageId;
        save(next);
      }
      setEditing(true);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  const composer = (
    <div id="new-session-prompt" ref={prompt}>
      <MessageComposer
        chatPresentation={personal}
        personalConversation={personal}
        session={session}
        extensions={extensions}
        scope={scope}
        channelId={parent?.id ?? channelId}
        channelName={parent?.name ?? "this session"}
        label={personal ? "Message your agents" : "Message this session"}
        inviteAgents
        selectedAgent={personal ? selectedAgent : undefined}
        trailingTool={
          personal ? (
            <>
              <AgentChoice
                session={session}
                value={selectedAgent}
                onChange={(agent) => {
                  setSelectedAgent(agent);
                  writeView(scope, `${draftKey}:new-agent`, agent);
                }}
                disabled={
                  busy || !!pending?.invitationId || !!pending?.messageId
                }
                emptyLabel="Choose follow-up assistant"
                clearLabel="No assistant"
              />
              {session.mePreferences && (
                <SessionProjectControl
                  session={session}
                  value={selectedProject}
                  onChange={(project) => {
                    if (project === selectedProject) return;
                    setSelectedProject(project);
                    writeView(scope, `${draftKey}:new-project`, project);
                    const next = {
                      name: draftSettings.name,
                      ttlSeconds: draftSettings.ttlSeconds,
                      canvas: undefined,
                    };
                    setDraftSettings(next);
                    writeView(scope, `${draftKey}:settings`, next);
                  }}
                  disabled={busy || !!pending}
                />
              )}
            </>
          ) : undefined
        }
        submission={{
          draftKey: `${draftKey}:new-draft`,
          initialDraft: pending?.draft ?? pending?.text,
          receiptOnly: !!pending?.messageId,
          locked: busy || (!!pending && !editing),
          disabled: busy || !available,
          submit: (draft) => {
            void start(draft);
          },
        }}
      />
      {!available && (
        <p className={styles.availability} role="status">
          {personal
            ? "Solo preferences or channel creation are unavailable. Your draft is saved."
            : "This connection can’t send messages. Your draft is saved."}
        </p>
      )}
      {pending?.agent && (
        <p className={styles.availability}>
          Recovering an earlier send with a saved agent recipient.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {error === removedSectionMessage &&
        pending?.setup?.sectionId &&
        !pending.setupDone &&
        !pending.messageId && (
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              try {
                if (!pending.setup) return;
                const { sectionId: _sectionId, ...setup } = pending.setup;
                save({ ...pending, setup });
                setError(undefined);
                setEditing(true);
              } catch (reason) {
                setError(
                  reason instanceof Error ? reason.message : String(reason),
                );
              }
            }}
          >
            Continue without section
          </Button>
        )}
      {error && failedId && (
        <Button type="button" disabled={busy} onClick={() => void editFailed()}>
          Edit and retry
        </Button>
      )}
    </div>
  );
  if (!standalone) return composer;
  return (
    <NewSessionView
      personal={personal}
      actions={
        <IconButton
          ref={settingsTrigger}
          size="toolbar"
          aria-label="Session settings"
          title="Session settings"
          icon={<GearIcon size="1rem" aria-hidden="true" />}
          disabled={busy || !!pending}
          onClick={() => setSettingsOpen(true)}
        />
      }
    >
      {composer}
      {settingsOpen && (
        <DraftSessionSettings
          finalFocus={settingsTrigger}
          personal={personal}
          session={session}
          sectionId={selectedProject || undefined}
          canvas={draftCanvas}
          name={draftSettings.name}
          ttlSeconds={draftSettings.ttlSeconds}
          parentLinked={!!parent}
          close={() => setSettingsOpen(false)}
          save={(canvas, ttlSeconds, name) => {
            const next = { canvas, ttlSeconds, name: name ?? "" };
            if (!writeView(scope, `${draftKey}:settings`, next))
              throw new Error(
                "Settings couldn’t be saved on this device. Try again.",
              );
            setDraftSettings(next);
          }}
        />
      )}
    </NewSessionView>
  );
}

function automaticTitle(text: string) {
  return (
    canonicalDetailsName(
      [...text.trim().replace(/\s+/g, " ")].slice(0, 80).join(""),
    ) || "Session"
  );
}
