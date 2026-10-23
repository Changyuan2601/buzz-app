import { MessageMarkdown } from "../messages/MessageMarkdown";
import { useReferenceDirectory } from "../messages/ReferenceText";
import type { ChannelMessage, Profile } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { ConversationExtensions } from "./contracts";

export type MessageTextProps = {
  row: ChannelMessage;
  session?: RelaySession | undefined;
  scope?: string | undefined;
  media(url: string): string | undefined;
  participantProfiles?: ReadonlyMap<string, Profile> | undefined;
};

/** A message's body as the host renders it (Markdown, mentions, custom
 * emoji, inline renderers), without the row around it. It is read-only:
 * links and mentions show but do not open. The caller owns its layout. */
export function MessageText({
  extensions,
  session,
  participantProfiles,
  ...props
}: MessageTextProps & { extensions: ConversationExtensions }) {
  const directory = useReferenceDirectory(session, participantProfiles);
  return (
    <MessageMarkdown
      {...props}
      session={session}
      participantProfiles={participantProfiles}
      directory={directory}
      extensions={extensions}
      onOpenLink={() => false}
      interactive={false}
      staticMentions
    />
  );
}
