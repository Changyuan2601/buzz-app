// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode, useEffect, useRef, useState } from "react";
import { afterEach, expect, it } from "vitest";
import {
  DetailTabContext,
  DetailTabSlot,
  type DetailTab,
} from "./DetailTabContext";
import { DetailsSheet } from "./DetailsSheet";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

it("keeps a reader's edited state through promotion, releases it on close, and reopens fresh", async () => {
  const pane = document.createElement("div");
  const composer = document.createElement("form");
  pane.append(composer);
  document.body.append(pane);
  const host = { pane, composer, viewport: pane, container: pane };
  function Reader() {
    const [draft, setDraft] = useState("");
    return (
      <textarea
        aria-label="Inspector draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    );
  }
  function Workspace() {
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState<DetailTab>();
    return (
      <DetailTabContext
        value={(next) => {
          setTab(next);
          return () => setTab(undefined);
        }}
      >
        <button type="button" onClick={() => setOpen(true)}>
          Open inspector
        </button>
        <DetailsSheet
          open={open}
          onOpenChange={setOpen}
          title="Inspector"
          host={host}
          readerOnly
        >
          <Reader />
        </DetailsSheet>
        {tab && (
          <section aria-label="Promoted inspector">
            <button type="button" onClick={tab.close}>
              Close inspector tab
            </button>
            <DetailTabSlot node={tab.node} />
          </section>
        )}
      </DetailTabContext>
    );
  }
  render(<Workspace />);
  expect(
    screen.queryByRole("textbox", { name: "Inspector draft" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open inspector" }));
  const draft = await screen.findByRole("textbox", { name: "Inspector draft" });
  fireEvent.change(draft, { target: { value: "Keep this unfinished work" } });
  expect(composer.inert).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Open as tab" }));
  expect(
    screen.getByRole("region", { name: "Promoted inspector" }),
  ).toContainElement(draft);
  expect(draft).toHaveValue("Keep this unfinished work");
  expect(composer.inert).not.toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Close inspector tab" }));
  await waitFor(() =>
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument(),
  );
  expect(
    screen.queryByRole("region", { name: "Promoted inspector" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open inspector" }));
  expect(
    await screen.findByRole("textbox", { name: "Inspector draft" }),
  ).toHaveValue("");
});

it("closes the other readers over its composer when one opens as a tab", async () => {
  const pane = document.createElement("div");
  const composer = document.createElement("form");
  pane.append(composer);
  document.body.append(pane);
  const host = { pane, composer, viewport: pane, container: pane };
  function Workspace() {
    const [details, setDetails] = useState(true);
    const [pull, setPull] = useState(true);
    const [tab, setTab] = useState<DetailTab>();
    return (
      <DetailTabContext
        value={(next) => {
          setTab(next);
          return () => setTab(undefined);
        }}
      >
        <DetailsSheet
          open={details}
          onOpenChange={setDetails}
          title="Details"
          host={host}
        >
          <p>Details body</p>
        </DetailsSheet>
        <DetailsSheet
          open={pull}
          onOpenChange={setPull}
          title="GitHub"
          host={host}
          readerOnly
        >
          <p>Pull body</p>
        </DetailsSheet>
        {tab && (
          <section aria-label="Promoted reader">
            <DetailTabSlot node={tab.node} />
          </section>
        )}
      </DetailTabContext>
    );
  }
  render(<Workspace />);
  expect(await screen.findAllByRole("dialog")).toHaveLength(2);
  const github = screen.getByRole("dialog", { name: "GitHub" });
  fireEvent.click(within(github).getByRole("button", { name: "Open as tab" }));
  await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));
  expect(
    screen.getByRole("region", { name: "Promoted reader" }),
  ).toHaveTextContent("Pull body");
});

it("mounts its content in the document, so content effects see the page", async () => {
  const pane = document.createElement("div");
  const composer = document.createElement("form");
  pane.append(composer);
  document.body.append(pane);
  const host = { pane, composer, viewport: pane, container: pane };
  // StrictMode replays effects at mount; a video that sees itself detached
  // then pauses for good, and layout reads measure nothing.
  const seen: boolean[] = [];
  function Content() {
    const ref = useRef<HTMLParagraphElement>(null);
    useEffect(() => {
      seen.push(!!ref.current?.isConnected);
    }, []);
    return <p ref={ref}>Reader body</p>;
  }
  render(
    <StrictMode>
      <DetailsSheet
        open
        onOpenChange={() => {}}
        title="Reader"
        host={host}
        readerOnly
      >
        <Content />
      </DetailsSheet>
    </StrictMode>,
  );
  expect(await screen.findByText("Reader body")).toBeInTheDocument();
  expect(seen.length).toBeGreaterThan(0);
  expect(seen).not.toContain(false);
});
