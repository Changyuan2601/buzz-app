// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { ChannelMessage } from "../../features/relay/contracts";
import { eventDto } from "../../features/relay/events";
import { foldMessages } from "../../features/relay/fold";
import type { RelaySession } from "../../features/relay/session";
import { keypair, signed } from "../../features/relay/testing";
import { RemindDialog } from "./RemindDialog";

afterEach(cleanup);

it("saves a preview that never splits an emoji at the cap", async () => {
  const create = vi.fn(async () => {});
  // The emoji straddle UTF-16 unit 280, which a unit-based cut would halve.
  const content = `x${"😀".repeat(150)}`;
  render(
    <RemindDialog
      message={
        {
          id: "m",
          channelId: "c",
          authorId: "a",
          content,
        } as unknown as ChannelMessage
      }
      session={{ reminders: { create } } as unknown as RelaySession}
      close={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "In 30 minutes" }));
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  const [{ preview }] = create.mock.calls[0] as unknown as [
    { preview: string },
  ];
  // No lone surrogate, which the native bridge's JSON parser rejects.
  expect(() => encodeURIComponent(preview)).not.toThrow();
  expect(preview.startsWith(`x${"😀".repeat(100)}`)).toBe(true);
});

it("saves a well-formed preview when an emoji lands on the source cut after a stripped link", async () => {
  const create = vi.fn(async () => {});
  const link = `[a](https://example.com/${"x".repeat(4000)})`;
  const content = `${link}${" ".repeat(4095 - link.length)}😀`;
  render(
    <RemindDialog
      message={
        {
          id: "m",
          channelId: "c",
          authorId: "a",
          content,
        } as unknown as ChannelMessage
      }
      session={{ reminders: { create } } as unknown as RelaySession}
      close={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "In 30 minutes" }));
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  const [{ preview }] = create.mock.calls[0] as unknown as [
    { preview: string },
  ];
  expect(() => encodeURIComponent(preview)).not.toThrow();
  expect(preview).toBe("a");
});

it("saves a well-formed preview from a signed agent message holding a lone surrogate", async () => {
  // The signed wire text is well formed; its JSON body escapes a lone half
  // emoji, which decoding turns into real message text.
  const key = keypair();
  const wire = eventDto(
    JSON.parse(
      JSON.stringify(
        signed(key, {
          kind: 40002,
          tags: [["h", "room"]],
          content: JSON.stringify({ content: "a \ud83d" }),
        }),
      ),
    ),
  );
  const [message] = foldMessages("room", key.pubkey, [wire]);
  assert(message);
  expect(message.content).toBe("a \ud83d");
  const create = vi.fn(async () => {});
  render(
    <RemindDialog
      message={message}
      session={{ reminders: { create } } as unknown as RelaySession}
      close={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "In 30 minutes" }));
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  const [{ preview }] = create.mock.calls[0] as unknown as [
    { preview: string },
  ];
  expect(() => encodeURIComponent(preview)).not.toThrow();
  expect(preview).toBe("a \uFFFD");
});
