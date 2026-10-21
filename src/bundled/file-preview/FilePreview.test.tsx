// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationService } from "../../features/conversation/service";
import { PanelsService } from "../../features/panels/service";
import { PanelView } from "../../features/panels/PanelView";
import { MessageRow } from "../../features/messages/MessageRow";
import { ComposerAttachmentViewer } from "../../features/messages/ComposerAttachmentViewer";
import { TargetOpenerProvider } from "../../features/conversation/opener";
import type {
  Attachment,
  ChannelMessage,
} from "../../features/relay/contracts";
import { PluginRuntime } from "../../plugins/runtime";
import { FilePreviewPanel } from "./FilePreviewPanel";
import * as plugin from "./index";
import manifest from "./manifest.json";
import { previewTarget } from "./preview";

const attachment: Attachment = {
  kind: "file",
  url: "https://relay.test/media/notes",
  name: "notes.md",
  mime: "text/plain",
  size: 132,
};
const source = "/api/relay/media?url=https%3A%2F%2Frelay.test%2Fmedia%2Fnotes";
const row: ChannelMessage = {
  id: "message",
  channelId: "channel",
  authorId: "author",
  createdAt: 1,
  content: "",
  attachments: [attachment],
  mentions: [],
  participants: [],
  reactions: [],
  replyCount: 0,
};
const disposals: (() => Promise<void>)[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  cleanup();
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

async function pluginFixture() {
  const root = new Context();
  const runtime = new PluginRuntime(root, async () => plugin);
  const conversation = new ConversationService(root);
  const panels = new PanelsService(root);
  disposals.push(async () => {
    await runtime.dispose();
    await root.fiber.dispose();
  });
  runtime.reconcile([
    {
      manifest: { ...manifest, apiVersion: 1 },
      source: "bundled",
      revision: "one",
      enabled: true,
      previous: null,
      reloadable: false,
      error: null,
    },
  ]);
  await waitFor(() =>
    expect(runtime.snapshot()[manifest.id]?.status).toBe("active"),
  );
  return { runtime, conversation, panels };
}

it("opens a registered Markdown preview from the real message row and restores download on plugin removal", async () => {
  const { runtime, conversation, panels } = await pluginFixture();
  const response = deferred<Response>();
  const fetch = vi.fn<typeof globalThis.fetch>(() => response.promise);
  vi.stubGlobal("fetch", fetch);
  const open = vi.fn<(target: string) => boolean>(() => true);
  render(
    <MessageRow
      row={{
        ...row,
        attachments: [
          attachment,
          {
            ...attachment,
            url: "https://relay.test/media/large",
            name: "large.md",
            size: 100_001,
          },
          {
            ...attachment,
            url: "https://relay.test/media/pdf",
            name: "report.pdf",
            mime: "application/pdf",
          },
        ],
      }}
      profile={undefined}
      media={() => source}
      day={false}
      retry={undefined}
      extensions={conversation}
      canOpenLink={(target) => !!panels.resolve(target)}
      onOpenLink={open}
    />,
  );
  expect(
    screen.getByRole("link", { name: "Download report.pdf" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Download large.md" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Preview large.md" })).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "Preview notes.md" }),
  );
  const [target] = open.mock.calls[0] ?? [];
  if (typeof target !== "string") throw new Error("No preview opened");
  const panel = panels.resolve(target);
  if (!panel) throw new Error("No preview panel registered");
  const view = render(
    <PanelView panel={panel} target={target} close={() => {}} />,
  );
  const preview = screen.getByRole("region", { name: "Preview: notes.md" });
  expect(within(preview).getByText("Markdown · 132 B")).toBeInTheDocument();
  expect(within(preview).getByRole("status")).toHaveTextContent(
    "Loading preview",
  );
  expect(
    within(preview).getByRole("link", { name: "Download notes.md" }),
  ).toHaveAttribute("href", source);
  await act(async () =>
    response.resolve(
      new Response(
        [
          "# Project notes",
          "",
          "| Task | Status |",
          "| --- | --- |",
          "| Preview | Done |",
          "",
          "```js",
          "const ok = true;",
          "```",
          "",
          "[Safe](https://example.com) [Unsafe](javascript:alert%281%29)",
          "",
          "![Diagram](https://example.com/tracker.png)",
          "<iframe src='https://example.com'></iframe>",
        ].join("\n"),
      ),
    ),
  );
  expect(
    await within(preview).findByRole("heading", { name: "Project notes" }),
  ).toBeVisible();
  expect(within(preview).getByRole("table")).toHaveTextContent("PreviewDone");
  expect(within(preview).getByText("const ok = true;")).toBeInTheDocument();
  expect(within(preview).getByRole("link", { name: "Safe" })).toHaveAttribute(
    "rel",
    "noreferrer",
  );
  expect(within(preview).queryByRole("link", { name: "Unsafe" })).toBeNull();
  expect(preview.querySelector("iframe, img")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
  view.unmount();
  act(() => runtime.reconcile([]));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Preview notes.md" }),
    ).toBeNull(),
  );
  expect(
    screen.getByRole("link", { name: "Download notes.md" }),
  ).toHaveAttribute("download", "notes.md");
});

it.each([
  ["TEXT/PLAIN; charset=utf-8", "Plain text"],
  [" text/markdown ", "Markdown"],
])(
  "uses the resolved format for %s file and panel labels",
  async (mime, label) => {
    const { conversation, panels } = await pluginFixture();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("")));
    const open = vi.fn<(target: string) => boolean>(() => true);
    render(
      <MessageRow
        row={{ ...row, attachments: [{ ...attachment, name: "notes", mime }] }}
        profile={undefined}
        media={() => source}
        day={false}
        retry={undefined}
        extensions={conversation}
        canOpenLink={(target) => !!panels.resolve(target)}
        onOpenLink={open}
      />,
    );
    expect(screen.getByText(`${label} · 132 B`)).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Preview notes", exact: true }),
    );
    const target = open.mock.calls[0]?.[0];
    if (!target) throw new Error("No preview opened");
    const panel = panels.resolve(target);
    if (!panel) throw new Error("No preview panel registered");
    render(<PanelView panel={panel} target={target} close={() => {}} />);
    const preview = screen.getByRole("region", {
      name: "Preview: notes",
      exact: true,
    });
    expect(within(preview).getByText(`${label} · 132 B`)).toBeVisible();
    await within(preview).findByText("This file is empty.");
  },
);

it("keeps uploaded composer attachments inside their existing modal without a second panel action", async () => {
  const { conversation, panels } = await pluginFixture();
  const open = vi.fn(() => true);
  render(
    <TargetOpenerProvider
      canOpen={(target) => !!panels.resolve(target)}
      open={open}
    >
      <ComposerAttachmentViewer
        items={[
          {
            id: "draft",
            file: new File(["# Notes"], "notes.md", { type: "text/markdown" }),
            status: "ready",
            uploaded: {
              url: attachment.url,
              name: "notes.md",
              type: "text/markdown",
              size: 7,
              sha256: "a".repeat(64),
            },
          },
        ]}
        selected="draft"
        select={() => {}}
        media={() => source}
        renderers={conversation.attachments}
        restoreFocus={{ current: null }}
        close={() => {}}
      />
    </TargetOpenerProvider>,
  );
  const modal = screen.getByRole("dialog", { name: "Attachment preview" });
  expect(
    within(modal).getByRole("link", { name: "Download notes.md" }),
  ).toBeInTheDocument();
  expect(
    within(modal).queryByRole("button", { name: "Preview notes.md" }),
  ).toBeNull();
  expect(open).not.toHaveBeenCalled();
});

it("retries a failed read and leaves plain text literal", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValueOnce(new Error("File unavailable"))
    .mockResolvedValueOnce(new Response("# This stays plain text"));
  vi.stubGlobal("fetch", fetch);
  render(
    <FilePreviewPanel
      target={previewTarget({ ...attachment, name: "notes.txt" }, source)}
      close={() => {}}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "File unavailable",
  );
  expect(
    screen.getByRole("link", { name: "Download notes.txt" }),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByText("# This stays plain text"),
  ).toBeInTheDocument();
  expect(screen.queryByRole("heading")).toBeNull();
});

it("aborts retired reads and ignores a stale response after switching files", async () => {
  const first = deferred<Response>();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValueOnce(new Response(""));
  vi.stubGlobal("fetch", fetch);
  const view = render(
    <FilePreviewPanel
      target={previewTarget(attachment, source)}
      close={() => {}}
    />,
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("status")).toHaveTextContent("Loading preview");
  const signal = fetch.mock.calls[0]?.[1]?.signal;
  view.rerender(
    <FilePreviewPanel
      target={previewTarget(
        { ...attachment, name: "empty.txt" },
        `${source}&second=1`,
      )}
      close={() => {}}
    />,
  );
  expect(signal?.aborted).toBe(true);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "This file is empty",
  );
  await act(async () => first.resolve(new Response("# Stale content")));
  expect(screen.getByRole("status")).toHaveTextContent("This file is empty");
  expect(screen.queryByText("Stale content")).toBeNull();
});
