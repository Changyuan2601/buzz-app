// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DeliveryNotice } from "./DeliveryNotice";
import type { ChannelMessage } from "../relay/contracts";

afterEach(cleanup);
const row: ChannelMessage = {
  id: "message",
  channelId: "channel",
  authorId: "author",
  content: "Message",
  createdAt: 1,
  mentions: [],
  attachments: [],
  reactions: [],
  participants: [],
  replyCount: 0,
};
it.each(["sending", "received"] as const)(
  "keeps managed %s delivery silent",
  (phase) => {
    render(
      <DeliveryNotice
        row={{
          ...row,
          delivery: "accepted",
          managedDelivery: {
            operationId: row.id,
            eventId: row.id,
            phase,
            relayAccepted: true,
            agentReceived: phase === "received",
          },
        }}
        retry={vi.fn()}
      />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  },
);
it.each([false, true])(
  "uses the recovery action for relay acceptance %s",
  (relayAccepted) => {
    const retry = vi.fn();
    render(
      <DeliveryNotice
        row={{
          ...row,
          managedDelivery: {
            operationId: row.id,
            eventId: row.id,
            phase: "failed",
            relayAccepted,
            agentReceived: false,
            error: relayAccepted
              ? "Could not confirm delivery"
              : "Could not send",
          },
        }}
        retry={retry}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      relayAccepted ? "Could not confirm delivery" : "Could not send",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: relayAccepted ? "Check again" : "Retry",
      }),
    );
    expect(retry).toHaveBeenCalledExactlyOnceWith(row.id);
  },
);

it.each(["sending", "accepted", "unknown", "failed"] as const)(
  "keeps %s feedback visible without a retry handler",
  (delivery) => {
    render(<DeliveryNotice row={{ ...row, delivery }} />);
    expect(screen.getByRole("status")).not.toHaveClass("sr-only");
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  },
);

it.each(["sending", "accepted", "unknown", "failed"] as const)(
  "hides %s feedback only when its retry action is available",
  (delivery) => {
    render(<DeliveryNotice row={{ ...row, delivery }} retry={vi.fn()} />);
    const canRetry = delivery === "unknown" || delivery === "failed";
    expect(screen.getByRole("status").classList.contains("sr-only")).toBe(
      canRetry,
    );
    expect(!!screen.queryByRole("button", { name: "Retry" })).toBe(canRetry);
  },
);
