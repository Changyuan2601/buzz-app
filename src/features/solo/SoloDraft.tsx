import {
  canonicalDetailsName,
  detailsDraftErrors,
} from "../relay/channel-details-protocol";
import { startingChatTitle } from "./chat-title";
import { DraftSettings } from "./DraftSettings";
import { SoloDraftView } from "./SoloPresentation";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { GearIcon } from "../../shared/design-system/icons";
import { applyChatSetup, loadChatSetup, parseChatSetup } from "./workspace";
import { useEffect, useRef, useState } from "react";
import type { RelaySession } from "../relay/session";
import {
  readView,
  writeView,
  replaceView,
  subscribeView,
  viewRevision,
} from "../../shared/view-state";
import { MessageComposer } from "../messages/MessageComposer";
import { useDefaultAgent } from "./default-agent";
import { WorkspaceControl } from "./WorkspaceControl";
import { rememberedMentions } from "../messages/remembered-mentions";
import { composerMarkdown } from "../messages/composer-markdown";
import { ownSolo } from "./labels";
import { mentionDraft, type MentionDraft } from "../messages/mention-draft";
import type { ComposerInputElement } from "../messages/composer-dom";
import {
  attachmentDraft,
  transferAttachmentDraft,
  type AttachmentDraft,
} from "../messages/attachment-draft";
import type { ConversationExtensions } from "../conversation/contracts";
import styles from "./Solo.module.css";

/** Starting a new chat from a project starts it in that project, even when an
 * earlier draft there was switched to another one. */
function readDraftSettings(scope: string, draftKey: string) {
  const saved = readView<unknown>(scope, `${draftKey}:settings`, null);
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

export function resetNewChatProject(scope: string, projectId: string) {
  const key = `solo:project:${projectId}`;
  const selected = readView<unknown>(scope, `${key}:new-project`, projectId);
  // Instructions belong to the previous project; name and lifetime stay.
  if (selected !== projectId)
    writeView(scope, `${key}:settings`, {
      ...readDraftSettings(scope, key),
      canvas: undefined,
    });
  writeView(scope, `${key}:new-project`, null);
}

/** New chats share one saved draft. When it holds only a tag for an agent
 * other than the named one, it has no text of the person's to keep. */
function dropOtherAgentTag(scope: string, key: string, agent?: string) {
  if (!agent) return;
  const saved = mentionDraft(readView<unknown>(scope, key, ""));
  const [only, ...more] = saved.recipients;
  if (
    only &&
    !more.length &&
    only.pubkey !== agent &&
    !saved.sessionCards?.length &&
    saved.text.trim() === `@${only.name}`
  )
    writeView(scope, key, null);
}

export function SoloDraft({
  session,
  scope,
  onStarted,
  projectId,
  extensions,
  focusRequest = 0,
  agent,
}: {
  /** Start with this agent chosen, as when search opens a new chat with it. */
  agent?: string | undefined;
  focusRequest?: number | AbortSignal;
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  onStarted: (id: string) => void;
  projectId?: string | undefined;
}) {
  const draftKey = projectId ? `solo:project:${projectId}` : "solo";
  // Before the composer reads it: a named agent replaces a saved draft that
  // only tags another agent, since that tag was the earlier default.
  useState(() => dropOtherAgentTag(scope, `${draftKey}:new-draft`, agent));
  const [settingsOpen, setSettingsOpen] = useState(false);
  // New chats tag their agent in the draft: the one the route names, else the
  // default.
  const defaultAgent = useDefaultAgent(session, scope, agent);
  const [selectedProject, setSelectedProject] = useState(() => {
    const saved = readView<unknown>(
      scope,
      `${draftKey}:new-project`,
      projectId ?? "",
    );
    return typeof saved === "string" ? saved : (projectId ?? "");
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
        const project = readView<unknown>(scope, projectKey, projectId ?? "");
        setSelectedProject(
          typeof project === "string" ? project : (projectId ?? ""),
        );
      }
      if (nextSettings !== undefined && nextSettings !== settingsRevision) {
        settingsRevision = nextSettings;
        setDraftSettings(readDraftSettings(scope, draftKey));
      }
    });
  }, [scope, draftKey, projectId]);
  const prompt = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusRequest) return;
    const input = prompt.current?.querySelector<
      HTMLTextAreaElement | ComposerInputElement
    >('textarea, [contenteditable="true"]');
    input?.focus();
    // A returning draft resumes at its end, not before its first tag.
    input?.setSelectionRange(input.value.length, input.value.length);
  }, [focusRequest]);
  const available = session.channelWrites.available;
  const [channelId] = useState(() => crypto.randomUUID());
  // A retry in this view confirms the channel it already requested instead of
  // creating another. Nothing about a start is saved: once the chat exists,
  // its ordinary composer draft holds anything not yet sent.
  const creation = useRef<string>(undefined);
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
  async function start(draft: MentionDraft, files: AttachmentDraft) {
    const text = composerMarkdown(draft);
    if (submitting.current || !text.trim() || !available) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    const recipients = [
      ...new Set(mentionDraft(draft).recipients.map((item) => item.pubkey)),
    ];
    const named =
      typeof draftSettings.name === "string" &&
      !!canonicalDetailsName(draftSettings.name);
    const name =
      typeof draftSettings.name === "string"
        ? canonicalDetailsName(draftSettings.name) || startingChatTitle(draft)
        : draftSettings.name;
    const { ttlSeconds } = draftSettings;
    let opened = false;
    try {
      if (typeof name !== "string")
        throw new Error("The chat name could not be verified.");
      const errors = detailsDraftErrors({
        name,
        description: "",
        visibility: "private",
        ttlSeconds,
      });
      if (errors.name) throw new Error(errors.name);
      if (errors.lifetime) throw new Error(errors.lifetime);
      let setup = selectedProject
        ? await loadChatSetup(session, selectedProject)
        : undefined;
      if (!mounted.current) return;
      if (draftCanvas !== undefined)
        setup = parseChatSetup({
          ...(setup ?? {
            ...(selectedProject ? { projectId: selectedProject } : {}),
            agents: [],
          }),
          canvas: draftCanvas,
        });
      await session.agentChoices.refresh();
      if (!mounted.current) return;
      if (
        [...recipients, ...(setup?.agents ?? [])].some(
          (key) =>
            !session.agentChoices
              .snapshot()
              .selectable.some((agent) => agent.pubkey === key),
        )
      )
        throw new Error(
          "Solo chats can only use your available agents. Check mentions and workspace defaults.",
        );
      // Finish uploads before anything is created, so a failed file blocks
      // the start instead of leaving an empty chat behind.
      const uploaded = await files.prepareForSend(new AbortController().signal);
      if (!mounted.current) return;
      creation.current ??= session.channelWrites.create(
        channelId,
        name,
        ttlSeconds,
        named,
      );
      // Once requested, the chat finishes starting even if this view closes.
      await session.channelWrites.delivered(creation.current);
      await session.channelWrites.refresh(channelId);
      // The chat exists. From here its own composer keeps the text, so an
      // interruption leaves an ordinary chat to send from.
      if (replaceView(scope, `draft:${channelId}`, null, draft) === "failed")
        throw new Error(
          "Your message couldn’t be saved on this device. Retry to finish opening the chat.",
        );
      opened = true;
      // Its composer keeps the uploaded files too, until they are sent.
      const chatFiles = attachmentDraft(
        session,
        `${scope}:draft:${channelId}`,
        channelId,
      );
      if (uploaded.length) transferAttachmentDraft(files, chatFiles);
      writeView(scope, `${draftKey}:settings`, null);
      writeView(scope, `${draftKey}:new-draft`, "");
      writeView(scope, `${draftKey}:new-project`, null);
      if (setup) {
        try {
          await applyChatSetup(session, channelId, setup, () => true);
        } catch (reason) {
          // Missing project setup leaves a working chat; never hold the message.
          console.warn("Solo project setup did not finish", reason);
        }
      }
      await session.channelWrites.addAgents(channelId, recipients, () => true);
      const created = session.channels
        .list()
        .channels.find((item) => item.id === channelId);
      if (!ownSolo(created, session.viewer))
        throw new Error(
          "This conversation is no longer in Solo. Open it in Team.",
        );
      session.messages.send(
        channelId,
        text,
        recipients,
        ...(uploaded.length ? [uploaded] : []),
      );
      chatFiles.clear();
      writeView(
        scope,
        `draft:${channelId}`,
        rememberedMentions(session, draft, recipients),
      );
      if (mounted.current) onStarted(channelId);
    } catch (reason) {
      if (!mounted.current) return;
      // The chat exists with the text in its composer; finish sending there.
      if (opened) {
        onStarted(channelId);
        return;
      }
      // A rejected creation made no chat: drop it so a retry requests anew.
      const failed = creation.current;
      if (failed && session.channelWrites.failed(failed)) {
        creation.current = undefined;
        await session.channelWrites.discardFailed(failed).catch(() => {});
      }
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const composer = (
    <div id="new-session-prompt" ref={prompt}>
      <MessageComposer
        chatPresentation
        ownSoloConversation
        session={session}
        extensions={extensions}
        scope={scope}
        channelId={channelId}
        channelName="this chat"
        label="Message your agents"
        inviteAgents
        defaultMention={defaultAgent}
        requireMention
        trailingTool={
          session.soloPreferences ? (
            <WorkspaceControl
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
              disabled={busy}
            />
          ) : undefined
        }
        submission={{
          draftKey: `${draftKey}:new-draft`,
          locked: busy,
          disabled: busy || !available,
          attachments: true,
          submit: (draft, files) => {
            void start(draft, files);
          },
        }}
      />
      {!available && (
        <p className={styles.availability} role="status">
          Solo preferences or channel creation are unavailable. Your draft is
          saved.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
  return (
    <SoloDraftView
      actions={
        <IconButton
          ref={settingsTrigger}
          size="toolbar"
          aria-label="Chat settings"
          title="Chat settings"
          icon={<GearIcon size="1rem" aria-hidden="true" />}
          disabled={busy}
          onClick={() => setSettingsOpen(true)}
        />
      }
    >
      {composer}
      {settingsOpen && (
        <DraftSettings
          finalFocus={settingsTrigger}
          session={session}
          projectId={selectedProject || undefined}
          canvas={draftCanvas}
          name={draftSettings.name}
          ttlSeconds={draftSettings.ttlSeconds}
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
    </SoloDraftView>
  );
}
