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
import { afterEach, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools";
import { createChannelDetails } from "../relay/channel-details";
import { createRelaySession } from "../relay/session";
import { PublishRejected } from "../relay/outbox";
import { sessionDescription } from "./metadata";
import { beginSessionShare, finishSessionShare } from "./share-attempt";
import { sessionConversion } from "./conversion";
import { ConvertSession, canConvertSession } from "./ConvertSession";

const id = "11111111-1111-4111-8111-111111111111";
const key = new Uint8Array(32).fill(2),
  relayKey = new Uint8Array(32).fill(3);
const viewer = getPublicKey(key),
  relayAuthor = getPublicKey(relayKey);
const dispose: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const close of dispose.splice(0)) close();
});
function setup(description = sessionDescription()) {
  let clock = 100,
    role = "owner",
    name = "Original",
    about = description,
    visibility = "private";
  let labels = ["work"];
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
      ...labels.map((label) => ["t", label]),
      [visibility],
      ["ttl", "86400"],
    ]);
  const read = vi.fn(async () => [
    metadata(),
    record(39001, role === "member" ? [] : [["p", viewer, role]]),
    record(39002, [["p", viewer, "", role]]),
  ]);
  const sign = vi.fn(async (template: EventTemplate) =>
    finalizeEvent(structuredClone(template), key),
  );
  const publish = vi.fn(async (event: import("../relay/events").RelayEvent) => {
    about = "";
    const choice = event.tags.find(([tag]) => tag === "visibility")?.[1];
    if (choice) visibility = choice === "open" ? "public" : "private";
    clock++;
  });
  const details = createChannelDetails({
    reader: { read },
    writer: { sign, publish },
    viewer,
    relayAuthor,
    labels: true,
    canAccess: () => true,
    acceptDiscovery: () => {},
  });
  const owner = createRelaySession(null);
  dispose.push(details.dispose, owner.dispose);
  let placed = true;
  const placementState = {
    ...owner.session.mePlacement.snapshot(),
    status: "ready" as const,
  };
  const placementSet = vi.fn(
    async (
      _id: string,
      _personal: boolean,
      _options?: { signal?: AbortSignal },
    ) => {
      placed = false;
    },
  );
  const placementRefresh = vi.fn(async () => {});
  const session = {
    ...owner.session,
    channelDetails: details.capability,
    mePlacement: {
      ...owner.session.mePlacement,
      available: true,
      snapshot: () => placementState,
      refresh: placementRefresh,
      has: () => placed,
      set: placementSet,
    },
  };
  const close = vi.fn();
  const converted = vi.fn();
  const visit = new AbortController();
  const mounted = render(
    <ConvertSession
      session={session}
      id={id}
      signal={visit.signal}
      close={close}
      onConverted={converted}
    />,
  );
  return {
    session,
    close,
    convertedCallback: converted,
    placementSet,
    placementRefresh,
    removePlacement: () => {
      placed = false;
    },
    read,
    sign,
    publish,
    visit,
    mounted,
    details,
    authority: (next: string) => {
      role = next;
    },
    relabel: () => {
      labels = ["updated"];
      clock++;
    },
    rename: () => {
      name = "Changed";
      clock++;
    },
    converted: (next = "private") => {
      about = "";
      visibility = next;
      clock++;
    },
  };
}
const confirm = () =>
  screen.getByRole("button", { name: "Convert to channel" });
async function ready() {
  await waitFor(() => expect(confirm()).toBeEnabled());
}
it("cancel makes no metadata or membership write", async () => {
  const h = setup();
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(h.close).toHaveBeenCalledOnce();
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});
it.each(["private", "public"])(
  "converts through signed kind 9002 with explicit %s visibility and unchanged TTL",
  async (visibility) => {
    const h = setup();
    await ready();
    expect(screen.getByRole("radio", { name: "Private" })).toBeChecked();
    expect(
      screen.getByRole("radio", { name: "Public" }),
    ).toHaveAccessibleDescription(
      "Everyone in this community will be able to view this channel’s full history.",
    );
    if (visibility === "public")
      fireEvent.click(screen.getByRole("radio", { name: "Public" }));
    expect(h.sign).not.toHaveBeenCalled();
    fireEvent.click(confirm());
    await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.placementSet).toHaveBeenCalledExactlyOnceWith(id, false, {
      signal: expect.any(AbortSignal),
    });
    expect(h.convertedCallback).toHaveBeenCalledOnce();
    expect(h.publish.mock.invocationCallOrder[0]).toBeLessThan(
      h.placementSet.mock.invocationCallOrder[0] ?? 0,
    );
    expect(sessionConversion(h.session, id)).toBeUndefined();
    const event = h.sign.mock.calls[0]?.[0];
    expect(event?.kind).toBe(9002);
    expect(event?.tags).toEqual([
      ["h", id],
      ["name", "Original"],
      ["about", ""],
      ...(visibility === "public" ? [["visibility", "open"]] : []),
    ]);
    const saved = await h.details.capability.load(id);
    expect(saved).toMatchObject({
      name: "Original",
      description: "",
      visibility,
      ttlSeconds: 86400,
      labels: ["work"],
    });
  },
);
it.each(["authority", "conflict"])(
  "fresh %s prevents conversion and reload explicitly recovers",
  async (change) => {
    const h = setup();
    await ready();
    if (change === "authority") h.authority("member");
    else h.rename();
    fireEvent.click(confirm());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      change === "authority" ? "permission" : "changed",
    );
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    h.authority("admin");
    fireEvent.click(
      screen.getByRole("button", { name: "Reload session details" }),
    );
    await ready();
    fireEvent.click(confirm());
    await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.sign.mock.calls[0]?.[0].tags.some(([tag]) => tag === "t")).toBe(
      false,
    );
    expect((await h.details.capability.load(id)).labels).toEqual(["work"]);
  },
);
it.each(
  ["private", "public"].flatMap((visibility) =>
    [false, true].map((failedRead) => ({ visibility, failedRead })),
  ),
)(
  "unknown $visibility conversion checks status without resending after remount, failed initial read=$failedRead",
  async ({ visibility, failedRead }) => {
    const h = setup();
    h.publish.mockRejectedValueOnce(new Error("lost acknowledgement"));
    await ready();
    if (visibility === "public")
      fireEvent.click(screen.getByRole("radio", { name: "Public" }));
    fireEvent.click(confirm());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "may have been saved",
    );
    h.mounted.unmount();
    const pending = h.details.capability.snapshot(id);
    if (failedRead)
      h.read.mockRejectedValueOnce(new Error("Details unavailable"));
    render(<ConvertSession session={h.session} id={id} close={h.close} />);
    if (failedRead) {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Details unavailable",
      );
      expect(confirm()).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Check status" })).toBeNull();
      expect(h.details.capability.snapshot(id)).toBe(pending);
      expect(
        screen.getByRole("radio", {
          name: visibility === "public" ? "Public" : "Private",
        }),
      ).toBeChecked();
      expect(screen.getByRole("radio", { name: "Public" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(screen.getByRole("radio", { name: "Private" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Reload session details" }),
      );
    }
    const check = await screen.findByRole("button", { name: "Check status" });
    expect(h.details.capability.snapshot(id)).toBe(pending);
    expect(
      screen.getByRole("radio", {
        name: visibility === "public" ? "Public" : "Private",
      }),
    ).toBeChecked();
    expect(screen.getByRole("radio", { name: "Public" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("radio", { name: "Private" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    fireEvent.click(
      screen.getByRole("radio", {
        name: visibility === "public" ? "Private" : "Public",
      }),
    );
    expect(
      screen.getByRole("radio", {
        name: visibility === "public" ? "Public" : "Private",
      }),
    ).toBeChecked();
    expect(h.sign).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledOnce();
    fireEvent.click(check);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "may have been saved",
    );
    expect(h.publish).toHaveBeenCalledOnce();
    h.converted(visibility);
    fireEvent.click(check);
    await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    expect(h.sign).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledOnce();
  },
);
it("conversion preserves independently changed labels without publishing a label edit", async () => {
  const h = setup();
  await ready();
  h.relabel();
  fireEvent.click(confirm());
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.sign.mock.calls[0]?.[0].tags).toEqual([
    ["h", id],
    ["name", "Original"],
    ["about", ""],
  ]);
  expect((await h.details.capability.load(id)).labels).toEqual(["updated"]);
});

it.each([false, true])(
  "uncertain conversion recovers after an independent label change, remount=%s",
  async (remount) => {
    const h = setup();
    h.publish.mockRejectedValueOnce(new Error("lost acknowledgement"));
    await ready();
    fireEvent.click(confirm());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "may have been saved",
    );
    h.converted();
    h.relabel();
    if (remount) {
      h.mounted.unmount();
      render(<ConvertSession session={h.session} id={id} close={h.close} />);
    }
    fireEvent.click(
      await screen.findByRole("button", { name: "Check status" }),
    );
    await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    expect(h.details.capability.snapshot(id)).toBeUndefined();
    expect(h.sign).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledOnce();
    expect((await h.details.capability.load(id)).labels).toEqual(["updated"]);
  },
);

it("definitive rejection permits explicit retry without losing the confirmation", async () => {
  const h = setup();
  h.publish.mockRejectedValueOnce(new PublishRejected("Denied"));
  await ready();
  fireEvent.click(confirm());
  expect(await screen.findByRole("alert")).toHaveTextContent("Denied");
  await ready();
  fireEvent.click(confirm());
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.publish).toHaveBeenCalledTimes(2);
});
it("parent-linked session cannot convert", async () => {
  const h = setup(sessionDescription("22222222-2222-4222-8222-222222222222"));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("permission"),
  );
  expect(confirm()).toBeDisabled();
  expect(h.publish).not.toHaveBeenCalled();
});
it.each(["visit", "unmount"])(
  "%s during signing prevents publication and late modal close",
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
      fireEvent.click(cancel);
      expect(h.close).toHaveBeenCalledOnce();
    }
  },
);

it("an unrelated unconfirmed metadata change cannot be checked as conversion", async () => {
  const h = setup();
  await ready();
  const base = await h.details.capability.load(id);
  h.publish.mockRejectedValueOnce(new Error("lost acknowledgement"));
  await act(async () => {
    await h.details.capability
      .save(base, { ...base, name: "Other edit" })
      .catch(() => {});
  });
  expect(screen.getByRole("status")).toHaveTextContent("Finish the existing");
  expect(screen.queryByRole("button", { name: "Check status" })).toBeNull();
  expect(confirm()).toBeDisabled();
  expect(h.publish).toHaveBeenCalledOnce();
});

it("blocks an already open conversion while a share remains pending and recovers after Start over", async () => {
  const h = setup();
  await ready();
  act(() => {
    beginSessionShare(h.session, id, {
      destination: id,
      sessionPeople: [],
    });
  });
  expect(confirm()).toBeDisabled();
  fireEvent.click(confirm());
  expect(h.sign).not.toHaveBeenCalled();
  expect(
    screen.getByText("Finish sharing or choose Start over before converting."),
  ).toBeVisible();
  act(() => {
    finishSessionShare(h.session, id);
  });
  await ready();
  fireEvent.click(confirm());
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.publish).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "retries only Me removal after confirmed conversion, remount=%s",
  async (remount) => {
    const h = setup();
    h.placementSet.mockRejectedValueOnce(new Error("Me save unavailable"));
    await ready();
    fireEvent.click(screen.getByRole("radio", { name: "Public" }));
    fireEvent.click(confirm());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Me save unavailable",
    );
    expect(sessionConversion(h.session, id)?.converted).toBe(true);
    expect(h.convertedCallback).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    expect(
      canConvertSession(h.session, {
        id,
        name: "Original",
        channelType: "stream",
      }),
    ).toBe(true);
    if (remount) {
      h.mounted.unmount();
      render(
        <ConvertSession
          session={h.session}
          id={id}
          close={h.close}
          onConverted={h.convertedCallback}
        />,
      );
    }
    expect(
      screen.getByText("Channel converted. Finish removing it from Solo."),
    ).toBeVisible();
    expect(screen.getByRole("radio", { name: "Public" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Finish conversion" }));
    await waitFor(() => expect(h.convertedCallback).toHaveBeenCalledOnce());
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.sign).toHaveBeenCalledOnce();
    expect(h.placementSet).toHaveBeenCalledTimes(2);
    expect(sessionConversion(h.session, id)).toBeUndefined();
  },
);
it("blocks conversion before metadata when Me cannot be read", async () => {
  const h = setup();
  h.placementRefresh.mockRejectedValueOnce(new Error("Me read failed"));
  await ready();
  fireEvent.click(confirm());
  expect(await screen.findByRole("alert")).toHaveTextContent("Me read failed");
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.placementSet).not.toHaveBeenCalled();
  expect(sessionConversion(h.session, id)).toBeUndefined();
});
it.each(["visit", "unmount"])(
  "retains converted recovery but suppresses completion after %s during Me removal",
  async (retire) => {
    const h = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.placementSet.mockImplementationOnce(async () => {
      await held;
      h.removePlacement();
    });
    await ready();
    fireEvent.click(confirm());
    try {
      await waitFor(() => expect(h.placementSet).toHaveBeenCalledOnce());
      expect(h.publish).toHaveBeenCalledOnce();
      if (retire === "visit") h.visit.abort();
      else h.mounted.unmount();
    } finally {
      await act(async () => {
        release();
        await held;
      });
    }
    expect(h.convertedCallback).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    expect(sessionConversion(h.session, id)?.converted).toBe(true);
  },
);

it("finishes removal when another details consumer confirmed the uncertain conversion", async () => {
  const h = setup();
  h.publish.mockRejectedValueOnce(new Error("lost acknowledgment"));
  await ready();
  fireEvent.click(confirm());
  await screen.findByRole("alert");
  h.mounted.unmount();
  h.converted();
  await h.session.channelDetails.check(id);
  expect(h.session.channelDetails.snapshot(id)).toBeUndefined();
  expect(sessionConversion(h.session, id)?.converted).not.toBe(true);
  render(
    <ConvertSession
      session={h.session}
      id={id}
      close={h.close}
      onConverted={h.convertedCallback}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Finish conversion" }),
  );
  await waitFor(() => expect(h.convertedCallback).toHaveBeenCalledOnce());
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.placementSet).toHaveBeenCalledOnce();
});
it("offers explicit removal-only recovery for a retained ordinary channel without an in-process receipt", async () => {
  const h = setup("");
  expect(sessionConversion(h.session, id)).toBeUndefined();
  const move = await screen.findByRole("button", {
    name: "Move to Multiplayer",
  });
  expect(screen.queryByRole("radio")).toBeNull();
  fireEvent.click(move);
  await waitFor(() => expect(h.convertedCallback).toHaveBeenCalledOnce());
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.placementSet).toHaveBeenCalledExactlyOnceWith(id, false, {
    signal: expect.any(AbortSignal),
  });
});
it("serializes conversion completion across two mounted forms", async () => {
  const h = setup();
  await ready();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.placementSet.mockImplementationOnce(async () => {
    await held;
    h.removePlacement();
  });
  fireEvent.click(confirm());
  try {
    await waitFor(() => expect(h.placementSet).toHaveBeenCalledOnce());
    render(<ConvertSession session={h.session} id={id} close={vi.fn()} />);
    const finish = screen.getAllByRole("button", {
      name: "Finish conversion",
      hidden: true,
    });
    expect(finish).toHaveLength(2);
    for (const button of finish) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.placementSet).toHaveBeenCalledOnce();
  } finally {
    await act(async () => {
      release();
      await held;
    });
  }
  await waitFor(() => expect(h.convertedCallback).toHaveBeenCalledOnce());
});
