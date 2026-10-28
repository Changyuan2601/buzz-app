// @vitest-environment jsdom
import { useDraggable } from "@dnd-kit/core";
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { ChannelSidebarDnd } from "./ChannelSidebarDnd";

afterEach(cleanup);

it("keeps sidebar draggables out of re-renders that change no drag state", () => {
  let renders = 0;
  function Row() {
    renders++;
    const { setNodeRef } = useDraggable({ id: "alpha" });
    return <span ref={setNodeRef}>Alpha</span>;
  }
  // Children stay the same element, so only drag context can re-render a row.
  const rows = <Row />;
  let rerender = () => {};
  function Sidebar() {
    const [, setTick] = useState(0);
    rerender = () => setTick((tick) => tick + 1);
    return (
      <ChannelSidebarDnd
        writable
        onMove={() => {}}
        onReorder={() => {}}
        overlay={() => null}
      >
        {rows}
      </ChannelSidebarDnd>
    );
  }
  render(<Sidebar />);
  const before = renders;
  act(() => rerender());
  act(() => rerender());
  expect(renders).toBe(before);
});
