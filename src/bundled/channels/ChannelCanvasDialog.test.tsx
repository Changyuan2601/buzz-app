// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode, useRef, useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { keypair, signed } from "../../features/relay/testing";
import { readView, writeView } from "../../shared/view-state";
import { ChannelCanvasDialog } from "./ChannelCanvasDialog";
import type { ChannelCanvas } from "../../features/channel-templates/capability";

// jsdom has no WebGL; these tests cover the dialog, not Mapbox rendering.
vi.mock("mapbox-gl", () => ({ default: {} }));

const profiles = {
  snapshot: () => new Map(),
  subscribe: () => () => {},
  ensure: async () => {},
};
const scope = "canvas-test";
const channelId = "11111111-1111-4111-8111-111111111111";
const key = keypair();
const head = signed(key, {
  kind: 40100,
  content: "Saved",
  tags: [["h", channelId]],
});
function fixture(
  configure?: (canvas: {
    available: boolean;
    read: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    history: ReturnType<typeof vi.fn>;
  }) => void,
) {
  const canvas = {
    available: true,
    history: vi.fn<ChannelCanvas["history"]>(async () => ({
      revisions: [head],
      next: undefined,
    })),
    read: vi.fn(async () => head),
    save: vi.fn(async () => head),
  };
  configure?.(canvas);
  const close = vi.fn();
  render(
    <ChannelCanvasDialog
      canvas={canvas}
      profiles={profiles}
      scope={scope}
      channelId={channelId}
      open
      onOpenChange={close}
    />,
  );
  return { canvas, close };
}
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows only Save normally and preserves the read revision on an edited save", async () => {
  const user = userEvent.setup();
  const { canvas, close } = fixture();
  const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(text).toHaveValue("Saved"));
  expect(screen.queryByText("Current saved document")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", {
      name: /Load current|Reload saved Canvas|Retry loading/,
    }),
  ).not.toBeInTheDocument();
  fireEvent.change(text, { target: { value: "Edited" } });
  await user.click(screen.getByRole("button", { name: "Save Canvas" }));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(canvas.save).toHaveBeenCalledWith(channelId, "Edited", head.id);
});

it("keeps a restored conflict draft until explicit confirmed reload", async () => {
  const user = userEvent.setup();
  writeView(scope, `canvas-draft-v1:${channelId}`, {
    content: "My unsaved work",
    base: "a".repeat(64),
  });
  const { canvas } = fixture();
  expect(await screen.findByRole("alert")).toHaveTextContent("Canvas changed");
  const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
  expect(text).toHaveValue("My unsaved work");
  expect(screen.getByRole("button", { name: "Save Canvas" })).toBeDisabled();
  const reload = screen.getByRole("button", { name: "Reload saved Canvas" });
  for (const dismissal of ["backdrop", "escape", "close", "cancel"]) {
    await user.click(reload);
    const confirmation = screen.getByRole("dialog", {
      name: "Reload saved Canvas?",
    });
    await waitFor(() =>
      expect(
        within(confirmation).getByRole("button", { name: "Cancel" }),
      ).toHaveFocus(),
    );
    await user.click(
      within(confirmation).getByText(
        "Discard your draft and reload the saved Canvas?",
      ),
    );
    expect(confirmation).toBeInTheDocument();
    if (dismissal === "backdrop")
      await user.click(
        confirmation.parentElement?.querySelector(
          ".buzz-dialog-backdrop",
        ) as Element,
      );
    else if (dismissal === "escape") await user.keyboard("{Escape}");
    else
      await user.click(
        within(confirmation).getByRole("button", {
          name: dismissal === "close" ? "Close" : "Cancel",
        }),
      );
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    expect(
      screen.getByRole("dialog", { name: "Channel Canvas" }),
    ).toBeInTheDocument();
    // jsdom lacks focus({ preventScroll }) detection; browser coverage checks pointer return.
    if (dismissal !== "backdrop")
      await waitFor(() => expect(reload).toHaveFocus());
    expect(text).toHaveValue("My unsaved work");
    expect(canvas.read).toHaveBeenCalledTimes(1);
  }
  await user.click(reload);
  await user.click(screen.getByRole("button", { name: "Discard and reload" }));
  await waitFor(() => expect(text).toHaveValue("Saved"));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Reload saved Canvas" }),
  ).not.toBeInTheDocument();
  expect(canvas.save).not.toHaveBeenCalled();
});

it("retries a failed initial read without discarding the restored draft", async () => {
  const user = userEvent.setup();
  writeView(scope, `canvas-draft-v1:${channelId}`, {
    content: "Unsaved",
    base: head.id,
  });
  const canvas = {
    available: true,
    history: vi.fn<ChannelCanvas["history"]>(async () => ({
      revisions: [head],
      next: undefined,
    })),
    read: vi
      .fn()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue(head),
    save: vi.fn(async () => head),
  };
  render(
    <ChannelCanvasDialog
      canvas={canvas}
      profiles={profiles}
      scope={scope}
      channelId={channelId}
      open
      onOpenChange={() => {}}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
  await user.click(screen.getByRole("button", { name: "Retry loading" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save Canvas" })).toBeEnabled(),
  );
  expect(screen.getByRole("textbox", { name: "Canvas Markdown" })).toHaveValue(
    "Unsaved",
  );
  expect(canvas.save).not.toHaveBeenCalled();
});

it("ignores the stale StrictMode read after the current read enables typing and saving", async () => {
  const user = userEvent.setup();
  let release!: (value: typeof head) => void;
  const stale = new Promise<typeof head>((resolve) => {
    release = resolve;
  });
  const canvas = {
    available: true,
    history: vi.fn<ChannelCanvas["history"]>(async () => ({
      revisions: [head],
      next: undefined,
    })),
    read: vi.fn().mockReturnValueOnce(stale).mockResolvedValue(head),
    save: vi.fn(async () => ({ ...head, id: "b".repeat(64) })),
  };
  const close = vi.fn();
  render(
    <StrictMode>
      <ChannelCanvasDialog
        canvas={canvas}
        profiles={profiles}
        scope={scope}
        channelId={channelId}
        open
        onOpenChange={close}
      />
    </StrictMode>,
  );
  try {
    const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
    await waitFor(() => expect(text).toHaveValue("Saved"));
    expect(canvas.read).toHaveBeenCalledTimes(2);
    fireEvent.change(text, { target: { value: "New work" } });
    await act(async () => {
      release({ ...head, content: "Stale response" });
      await stale;
    });
    expect(text).toHaveValue("New work");
    await user.click(screen.getByRole("button", { name: "Save Canvas" }));
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    expect(canvas.save).toHaveBeenCalledWith(channelId, "New work", head.id);
  } finally {
    release(head);
  }
});

it("returns focus to the ingress on close and retains edits without publishing", async () => {
  const user = userEvent.setup();
  const canvas = {
    available: true,
    history: vi.fn<ChannelCanvas["history"]>(async () => ({
      revisions: [head],
      next: undefined,
    })),
    read: vi.fn(async () => head),
    save: vi.fn(async () => head),
  };
  function Harness() {
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button type="button" ref={trigger} onClick={() => setOpen(true)}>
          Canvas
        </button>
        {open && (
          <ChannelCanvasDialog
            canvas={canvas}
            profiles={profiles}
            scope={scope}
            channelId={channelId}
            open={open}
            onOpenChange={setOpen}
            finalFocus={trigger}
          />
        )}
      </>
    );
  }
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "Canvas" });
  await user.click(trigger);
  const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(text).toHaveValue("Saved"));
  await user.clear(text);
  await user.type(text, "Local draft");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(canvas.save).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Canvas Markdown" }),
    ).toBeEnabled(),
  );
  expect(screen.getByRole("textbox", { name: "Canvas Markdown" })).toHaveValue(
    "Local draft",
  );
  await user.click(screen.getByRole("button", { name: "Close Canvas" }));
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(canvas.save).not.toHaveBeenCalled();
});

const old = {
  ...head,
  id: "c".repeat(64),
  content: "Earlier",
  created_at: head.created_at - 60,
};
const restored = {
  ...head,
  id: "d".repeat(64),
  content: old.content,
  created_at: head.created_at + 1,
};
async function openHistory(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Canvas Markdown" }),
    ).toBeEnabled(),
  );
  await user.click(screen.getByRole("tab", { name: "History" }));
  await screen.findByRole("radio", { name: /Current/ });
  await user.click(screen.getAllByRole("radio").at(-1) as HTMLElement);
}
function historyFixture() {
  return fixture((canvas) => {
    canvas.history.mockResolvedValue({
      revisions: [head, old],
      next: undefined,
    });
    canvas.save.mockResolvedValue(restored);
  });
}
it("loads history only on demand and preserves draft/base through preview and cancelled restore", async () => {
  const user = userEvent.setup();
  const { canvas } = historyFixture();
  const editor = screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(editor).toHaveValue(head.content));
  expect(canvas.history).not.toHaveBeenCalled();
  fireEvent.change(editor, { target: { value: "Local edits" } });
  const before = readView(scope, `canvas-draft-v1:${channelId}`, null);
  await openHistory(user);
  expect(
    screen.getByRole("textbox", { name: "Revision Markdown" }),
  ).toHaveValue(old.content);
  for (const dismissal of ["cancel", "escape", "backdrop"]) {
    await user.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    const confirm = screen.getByRole("dialog", {
      name: "Restore this version?",
    });
    await waitFor(() =>
      expect(
        within(confirm).getByRole("button", { name: "Cancel" }),
      ).toHaveFocus(),
    );
    if (dismissal === "cancel")
      await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    else if (dismissal === "escape") await user.keyboard("{Escape}");
    else
      await user.click(
        confirm.parentElement?.querySelector(
          ".buzz-dialog-backdrop",
        ) as Element,
      );
    await waitFor(() => expect(confirm).not.toBeInTheDocument());
  }
  await user.click(screen.getByRole("tab", { name: "Edit" }));
  expect(screen.getByRole("textbox", { name: "Canvas Markdown" })).toBe(editor);
  expect(editor).toHaveValue("Local edits");
  expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toEqual(before);
  expect(canvas.save).not.toHaveBeenCalled();
});
it.each([false, true])(
  "restores as a new revision and preserves dirty drafts (dirty=%s)",
  async (dirty) => {
    const user = userEvent.setup();
    const { canvas, close } = historyFixture();
    const editor = screen.getByRole("textbox", { name: "Canvas Markdown" });
    await waitFor(() => expect(editor).toHaveValue(head.content));
    if (dirty) fireEvent.change(editor, { target: { value: "Local edits" } });
    await openHistory(user);
    await user.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    await user.click(screen.getByRole("button", { name: "Restore version" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Restore this version?" }),
      ).not.toBeInTheDocument(),
    );
    expect(canvas.save).toHaveBeenCalledWith(channelId, old.content, head.id);
    expect(close).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: "Edit" }));
    expect(editor).toHaveValue(dirty ? "Local edits" : old.content);
    expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toEqual({
      content: dirty ? "Local edits" : old.content,
      base: dirty ? head.id : restored.id,
    });
    if (dirty) {
      expect(
        screen.getByRole("button", { name: "Save Canvas" }),
      ).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "unsaved draft is kept",
      );
    } else
      expect(screen.getByRole("button", { name: "Save Canvas" })).toBeEnabled();
  },
);
it("keeps a stale recovered draft even when its text matches the loaded head", async () => {
  const user = userEvent.setup();
  writeView(scope, `canvas-draft-v1:${channelId}`, {
    content: head.content,
    base: "e".repeat(64),
  });
  historyFixture();
  await openHistory(user);
  await user.click(
    screen.getByRole("button", { name: "Restore this version" }),
  );
  await user.click(screen.getByRole("button", { name: "Restore version" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Restore this version?" }),
    ).not.toBeInTheDocument(),
  );
  expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toEqual({
    content: head.content,
    base: "e".repeat(64),
  });
});
it.each([
  "Canvas changed",
  "Save is awaiting exact relay confirmation",
  "A different Canvas is selected",
])("retains drafts and displays restore outcome: %s", async (message) => {
  const user = userEvent.setup();
  const { canvas } = historyFixture();
  await openHistory(user);
  canvas.save.mockRejectedValueOnce(new Error(message));
  canvas.read.mockResolvedValueOnce({
    ...head,
    id: "e".repeat(64),
    content: "Another editor",
  });
  await user.click(
    screen.getByRole("button", { name: "Restore this version" }),
  );
  await user.click(screen.getByRole("button", { name: "Restore version" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(message),
  );
  await user.click(screen.getByRole("tab", { name: "Edit" }));
  expect(screen.getByRole("textbox", { name: "Canvas Markdown" })).toHaveValue(
    head.content,
  );
  expect(screen.getByRole("button", { name: "Save Canvas" })).toBeDisabled();
  expect(canvas.save).toHaveBeenCalledOnce();
});
it("restores empty revisions but refuses current and oversized revisions", async () => {
  const user = userEvent.setup();
  const { canvas } = fixture((canvas) => {
    canvas.history.mockResolvedValue({
      revisions: [
        head,
        { ...old, content: "" },
        { ...old, id: "f".repeat(64), content: "x".repeat(24577) },
      ],
      next: undefined,
    });
  });
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Canvas Markdown" }),
    ).toBeEnabled(),
  );
  await user.click(screen.getByRole("tab", { name: "History" }));
  await screen.findByRole("radio", { name: /Current/ });
  expect(
    screen.getByRole("button", { name: "Restore this version" }),
  ).toBeDisabled();
  const radios = screen.getAllByRole("radio");
  await user.click(radios[2] as HTMLElement);
  expect(
    screen.getByRole("button", { name: "Restore this version" }),
  ).toBeDisabled();
  expect(screen.getByText(/exceeds the 24 KiB/)).toBeInTheDocument();
  await user.click(radios[1] as HTMLElement);
  expect(screen.getByText("This version is empty.")).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Restore this version" }),
  );
  await user.click(screen.getByRole("button", { name: "Restore version" }));
  await waitFor(() =>
    expect(canvas.save).toHaveBeenCalledWith(channelId, "", head.id),
  );
});

it("retries history failures, pages without losing selection and reconciles selection after restore", async () => {
  const user = userEvent.setup();
  const { canvas } = fixture((canvas) => {
    canvas.history.mockRejectedValueOnce(new Error("History offline"));
  });
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Canvas Markdown" }),
    ).toBeEnabled(),
  );
  await user.click(screen.getByRole("tab", { name: "History" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("History offline");
  const cursor = { until: head.created_at, before_id: head.id };
  canvas.history.mockResolvedValueOnce({ revisions: [head], next: cursor });
  await user.click(screen.getByRole("button", { name: "Refresh history" }));
  await screen.findByRole("radio", { name: /Current/ });
  canvas.history.mockResolvedValueOnce({ revisions: [old], next: undefined });
  await user.click(screen.getByRole("button", { name: "Load older" }));
  await waitFor(() => expect(screen.getAllByRole("radio")).toHaveLength(2));
  expect(canvas.history).toHaveBeenLastCalledWith(channelId, cursor);
  await waitFor(() => expect(screen.getAllByRole("radio")[1]).toHaveFocus());
  await user.click(screen.getAllByRole("radio")[1] as HTMLElement);
  canvas.save.mockResolvedValueOnce(restored);
  canvas.history.mockResolvedValueOnce({
    revisions: [restored, head],
    next: cursor,
  });
  await user.click(
    screen.getByRole("button", { name: "Restore this version" }),
  );
  await user.click(screen.getByRole("button", { name: "Restore version" }));
  await waitFor(() =>
    expect(screen.getByRole("radio", { name: /Current/ })).toBeChecked(),
  );
  expect(
    screen.getByRole("textbox", { name: "Revision Markdown" }),
  ).toHaveValue(restored.content);
  expect(
    screen.getByRole("button", { name: "Restore this version" }),
  ).toBeDisabled();
});
it("keeps the real same-second refusal on Edit without telling an unchanged draft to reload", async () => {
  const user = userEvent.setup();
  const { canvas } = historyFixture();
  await openHistory(user);
  canvas.save.mockRejectedValueOnce(
    new Error("Please wait a second before saving Canvas again"),
  );
  await user.click(
    screen.getByRole("button", { name: "Restore this version" }),
  );
  await user.click(screen.getByRole("button", { name: "Restore version" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Please wait a second"),
  );
  await user.click(screen.getByRole("tab", { name: "Edit" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Please wait a second");
  expect(screen.getByRole("alert")).not.toHaveTextContent(
    "Reload the saved Canvas before editing",
  );
  expect(screen.getByRole("button", { name: "Save Canvas" })).toBeEnabled();
});
it("prevents all dismissal during restore and ignores a history response from an unmounted panel", async () => {
  const user = userEvent.setup();
  const { canvas, close } = historyFixture();
  await openHistory(user);
  let release!: (event: typeof head) => void;
  const pending = new Promise<typeof head>((resolve) => {
    release = resolve;
  });
  canvas.save.mockReturnValueOnce(pending);
  try {
    await user.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    await user.click(screen.getByRole("button", { name: "Restore version" }));
    await waitFor(() => expect(canvas.save).toHaveBeenCalledOnce());
    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("dialog", { name: "Restore this version?" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(close).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      release(restored);
      await pending;
    });
  }
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Restore this version?" }),
    ).not.toBeInTheDocument(),
  );
  await user.click(screen.getByRole("tab", { name: "Edit" }));
  let finish!: (page: { revisions: (typeof head)[]; next: undefined }) => void;
  const stale = new Promise<{ revisions: (typeof head)[]; next: undefined }>(
    (resolve) => {
      finish = resolve;
    },
  );
  canvas.history.mockReturnValueOnce(stale);
  await user.click(screen.getByRole("tab", { name: "History" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Loading history"),
  );
  await user.click(screen.getByRole("tab", { name: "Edit" }));
  canvas.history.mockResolvedValueOnce({
    revisions: [restored],
    next: undefined,
  });
  await user.click(screen.getByRole("tab", { name: "History" }));
  await screen.findByRole("radio", { name: /Current/ });
  await act(async () => {
    finish({ revisions: [old], next: undefined });
    await stale;
  });
  expect(screen.getByRole("radio", { name: /Current/ })).toBeChecked();
  expect(
    screen.getByRole("textbox", { name: "Revision Markdown" }),
  ).toHaveValue(restored.content);
});

it("offers a Map tab only while the draft has a map block", async () => {
  const user = userEvent.setup();
  fixture();
  const editor = await screen.findByLabelText("Canvas Markdown");
  await waitFor(() => expect(editor).toBeEnabled());
  expect(screen.queryByRole("tab", { name: "Map" })).not.toBeInTheDocument();
  fireEvent.change(editor, {
    target: { value: '```map\n{ "center": [200, 0] }\n```' },
  });
  await user.click(screen.getByRole("tab", { name: "Map" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "center must be [lng, lat].",
  );
  await user.click(screen.getByRole("tab", { name: "Edit" }));
  fireEvent.change(editor, { target: { value: "No map" } });
  expect(screen.queryByRole("tab", { name: "Map" })).not.toBeInTheDocument();
});
