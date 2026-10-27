// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
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
