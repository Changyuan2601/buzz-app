// Real timeline and Virtua, with local data and no broker or live credentials.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ChannelTimeline } from "../../src/features/messages/ChannelTimeline";
import { createRelaySession } from "../../src/features/relay/session";
import { keypair } from "../../src/features/relay/testing";
import type { ChannelMessage } from "../../src/features/relay/contracts";
import { Button } from "../../src/shared/design-system/ui/Button";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import styles from "../../src/features/messages/Messages.module.css";
import "../../src/shared/styles/globals.css";

const owner = createRelaySession({
  viewer: keypair().pubkey,
  relayAuthor: keypair().pubkey,
  media: () => undefined,
  query: async () => [],
});
const agent = keypair().pubkey;
const update = (index: number): ChannelMessage => ({
  id: `activity-${index}`,
  channelId: "solo",
  authorId: agent,
  audience: "agents",
  createdAt: 1792152000 + index,
  content: `Activity update ${index}. Checked the conversation layout and kept the history available.\n\nThe expanded details explain what changed and why. They stay readable while the surrounding space opens.\n\nLinks, attachments and message actions continue to use the normal message renderer.`,
  mentions: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
  participants: [],
});
function Fixture() {
  useKeyboardFocusVisibility();
  const [rows, setRows] = useState<ChannelMessage[]>(
    Array.from({ length: 16 }, (_, index) => update(index)),
  );
  const [inlineTarget, setTarget] = useState<{
    messageId: string;
    signal: AbortSignal;
  }>();
  return (
    <main
      style={{
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        padding: 24,
        gap: 8,
      }}
    >
      <nav style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button
          onClick={() =>
            setRows([
              ...rows,
              update(Number(rows.at(-1)?.id.split("-").at(-1) ?? -1) + 1),
            ])
          }
        >
          Append update
        </Button>
        <Button
          onClick={() =>
            setTarget({
              messageId: "activity-0",
              signal: new AbortController().signal,
            })
          }
        >
          Visit first update
        </Button>
        <Button onClick={() => setRows([update(-1), ...rows])}>
          Prepend history
        </Button>
      </nav>
      <div className={styles.thread} style={{ flex: 1 }}>
        <ChannelTimeline
          transient
          channelId="solo"
          scope="activity-groups-fixture"
          queries={owner.session}
          chatPresentation
          inlineTarget={inlineTarget}
          window={{
            channelId: "solo",
            rows,
            status: "ready",
            hasMore: false,
            loadingOlder: false,
            freshness: "verified",
            error: undefined,
          }}
          onOpenLink={() => false}
        />
      </div>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
