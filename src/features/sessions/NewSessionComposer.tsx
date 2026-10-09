import { readPending, type PendingStart } from "./pending-start";
import { DraftSessionSettings } from "./DraftSessionSettings";
import { NewSessionView } from "./SessionPresentation";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { DotsThreeIcon, GearIcon } from "../../shared/design-system/icons";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
} from "../../shared/design-system/ui/Menu";
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
import { readView, writeView } from "../../shared/view-state";
import { MessageComposer } from "../messages/MessageComposer";
import { composerMarkdown } from "../messages/composer-markdown";
import { mentionDraft, type MentionDraft } from "../messages/mention-draft";
import type { ConversationExtensions } from "../conversation/contracts";
import { AgentChoice } from "./AgentChoice";
import { sessionRecipients } from "./recipients";
import styles from "./Sessions.module.css";

export function NewSessionComposer({
  session,
  scope,
  onStarted,
  parent,
  sectionId,
  extensions,
  standalone = false,
  focusRequest = 0,
  resumeDraftKey,
}: {
  resumeDraftKey?: string | undefined;
  standalone?: boolean;
  focusRequest?: number;
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  onStarted: (id: string) => void;
  parent?: ChannelSummary | undefined;
  sectionId?: string | undefined;
}) {
  const available = session.workSessions.available;
  const draftKey =
    resumeDraftKey ??
    (parent
      ? `sessions:channel:${parent.id}`
      : sectionId
        ? `sessions:section:${sectionId}`
        : "sessions");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftCanvas, setDraftCanvas] = useState<string | undefined>(() => {
    const saved = readView<unknown>(scope, `${draftKey}:settings`, null);
    return typeof saved === "string" ? saved : undefined;
  });
  const prompt = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusRequest)
      prompt.current
        ?.querySelector<HTMLElement>('textarea, [contenteditable="true"]')
        ?.focus();
  }, [focusRequest]);
  const [pending, setPending] = useState(() => readPending(scope, draftKey));
  const [agent, setAgent] = useState(() => {
    const saved = readView<unknown>(scope, `${draftKey}:new-agent`, "");
    return (
      pending?.agent ??
      (typeof saved === "string" && /^[0-9a-f]{64}$/.test(saved) ? saved : "")
    );
  });
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
          text: composerMarkdown(draft),
          draft,
          ...(agent ? { agent } : {}),
        };

    const mentions = mentionDraft(current.draft).recipients.map(
      (item) => item.pubkey,
    );
    let recipients = [
      ...new Set(
        mentions.length ? mentions : current.agent ? [current.agent] : [],
      ),
    ];
    try {
      if (current.setup !== undefined) {
        current.setup = parseSessionSetup(current.setup);
        if (current.setup.sectionId && current.setup.sectionId !== sectionId)
          throw new Error(
            "The saved session belongs to a different section. Reopen its original section to retry.",
          );
      }
      if (sectionId && !current.setup && !current.creationId) {
        current.setup = await loadSessionSetup(session, sectionId);
        if (!mounted.current) return;
      }
      if (!current.setup && !current.creationId && draftCanvas !== undefined) {
        current.setup = parseSessionSetup({
          ...(sectionId ? { sectionId } : {}),
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
        current.creationId = session.workSessions.create(
          current.id,
          [...current.text.trim().replace(/\s+/g, " ")].slice(0, 80).join(""),
          parent?.id,
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
      if (current.setup && !current.setupDone && !current.messageId) {
        await applySessionSetup(
          session,
          current.id,
          current.setup,
          () => mounted.current,
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
        if (!recipients.length) {
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
      setAgent("");
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
          setAgent("");
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
      {sectionId && (
        <p className={styles.availability}>
          New session in{" "}
          {session.sidebarPreferences
            .snapshot()
            .data?.sections.find((section) => section.id === sectionId)?.name ??
            "this section"}
        </p>
      )}
      <MessageComposer
        trailingTool={
          <AgentChoice
            session={session}
            value={pending?.agent ?? agent}
            allowed={parent ? (parent.members ?? []) : undefined}
            parentName={parent?.name}
            disabled={
              busy ||
              (!!pending &&
                (!editing || !!pending.invitationId || !!pending.messageId))
            }
            onChange={(value) => {
              setAgent(value);
              writeView(scope, `${draftKey}:new-agent`, value);
              if (pending) {
                const next = { ...pending };
                if (value) next.agent = value;
                else delete next.agent;
                save(next);
              }
              setError(undefined);
            }}
          />
        }
        session={session}
        extensions={extensions}
        scope={scope}
        channelId={parent?.id ?? channelId}
        channelName={parent?.name ?? "this session"}
        label="Message this session"
        inviteAgents
        submission={{
          draftKey: `${draftKey}:new-draft`,
          initialDraft: pending?.draft ?? pending?.text,
          locked: busy || (!!pending && !editing),
          disabled: busy || !available,
          submit: (draft) => {
            void start(draft);
          },
        }}
      />
      {!available && (
        <p className={styles.availability} role="status">
          This connection can’t send messages. Your draft is saved.
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
      actions={
        <MenuRoot>
          <MenuTrigger
            render={(props) => (
              <IconButton
                {...props}
                size="toolbar"
                aria-label="Session actions"
                title="Session actions"
                icon={<DotsThreeIcon size="1rem" />}
              />
            )}
          />
          <MenuPopup aria-label="Session actions" align="end">
            <MenuItem
              disabled={busy || !!pending}
              onClick={() => setSettingsOpen(true)}
            >
              <MenuIcon>
                <GearIcon size={16} />
              </MenuIcon>
              Session settings…
            </MenuItem>
          </MenuPopup>
        </MenuRoot>
      }
    >
      {composer}
      {settingsOpen && (
        <DraftSessionSettings
          session={session}
          sectionId={sectionId}
          canvas={draftCanvas}
          close={() => setSettingsOpen(false)}
          save={(canvas) => {
            if (!writeView(scope, `${draftKey}:settings`, canvas))
              throw new Error(
                "Settings couldn’t be saved on this device. Try again.",
              );
            setDraftCanvas(canvas);
          }}
        />
      )}
    </NewSessionView>
  );
}
