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
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { keypair, signed } from "../../features/relay/testing";
import { readView, writeView } from "../../shared/view-state";
import { CanvasEditor } from "./CanvasEditor";
import type { ChannelCanvas } from "../../features/channel-templates/capability";

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
  render(
    <CanvasEditor
      canvas={canvas}
      profiles={profiles}
      scope={scope}
      channelId={channelId}
    />,
  );
  return { canvas };
}
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps editing after a save and uses the saved revision for the next edit", async () => {
  const user = userEvent.setup();
  const { canvas } = fixture();
  const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(text).toHaveValue("Saved"));
  expect(screen.queryByText("Current saved document")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", {
      name: /Load current|Reload saved Canvas|Retry loading/,
    }),
  ).not.toBeInTheDocument();
  const saved = { ...head, content: "Edited", id: "b".repeat(64) };
  canvas.save.mockResolvedValueOnce(saved);
  fireEvent.change(text, { target: { value: "Edited" } });
  await user.click(screen.getByRole("button", { name: "Save Canvas" }));
  await waitFor(() =>
    expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toBeNull(),
  );
  expect(text).toBeEnabled();
  expect(text).toHaveValue("Edited");
  expect(canvas.save).toHaveBeenCalledWith(channelId, "Edited", head.id);
  fireEvent.change(text, { target: { value: "Second edit" } });
  expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toEqual({
    content: "Second edit",
    base: saved.id,
  });
  await user.click(screen.getByRole("button", { name: "Save Canvas" }));
  await waitFor(() =>
    expect(canvas.save).toHaveBeenLastCalledWith(
      channelId,
      "Second edit",
      saved.id,
    ),
  );
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
      screen.getByRole("region", {
        name: "Channel Canvas",
      }),
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
    <CanvasEditor
      canvas={canvas}
      profiles={profiles}
      scope={scope}
      channelId={channelId}
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
  render(
    <StrictMode>
      <CanvasEditor
        canvas={canvas}
        profiles={profiles}
        scope={scope}
        channelId={channelId}
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
    await waitFor(() =>
      expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toBeNull(),
    );
    expect(canvas.save).toHaveBeenCalledWith(channelId, "New work", head.id);
  } finally {
    release(head);
  }
});

it("retains the draft after a failed save and keeps editing after a successful retry", async () => {
  const user = userEvent.setup();
  const { canvas } = fixture();
  const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(text).toHaveValue("Saved"));
  fireEvent.change(text, { target: { value: "Local draft" } });
  canvas.save.mockRejectedValueOnce(new Error("Offline: draft kept"));
  await user.click(screen.getByRole("button", { name: "Save Canvas" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Offline: draft kept",
  );
  expect(text).toHaveValue("Local draft");
  expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toEqual({
    content: "Local draft",
    base: head.id,
  });
  await user.click(screen.getByRole("button", { name: "Save Canvas" }));
  await waitFor(() =>
    expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toBeNull(),
  );
  expect(canvas.save).toHaveBeenLastCalledWith(
    channelId,
    "Local draft",
    head.id,
  );
  expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toBeNull();
});

function pendingSave(canvas: { save: ReturnType<typeof vi.fn> }) {
  let land!: (event: typeof head) => void;
  const pending = new Promise<typeof head>((resolve) => {
    land = resolve;
  });
  canvas.save.mockReturnValueOnce(pending);
  // The editor awaited this promise first, so its continuation has run once
  // a later await of the same promise resumes.
  return async (event: typeof head) => {
    land(event);
    await pending;
  };
}
async function saveThenClose(content: string) {
  const user = userEvent.setup();
  let land!: (event: typeof head) => Promise<void>;
  const { canvas } = fixture((canvas) => {
    land = pendingSave(canvas);
  });
  const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(text).toHaveValue("Saved"));
  fireEvent.change(text, { target: { value: content } });
  await user.click(screen.getByRole("button", { name: "Save Canvas" }));
  await waitFor(() => expect(canvas.save).toHaveBeenCalledOnce());
  // Closing the tab, changing channel or disabling the plugin unmounts it.
  cleanup();
  return land;
}
it("retires the saved draft when the editor closes before its save lands", async () => {
  const land = await saveThenClose("Edited");
  const saved = { ...head, content: "Edited", id: "b".repeat(64) };
  await land(saved);
  expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toBeNull();
  fixture((canvas) => canvas.read.mockResolvedValue(saved));
  const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(text).toHaveValue("Edited"));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Save Canvas" })).toBeEnabled();
});

it("keeps a reopened editor's draft when an earlier save lands after close", async () => {
  const land = await saveThenClose("Edited");
  fixture();
  const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(text).toBeEnabled());
  expect(text).toHaveValue("Edited");
  fireEvent.change(text, { target: { value: "Newer" } });
  await land({ ...head, content: "Edited", id: "b".repeat(64) });
  expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toEqual({
    content: "Newer",
    base: head.id,
  });
});

it("takes focus once loaded unless focus moved elsewhere meanwhile", async () => {
  for (const moved of [false, true]) {
    let finish!: (event: typeof head) => void;
    const reading = new Promise<typeof head>((resolve) => {
      finish = resolve;
    });
    const canvas = {
      available: true,
      history: vi.fn<ChannelCanvas["history"]>(),
      read: vi.fn(() => reading),
      save: vi.fn(async () => head),
    };
    render(
      <>
        <button type="button">Message composer</button>
        <CanvasEditor
          canvas={canvas}
          profiles={profiles}
          scope={scope}
          channelId={channelId}
        />
      </>,
    );
    const composer = screen.getByRole("button", { name: "Message composer" });
    if (moved) composer.focus();
    await act(async () => {
      finish(head);
      await reading;
    });
    const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
    await waitFor(() => expect(text).toBeEnabled());
    expect(moved ? composer : text).toHaveFocus();
    cleanup();
  }
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
it("retires an unchanged draft when the editor closes before a restore lands", async () => {
  const user = userEvent.setup();
  const { canvas } = historyFixture();
  const land = pendingSave(canvas);
  await openHistory(user);
  await user.click(
    screen.getByRole("button", { name: "Restore this version" }),
  );
  await user.click(screen.getByRole("button", { name: "Restore version" }));
  await waitFor(() => expect(canvas.save).toHaveBeenCalledOnce());
  cleanup();
  await land(restored);
  expect(readView(scope, `canvas-draft-v1:${channelId}`, null)).toBeNull();
  fixture((canvas) => canvas.read.mockResolvedValue(restored));
  const text = screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(text).toHaveValue(restored.content));
  expect(screen.queryByRole("alert")).toBeNull();
});
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
    const { canvas } = historyFixture();
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
  const { canvas } = historyFixture();
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
