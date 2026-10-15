// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools";
import { createChannelDetails } from "../relay/channel-details";
import { createRelaySession } from "../relay/session";
import { sessionDescription } from "./metadata";
import { WorkspaceSettings } from "./WorkspaceSettings";

const id = "11111111-1111-4111-8111-111111111111";
const key = new Uint8Array(32).fill(2),
  relayKey = new Uint8Array(32).fill(3);
const viewer = getPublicKey(key),
  relayAuthor = getPublicKey(relayKey);
beforeEach(() => localStorage.clear());
const dispose: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const close of dispose.splice(0)) close();
});
function setup(
  description = sessionDescription(),
  initialTtl = 86400,
  initialReadFails = false,
) {
  let clock = 100,
    role = "owner",
    name = "Original",
    about = description;
  let ttl: number | undefined = initialTtl;
  const record = (kind: number, tags: string[][]) =>
    finalizeEvent(
      { kind, tags: [["d", id], ...tags], content: "", created_at: clock },
      relayKey,
    );
  const metadata = () =>
    record(39000, [
      ["name", name],
      ["about", about],
      ["t", "stream"],
      ["private"],
      ...(ttl === undefined ? [] : [["ttl", String(ttl)]]),
    ]);
  const read = vi.fn(async () => [
    metadata(),
    record(39001, role === "member" ? [] : [["p", viewer, role]]),
    record(39002, [["p", viewer, "", role]]),
  ]);
  if (initialReadFails)
    read.mockRejectedValueOnce(new Error("Details unavailable"));
  const sign = vi.fn(async (template: EventTemplate) =>
    finalizeEvent(structuredClone(template), key),
  );
  const publish = vi.fn(async () => {
    ttl = undefined;
    clock++;
  });
  const details = createChannelDetails({
    reader: { read },
    writer: { sign, publish },
    viewer,
    relayAuthor,
    canAccess: () => true,
    acceptDiscovery: () => {},
  });
  const owner = createRelaySession(null);
  dispose.push(details.dispose, owner.dispose);
  const session = { ...owner.session, channelDetails: details.capability };
  const close = vi.fn();
  const visit = new AbortController();
  const mounted = render(
    <WorkspaceSettings
      session={session}
      scope="lifetime-test"
      target={{ kind: "session", id, name: "Original" }}
      signal={visit.signal}
      close={close}
    />,
  );
  return {
    session,
    close,
    read,
    sign,
    publish,
    visit,
    mounted,
    details,
    authority: (next: string) => {
      role = next;
    },
    rename: () => {
      name = "Changed";
      clock++;
    },
    saved: (next: number | undefined) => {
      ttl = next;
      clock++;
    },
  };
}
const confirm = () => screen.getByRole("button", { name: "Save changes" });
async function ready() {
  await waitFor(() => expect(confirm()).toBeEnabled());
}
it("no-op closes without signing or resetting a custom lifetime", async () => {
  const h = setup(sessionDescription(), 600);
  await ready();
  expect(screen.getByRole("radio", { name: /^Temporary/ })).toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: /^Ongoing/ }));
  fireEvent.click(screen.getByRole("radio", { name: /^Temporary/ }));
  expect(
    screen.getByRole("radio", { name: /^Temporary/ }),
  ).toHaveAccessibleDescription("Archives after 10 minutes without activity.");
  fireEvent.click(confirm());
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.sign).not.toHaveBeenCalled();
});
it.each([
  [600, "10 minutes"],
  [604800, "7 days"],
] as const)(
  "reload after initial failure adopts %s-second lifetime without saving",
  async (ttl, label) => {
    const h = setup(sessionDescription(), ttl, true);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Details unavailable",
    );
    expect(confirm()).toBeDisabled();
    expect(screen.queryByRole("radio", { name: /^Temporary/ })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Reload session details" }),
    );
    await ready();
    const temporary = screen.getByRole("radio", { name: /^Temporary/ });
    expect(temporary).toBeChecked();
    expect(temporary).toHaveAccessibleDescription(
      `Archives after ${label} without activity.`,
    );
    fireEvent.click(confirm());
    await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect((await h.details.capability.load(id)).ttlSeconds).toBe(ttl);
  },
);
it("changes only lifetime through signed details, retaining marker and privacy", async () => {
  const h = setup();
  await ready();
  fireEvent.click(screen.getByRole("radio", { name: /^Ongoing/ }));
  fireEvent.click(confirm());
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.sign.mock.calls[0]?.[0].tags).toEqual([
    ["h", id],
    ["name", "Original"],
    ["ttl", ""],
  ]);
  expect((await h.details.capability.load(id)).ttlSeconds).toBeUndefined();
  expect(await h.details.capability.load(id)).toMatchObject({
    description: sessionDescription(),
    visibility: "private",
  });
});
it.each(["authority", "conflict"])(
  "fresh %s blocks saving; reload retains lifetime choice",
  async (change) => {
    const h = setup();
    await ready();
    fireEvent.click(screen.getByRole("radio", { name: /^Ongoing/ }));
    if (change === "authority") h.authority("member");
    else h.rename();
    fireEvent.click(confirm());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      change === "authority" ? "permission" : "changed",
    );
    expect(h.publish).not.toHaveBeenCalled();
    h.authority("admin");
    fireEvent.click(
      screen.getByRole("button", { name: "Reload session details" }),
    );
    await ready();
    expect(screen.getByRole("radio", { name: /^Ongoing/ })).toBeChecked();
    fireEvent.click(confirm());
    await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  },
);
it("unknown lifetime removal survives remount and checks without resending", async () => {
  const h = setup();
  h.publish.mockRejectedValueOnce(new Error("Lost ack"));
  await ready();
  fireEvent.click(screen.getByRole("radio", { name: /^Ongoing/ }));
  fireEvent.click(confirm());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "may have been saved",
  );
  h.mounted.unmount();
  render(
    <WorkspaceSettings
      session={h.session}
      scope="lifetime-test"
      target={{ kind: "session", id, name: "Original" }}
      close={h.close}
    />,
  );
  const check = await screen.findByRole("button", {
    name: "Check save status",
  });
  await waitFor(() => expect(check).toBeEnabled());
  expect(screen.getByRole("radio", { name: /^Ongoing/ })).toBeChecked();
  h.saved(undefined);
  fireEvent.click(check);
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.sign).toHaveBeenCalledOnce();
  expect(h.publish).toHaveBeenCalledOnce();
});
it("parent-linked lifetime is denied", async () => {
  const h = setup(sessionDescription("22222222-2222-4222-8222-222222222222"));
  await waitFor(() =>
    expect(screen.queryByText("Loading session details…")).toBeNull(),
  );
  expect(screen.queryByRole("heading", { name: "Lifetime" })).toBeNull();
  expect(screen.queryByRole("radio", { name: /^Temporary/ })).toBeNull();
  expect(confirm()).toBeDisabled();
  expect(h.sign).not.toHaveBeenCalled();
});
it.each(["visit", "unmount"])(
  "%s during signing fences publication and late close",
  async (retire) => {
    const h = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.sign.mockImplementationOnce(async (template) => {
      await held;
      return finalizeEvent(template, key);
    });
    await ready();
    fireEvent.click(screen.getByRole("radio", { name: /^Ongoing/ }));
    fireEvent.click(confirm());
    try {
      await waitFor(() => expect(h.sign).toHaveBeenCalledOnce());
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      if (retire === "visit") h.visit.abort();
      else h.mounted.unmount();
    } finally {
      await act(async () => {
        release();
        await held;
      });
    }
    await waitFor(() =>
      expect(h.details.capability.snapshot(id)).toBeUndefined(),
    );
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    if (retire === "visit") {
      const cancel = screen.getByRole("button", { name: "Cancel" });
      await waitFor(() => expect(cancel).toBeEnabled());
      expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
      fireEvent.click(cancel);
      expect(h.close).toHaveBeenCalledOnce();
    }
  },
);

it("a retained legacy rename receipt can be checked through unified settings", async () => {
  const h = setup();
  await ready();
  const base = await h.details.capability.load(id);
  h.publish.mockRejectedValueOnce(new Error("Lost ack"));
  await act(async () => {
    await h.details.capability
      .save(base, { ...base, name: "Other edit" })
      .catch(() => {});
  });
  expect(
    screen.getByRole("button", { name: "Check save status" }),
  ).toBeEnabled();
  expect(h.publish).toHaveBeenCalledOnce();
});
