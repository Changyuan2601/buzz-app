import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import { avatarMedia } from "../../shared/avatar-source";
import { useEffect, useRef, useState } from "react";
import { useChannelList, useChannelWindow } from "../relay/react";
import type { ChannelSummary } from "../relay/contracts";
import {
  ConversationChannel,
  ConversationTimeline,
} from "../conversation/Conversation";
import type { ConversationHostServices } from "../conversation/ConversationHost";
import type { RelaySession } from "../relay/session";
import type { ConversationExtensions } from "../conversation/contracts";
import type { ChannelCreationInput } from "../channel-templates/setup";
import {
  addChannelMember,
  type MemberAdditionIntent,
} from "../channel-members/members";
import { RecipientPicker } from "../direct-messages/RecipientPicker";
import type { Recipient } from "../direct-messages/usePeople";
import { MessageComposer } from "../messages/MessageComposer";
import { DraftMentionRoster } from "../messages/draft-mention-roster";
import { composerMarkdown } from "../messages/composer-markdown";
import type { MentionDraft } from "../messages/mention-draft";
import type { AttachmentDraft } from "../messages/attachment-draft";
import { WorkspaceControl } from "../solo/WorkspaceControl";
import { loadChatSetup } from "../solo/workspace";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { Button } from "../../shared/design-system/ui/Button";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuIcon,
} from "../../shared/design-system/ui/Menu";
import {
  LockIcon,
  GlobeIcon,
  CaretDownIcon,
} from "../../shared/design-system/icons";
import { writeView } from "../../shared/view-state";
import styles from "./NewChatDraft.module.css";

const draftKey = "chat-creation:inline-draft";
/** First send freezes creation and invite intent; retries reuse the same chat. */
export function NewChatDraft({
  session,
  scope,
  extensions,
  onStarted,
  host,
}: {
  session: RelaySession;
  scope: string;
  extensions?: ConversationExtensions | undefined;
  onStarted(id: string): void;
  host?: ConversationHostServices | undefined;
}) {
  const [visibility, setVisibility] = useState<"private" | "open">("private");
  const [visibilityOpen, setVisibilityOpen] = useState(false);
  const [project, setProject] = useState("");
  const [people, setPeople] = useState<Recipient[]>([]);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [draftChannel] = useState(() => crypto.randomUUID());
  const lifetime = useRef<AbortController | null>(null);
  const running = useRef(false);
  const attempt = useRef<{
    input: ChannelCreationInput;
    projectId?: string;
    placed?: boolean;
    members: Map<string, MemberAdditionIntent>;
    draft: MentionDraft;
    files: AttachmentDraft;
    id?: string;
  }>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      session.channelCreation.forget();
    };
  }, [session]);
  async function send(draft: MentionDraft, files: AttachmentDraft) {
    if (running.current || !lifetime.current || !composerMarkdown(draft).trim())
      return;
    const signal = lifetime.current.signal;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      if (!attempt.current) {
        const setup =
          project && !existing
            ? await loadChatSetup(session, project)
            : undefined;
        signal.throwIfAborted();
        const canvas = setup?.canvas ?? "";
        attempt.current = {
          ...(project && !existing ? { projectId: project } : {}),
          ...(existing ? { id: existing.id } : {}),
          input: {
            name: "New chat",
            visibility,
            ...(canvas
              ? { setup: { canvas, agents: [], groupId: "", templateId: "" } }
              : {}),
          },
          members: new Map(
            (existing
              ? []
              : [
                  ...(setup?.agents ?? []),
                  ...people.map((person) => person.pubkey),
                  ...draft.recipients.map((person) => person.pubkey),
                ]
            ).map((pubkey) => [pubkey, {}]),
          ),
          draft,
          files,
        };
      }
      setSubmitted(true);
      const current = attempt.current;
      const uploaded = await current.files.prepareForSend(signal);
      signal.throwIfAborted();
      current.id ??= await session.channelCreation.create(current.input);
      signal.throwIfAborted();
      if (current.projectId && !current.placed) {
        await session.soloPreferences.assign(current.id, current.projectId);
        current.placed = true;
        signal.throwIfAborted();
      }
      for (const [pubkey, intent] of current.members) {
        if (!intent.confirmed)
          await addChannelMember(session, current.id, pubkey, signal, intent);
      }
      signal.throwIfAborted();
      session.messages.send(
        current.id,
        composerMarkdown(current.draft),
        current.draft.recipients.map((person) => person.pubkey),
        uploaded,
      );
      current.files.clear();
      writeView(scope, draftKey, "");
      onStarted(current.id);
    } catch (reason) {
      if (!signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not start the chat. Try again.",
        );
    } finally {
      running.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }
  const { channels } = useChannelList(session.channels);
  const members = new Set([
    session.viewer,
    ...people.map((person) => person.pubkey),
  ]);
  const existing =
    visibility === "private" && people.length > 0
      ? channels
          .filter(
            (channel) =>
              !channel.archived &&
              !channel.cached &&
              !channel.readOnly &&
              !channel.pending &&
              !channel.huddle &&
              channel.channelType !== "system" &&
              (channel.visibility === "private" ||
                channel.private ||
                channel.channelType === "dm") &&
              channel.members?.length === members.size &&
              channel.members.every((member) => members.has(member)),
          )
          .sort(
            (a, b) =>
              (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) ||
              a.id.localeCompare(b.id),
          )[0]
      : undefined;
  const disabled = busy || submitted;
  const visibilityControl = (
    <div className={styles.visibility}>
      <MenuRoot open={visibilityOpen} onOpenChange={setVisibilityOpen}>
        <MenuTrigger
          render={
            <Button
              size="xs"
              variant="subtle"
              disabled={disabled}
              aria-label={`Chat visibility: ${visibility === "private" ? "Private" : "Public"}`}
            >
              {visibility === "private" ? (
                <LockIcon size={16} />
              ) : (
                <GlobeIcon size={16} />
              )}
              {visibility === "private" ? "Private" : "Public"}
              <CaretDownIcon size={16} />
            </Button>
          }
        />
        <MenuPopup align="end" size="compact">
          <MenuRadioGroup
            value={visibility}
            onValueChange={(value) => {
              if (!disabled && (value === "private" || value === "open"))
                setVisibility(value);
              setVisibilityOpen(false);
            }}
          >
            <MenuRadioItem value="private">
              <MenuIcon>
                <LockIcon size={16} />
              </MenuIcon>
              Private
            </MenuRadioItem>
            <MenuRadioItem value="open">
              <MenuIcon>
                <GlobeIcon size={16} />
              </MenuIcon>
              Public
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuPopup>
      </MenuRoot>
    </div>
  );
  return (
    <section
      className={styles.page}
      aria-label="New chat"
      data-attachment-drop-zone=""
    >
      <PanelHeader
        actions={visibilityControl}
        title={
          <RecipientPicker
            session={session}
            scope={scope}
            selected={people}
            onChange={setPeople}
            disabled={disabled}
            layout="panel"
          />
        }
      />
      <div className={styles.body}>
        {!existing && people.length > 0 && (
          <div className={styles.introduction}>
            <AvatarStack
              animateEntrance
              size="hero-large"
              max={5}
              items={people.map((person) => ({
                id: person.pubkey,
                name: person.name,
                src: avatarMedia(person.picture, session.media),
                shape: person.isAgent ? "squircle" : "circle",
              }))}
            />
          </div>
        )}
        {existing && (
          <ExistingDiscussion
            key={existing.id}
            session={session}
            scope={scope}
            channel={existing}
            extensions={extensions}
            host={host}
            onOpen={() => onStarted(existing.id)}
          />
        )}
        <div className={styles.composer}>
          {error && (
            <div role="alert">
              <p>{error}</p>
              <Button
                disabled={busy}
                onClick={() => {
                  const current = attempt.current;
                  if (current) void send(current.draft, current.files);
                }}
              >
                Retry send
              </Button>
            </div>
          )}
          <DraftMentionRoster.Provider value={people}>
            <MessageComposer
              session={session}
              scope={scope}
              extensions={extensions}
              channelId={draftChannel}
              channelName={existing?.name ?? "new chat"}
              label="Message your new chat"
              placeholder={
                existing ? "Write a message…" : "Write the first message…"
              }
              trailingTool={
                existing ? undefined : (
                  <WorkspaceControl
                    session={session}
                    value={project}
                    onChange={setProject}
                    disabled={disabled}
                  />
                )
              }
              submission={{
                draftKey,
                locked: disabled,
                disabled:
                  disabled || (!existing && !session.channelCreation.available),
                attachments: true,
                submit: (draft, files) => {
                  void send(draft, files);
                },
              }}
            />
          </DraftMentionRoster.Provider>
        </div>
      </div>
    </section>
  );
}

/** The normal history renderer owns loading, paging and message interactions. */
function ExistingDiscussion({
  session,
  scope,
  channel,
  extensions,
  host,
  onOpen,
}: {
  session: RelaySession;
  scope: string;
  channel: ChannelSummary;
  extensions?: ConversationExtensions | undefined;
  host?: ConversationHostServices | undefined;
  onOpen(): void;
}) {
  const window = useChannelWindow(session.channels, channel.id);
  return (
    <div className={styles.history}>
      <ConversationChannel
        session={session}
        scope={scope}
        channel={channel}
        extensions={extensions}
        active={false}
        {...(host
          ? { host }
          : {
              interactions: {
                onOpenLink: () => false,
                canOpenLink: () => false,
                onOpenMediaReview: () => {},
              },
            })}
      >
        <ConversationTimeline
          window={window}
          transient
          marksRead={false}
          onOpenThread={onOpen}
        />
      </ConversationChannel>
    </div>
  );
}
