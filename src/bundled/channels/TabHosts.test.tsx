// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { PanelDock } from "../../features/panels/PanelDock";
import { TabSlot, retain } from "./TabHosts";

afterEach(cleanup);

// The dock retains exit content after its last tab moves away. Its late
// cleanup must not detach content already claimed by the destination slot.
test("moving the last side tab retains its content after the closing dock retires", async () => {
  const node = document.createElement("div");
  node.textContent = "Thread and unfinished reply";
  function Fixture({ moved }: { moved: boolean }) {
    return (
      <>
        <section aria-label="Main pane">
          {moved && <TabSlot node={node} />}
        </section>
        <PanelDock open={!moved} className={undefined}>
          {!moved && <TabSlot node={node} />}
        </PanelDock>
      </>
    );
  }
  const view = render(<Fixture moved={false} />);
  expect(node.isConnected).toBe(true);
  view.rerender(<Fixture moved />);
  await waitFor(() =>
    expect(document.querySelector("[data-panel-dock]")).toBeNull(),
  );
  expect(screen.getByRole("region", { name: "Main pane" })).toContainElement(
    node,
  );
  expect(node).toBeVisible();
});

// A retained tab leaves its pane as it closes, while layout is still clean,
// and keeps its reading position for the slot that attaches it again.
test("a retained tab reattaches at the offsets it closed with", () => {
  const node = document.createElement("div");
  const scroller = document.createElement("div");
  scroller.dataset.messageScroller = "";
  let top = 600;
  Object.defineProperties(scroller, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 400 },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    },
  });
  node.append(scroller);
  const view = render(<TabSlot node={node} />);
  expect(retain(node)).toBe(true);
  expect(node.isConnected).toBe(false);
  view.rerender(<></>);
  // Detaching resets a real scroller's offset.
  top = 0;
  view.rerender(<TabSlot node={node} />);
  expect(node.isConnected).toBe(true);
  expect(top).toBe(600);
  top = 100;
  expect(retain(node)).toBe(false);
  expect(node.isConnected).toBe(true);
});
