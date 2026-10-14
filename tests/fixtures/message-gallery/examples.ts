import { eventDto } from "../../../src/features/relay/events";
import { foldMessages } from "../../../src/features/relay/fold";
import { keypair, signed } from "../../../src/features/relay/testing";
import type {
  ChannelMessage,
  Profile,
} from "../../../src/features/relay/contracts";
import type { TimelineRow } from "../../../src/features/messages/membership-rows";
import video from "./assets/sample.mp4";
import avatar from "../design-system/assets/avatar.png";
import animatedGif from "../attachment-media/animated.gif";

export const reader = "a".repeat(64);
export const teammate = "b".repeat(64);
export const agent = "c".repeat(64);
const workflowRelay = keypair();
const workflowOwner = keypair();
const missingWorkflowOwner = keypair();
export const profiles = new Map<string, Profile>([
  [workflowOwner.pubkey, { name: "Wes" }],
  [reader, { name: "Alex Morgan", picture: "https://fixture.test/avatar" }],
  [teammate, { name: "Sam Rivera" }],
  [agent, { name: "Studio assistant", isAgent: true }],
]);
export const artwork = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#e9e8e4"/><circle cx="460" cy="100" r="48" fill="#cda97c"/><path d="M0 360L180 120L390 360M210 360L425 180L640 360" fill="#859e89"/></svg>')}`;
export const media = (url: string) => {
  if (url.endsWith("/panorama"))
    return `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1"><path d="M0 .5H1000" stroke="#859e89"/></svg>')}`;
  if (url.includes("/gif-")) return animatedGif;
  if (url.endsWith("/video")) return video;
  if (url.endsWith("/avatar")) return avatar;
  if (url.endsWith("/landscape") || url.endsWith("/poster")) return artwork;
  if (url.endsWith("/notes")) return "https://example.com/design-notes.txt";
  return undefined;
};
export function message(
  id: string,
  content: string,
  patch: Partial<ChannelMessage> = {},
): ChannelMessage {
  return {
    id,
    channelId: "studio",
    authorId: reader,
    createdAt: 1_790_078_400,
    content,
    mentions: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
    participants: [],
    ...patch,
  };
}
export type Example = {
  id: string;
  title: string;
  description: string;
  rows: TimelineRow[];
  day?: boolean;
  timecode?: boolean;
};
export type Group = {
  id: string;
  title: string;
  description: string;
  examples: Example[];
};
const single = (
  id: string,
  title: string,
  description: string,
  content: string,
  patch: Partial<ChannelMessage> = {},
): Example => ({ id, title, description, rows: [message(id, content, patch)] });
export const groups: Group[] = [
  {
    id: "gifs",
    title: "Sent images and GIFs",
    description: "Full-frame image previews, with and without message text.",
    examples: [
      single(
        "gif-only",
        "GIF only",
        "Known dimensions reserve the full frame.",
        "",
        {
          attachments: [
            {
              url: "https://fixture.test/gif-landscape.gif",
              kind: "image",
              dimensions: { width: 480, height: 320 },
            },
          ],
        },
      ),
      single(
        "gif-caption",
        "GIF with text",
        "Missing dimensions retain a stable frame without cropping.",
        "A little celebration!",
        {
          attachments: [
            {
              url: "https://fixture.test/gif-caption.GIF?version=1",
              kind: "image",
            },
          ],
        },
      ),
      single(
        "gif-multiple",
        "Multiple GIFs and a photo",
        "All images keep full previews in attachment order.",
        "Both of these made me smile.",
        {
          attachments: [
            {
              url: "https://fixture.test/gif-one.gif",
              kind: "image",
              dimensions: { width: 480, height: 320 },
            },
            {
              url: "https://fixture.test/landscape",
              kind: "image",
              dimensions: { width: 640, height: 360 },
            },
            {
              url: "https://fixture.test/gif-extensionless",
              kind: "image",
            },
          ],
        },
      ),
      single(
        "gif-unavailable",
        "Unavailable GIF",
        "Unavailable media keeps a readable status.",
        "This GIF is unavailable.",
        {
          attachments: [
            { url: "https://fixture.test/unavailable.gif", kind: "image" },
          ],
        },
      ),
      single(
        "image-panorama",
        "Thin image in a narrow column",
        "The preview target retains at least one CSS pixel when it shrinks.",
        "",
        {
          attachments: [
            {
              url: "https://fixture.test/panorama",
              kind: "image",
              dimensions: { width: 360, height: 1 },
            },
          ],
        },
      ),
      single(
        "emoji-wrapped",
        "Wrapped emoji",
        "Large emoji have enough line space when they wrap.",
        "🎉 :landscape: 🚀 👍🏽 :landscape: 👨‍👩‍👧‍👦 🇦🇺 :landscape: 1️⃣ 🎉 :landscape: 🚀 👍🏽 :landscape: 👨‍👩‍👧‍👦 🇦🇺 :landscape: 1️⃣",
        {
          emoji: [
            { shortcode: "landscape", url: "https://fixture.test/landscape" },
          ],
        },
      ),
    ],
  },
  {
    id: "workflow",
    title: "Workflow attribution",
    description:
      "Local signed examples using the real message fold and renderer. No relay connection or workflow execution.",
    examples: [
      {
        id: "workflow-owner",
        title: "Automated message",
        description:
          "Automation leads; owner navigation is labelled. Open the information icon to inspect the separate owner and relay keys.",
        rows: foldMessages(
          "studio",
          workflowRelay.pubkey,
          [
            eventDto(
              signed(workflowRelay, {
                kind: 9,
                created_at: 1_790_078_400,
                content: "Scheduled check-in: what needs attention today?",
                tags: [
                  ["p", workflowOwner.pubkey],
                  ["h", "studio"],
                  ["buzz:workflow", "true"],
                  ["buzz:workflow-owner", workflowOwner.pubkey],
                ],
              }),
            ),
          ],
          { signingAuthority: workflowRelay.pubkey },
        ),
      },
      {
        id: "workflow-missing-profile",
        title: "Owner profile unavailable",
        description:
          "Ownership remains explicit without guessing a name or borrowing the relay’s profile.",
        rows: foldMessages(
          "studio",
          workflowRelay.pubkey,
          [
            eventDto(
              signed(workflowRelay, {
                kind: 9,
                created_at: 1_790_078_460,
                content: "The weekly summary is ready.",
                tags: [
                  ["p", missingWorkflowOwner.pubkey],
                  ["h", "studio"],
                  ["buzz:workflow", "true"],
                  ["buzz:workflow-owner", missingWorkflowOwner.pubkey],
                ],
              }),
            ),
          ],
          { signingAuthority: workflowRelay.pubkey },
        ),
      },
      single(
        "human-comparison",
        "Human message, unchanged",
        "Human authors keep their own avatar and name.",
        "I’ll review it this afternoon.",
      ),
    ],
  },
  {
    id: "content",
    title: "Content and identity",
    description:
      "Human and agent messages use the same row layout, with different identity shapes.",
    examples: [
      single(
        "text",
        "Plain text",
        "A human author, timestamp, and short message.",
        "The latest designs are ready. Let me know what you think.",
      ),
      single(
        "agent",
        "Agent response",
        "An agent envelope uses a squircle avatar and the same Markdown renderer.",
        "I reviewed the changes. **Two details** still need attention:\n\n- Align the labels.\n- Check the narrow layout.",
        { authorId: agent, agentEnvelope: true },
      ),
      single(
        "fallback",
        "Unknown author",
        "Missing profile data falls back to a shortened public key and initials.",
        "I’ll take a look this afternoon.",
        { authorId: "d".repeat(64) },
      ),
      single(
        "long",
        "Long message",
        "Multiple paragraphs and long tokens wrap within the message column.",
        "A longer update helps us inspect line length and vertical rhythm. The same row should remain readable when the panel becomes narrow.\n\nPlease check the spacing around the author, the timestamp, and the body before we move on.\n\n" +
          "long-unbroken-reference-".repeat(8),
      ),
      single(
        "markdown",
        "Rich text",
        "Headings, emphasis, quotes, lists, links, and inline code.",
        "### Review notes\n**Ready to review**, with *a few questions* and ~~one resolved item~~.\n\n> Keep the conversation easy to read.\n\n1. Check the default state.\n2. Review the error state.\n\n- [x] Layout\n- [ ] Keyboard behavior\n\nUse `message.id` in the [reference](https://example.com).",
      ),
      single(
        "code",
        "Code and tables",
        "Wide code and tables retain their own scrolling area.",
        "```ts\nconst message = { author: 'Studio assistant', status: 'ready', content: 'A long example for checking horizontal overflow in a narrow panel' };\n```\n\n| State | Meaning | Action |\n| --- | --- | --- |\n| Sent | Confirmed in history | None |\n| Failed | Publication rejected | Retry |",
      ),
      single(
        "emoji",
        "Emoji only",
        "Emoji-only content uses the current enlarged presentation.",
        "🎉 🚀",
      ),
      single(
        "custom-emoji",
        "Custom emoji",
        "An event-local emoji mapping uses the production CustomEmoji renderer.",
        "A little :landscape: inspiration.",
        {
          emoji: [
            { shortcode: "landscape", url: "https://fixture.test/landscape" },
          ],
        },
      ),
      single(
        "custom-emoji-missing",
        "Unavailable custom emoji",
        "The shortcode remains readable when the image cannot resolve.",
        "Thanks :missing:!",
        {
          emoji: [
            { shortcode: "missing", url: "https://fixture.test/missing-emoji" },
          ],
        },
      ),
      single(
        "mentions",
        "Person mention",
        "An explicit recipient plus a matching profile binds the name to its identity.",
        "@Sam Rivera could you review the spacing?",
        { mentions: [teammate] },
      ),
      single(
        "edited",
        "Edited content",
        "The current renderer shows the replacement body without a separate edited badge.",
        "Updated: the review is now at 3 pm.",
        { edited: true },
      ),
    ],
  },
  {
    id: "conversation",
    title: "Conversation context",
    description: "Date separators, reactions, thread summaries, and replies.",
    examples: [
      {
        id: "day",
        title: "Date separator and consecutive messages",
        description:
          "The same row composition is used for successive messages, including repeated authors.",
        day: true,
        rows: [
          message("day-a", "Good morning!"),
          message("day-b", "I’ve posted the update above.", {
            createdAt: 1_790_078_460,
          }),
        ],
      },
      single(
        "reactions",
        "Reactions",
        "Reaction tokens below the body, as currently rendered.",
        "This is ready to ship.",
        {
          reactions: ["🎉", "👍", "❤️"].map((content, index) => ({
            content,
            events: [{ id: `sample-reaction-${index}`, authorId: teammate }],
          })),
        },
      ),
      single(
        "thread",
        "Thread summary",
        "Reply count and participant avatars; click to reveal sample replies.",
        "Let’s discuss the empty state here.",
        {
          replyCount: 4,
          participants: [reader, teammate, agent, "e".repeat(64)],
        },
      ),
      single(
        "reply",
        "Thread reply",
        "A reply uses the same row, within its thread context.",
        "The shorter label reads much better.",
        { authorId: teammate, threadRootId: "thread" },
      ),
      {
        ...single(
          "timecode",
          "Media-time reply",
          "A video timestamp anchors feedback to a moment in the clip.",
          "⏱ 0:12 — This transition needs a little more time.",
        ),
        timecode: true,
      },
    ],
  },
  {
    id: "attachments",
    title: "Attachments",
    description:
      "This first gallery pass covers images, video, and files. Audio and voice-note specimens are a follow-up.",
    examples: [
      single(
        "image",
        "Image attachment",
        "A local illustration renders through the real attachment component.",
        "Here’s the first direction.",
        {
          attachments: [
            {
              url: "https://fixture.test/landscape",
              kind: "image",
              dimensions: { width: 640, height: 360 },
            },
          ],
        },
      ),
      single(
        "images",
        "Multiple images",
        "Each image follows the current stacked attachment layout.",
        "Comparing two options.",
        {
          attachments: [
            {
              url: "https://fixture.test/landscape",
              kind: "image",
              dimensions: { width: 640, height: 360 },
            },
            {
              url: "https://fixture.test/poster",
              kind: "image",
              dimensions: { width: 640, height: 360 },
            },
          ],
        },
      ),
      single(
        "image-unavailable",
        "Unavailable image",
        "No media source is available.",
        "The original image can’t be loaded.",
        {
          attachments: [{ url: "https://fixture.test/missing", kind: "image" }],
        },
      ),
      single(
        "video",
        "Video attachment",
        "The clip uses a locally generated sample and the real play/fullscreen controls.",
        "A quick walkthrough.",
        {
          attachments: [
            {
              url: "https://fixture.test/video",
              kind: "video",
              previewUrl: "https://fixture.test/poster",
              dimensions: { width: 640, height: 360 },
            },
          ],
        },
      ),
      single(
        "video-unavailable",
        "Unavailable video",
        "The same row when video media cannot be resolved.",
        "The recording is unavailable.",
        {
          attachments: [
            { url: "https://fixture.test/missing-video", kind: "video" },
          ],
        },
      ),
      single(
        "file",
        "File attachment",
        "Filename and sender-provided size with an open action.",
        "Notes from our review.",
        {
          attachments: [
            {
              url: "https://fixture.test/notes",
              kind: "file",
              name: "design-review-notes.txt",
              mime: "text/plain",
              size: 12800,
            },
          ],
        },
      ),
      single(
        "file-unavailable",
        "Unavailable file",
        "Filename remains visible when the source is missing.",
        "The attachment needs to be uploaded again.",
        {
          attachments: [
            {
              url: "https://fixture.test/missing-file",
              kind: "file",
              name: "design-review.pdf",
              mime: "application/pdf",
            },
          ],
        },
      ),
    ],
  },
  {
    id: "delivery",
    title: "Delivery states",
    description:
      "Feedback appears after the existing 10-second grace period. Accepted is not the same as confirmed in history; several pending states intentionally share the same copy.",
    examples: [
      ...(["sending", "accepted", "unknown", "failed", "seen"] as const).map(
        (delivery) =>
          single(
            `delivery-${delivery}`,
            delivery === "seen"
              ? "Confirmed in history"
              : delivery.charAt(0).toUpperCase() + delivery.slice(1),
            delivery === "seen"
              ? "Confirmed messages have no delivery notice."
              : delivery === "failed" || delivery === "unknown"
                ? "Retry is available. The demo retries locally and resets with the gallery."
                : "Shown after the grace period with confirmation still outstanding.",
            "I’ve sent the updated mockups.",
            { delivery },
          ),
      ),
      single(
        "delivery-detail",
        "Unconfirmed with details",
        "Additional delivery context appears beside the retry action.",
        "Please review when you have a moment.",
        {
          delivery: "unknown",
          deliveryError:
            "Connection interrupted. Reconnect to confirm delivery.",
        },
      ),
    ],
  },
  {
    id: "activity",
    title: "Membership activity",
    description:
      "System activity has a quieter layout than conversational messages.",
    examples: [
      ...(["member_joined", "member_left", "member_removed"] as const).map(
        (type) =>
          single(
            type,
            type === "member_joined"
              ? "Member joined"
              : type === "member_left"
                ? "Member left"
                : "Member removed",
            "Rendered by MembershipRow, not a regular message bubble.",
            "",
            {
              membership: {
                type,
                actor: type === "member_removed" ? reader : teammate,
                target: teammate,
              },
            },
          ),
      ),
      {
        id: "grouped-members",
        title: "Grouped joins",
        description:
          "Adjacent membership activity collapses into a single row with multiple identities.",
        rows: [
          {
            ...message("grouped", "", {
              membership: {
                type: "member_joined",
                actor: reader,
                target: reader,
              },
            }),
            membershipRows: [reader, teammate, agent].map((id, index) =>
              message(`join-${index}`, "", {
                membership: { type: "member_joined", actor: id, target: id },
              }),
            ),
          },
        ],
      },
    ],
  },
];
