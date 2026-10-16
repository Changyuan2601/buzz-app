// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, useRef, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ResizeHandle } from "./ResizeHandle";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function workspace(direction: 1 | -1) {
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 260,
  } as DOMRect);
  const commit = vi.fn();
  let refresh = () => {};
  function Workspace() {
    const target = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(260);
    const [, bump] = useState(0);
    refresh = () => bump((count) => count + 1);
    const handle = (
      <ResizeHandle
        width={width}
        setWidth={(next) => {
          commit(next);
          setWidth(next);
        }}
        min={220}
        max={520}
        reset={() => setWidth(260)}
        label="Resize"
        direction={direction}
        {...(direction === -1
          ? { target, property: "--secondary-panel-width" }
          : {})}
      />
    );
    return direction === 1 ? (
      <>
        <div data-testid="target" style={{ width }} />
        {handle}
      </>
    ) : (
      <div
        ref={target}
        data-testid="target"
        style={
          { "--secondary-panel-width": `${width}px` } as React.CSSProperties
        }
      >
        <section>{handle}</section>
      </div>
    );
  }
  const view = render(
    <StrictMode>
      <Workspace />
    </StrictMode>,
  );
  const handle = screen.getByRole("separator");
  const target = screen.getByTestId("target");
  const property = direction === 1 ? "width" : "--secondary-panel-width";
  const pointer = (type: string, x: number, id = 1) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      button: 0,
    });
    Object.defineProperty(event, "pointerId", { value: id });
    fireEvent(type === "pointerdown" ? handle : window, event);
  };
  const frame = () =>
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });
  return {
    view,
    handle,
    target,
    property,
    pointer,
    frame,
    frames,
    commit,
    refresh: () => act(refresh),
  };
}

test.each([1, -1] as const)(
  "direction %s previews the newest width once per frame and commits only on release",
  (direction) => {
    const w = workspace(direction);
    w.pointer("pointerdown", 400);
    w.pointer("pointermove", 400 + direction * 20);
    w.pointer("pointermove", 400 + direction * 80);
    expect(w.commit).not.toHaveBeenCalled();
    expect(w.target.style.getPropertyValue(w.property)).toBe("260px");
    expect(w.frames.size).toBe(1);
    w.frame();
    expect(w.target.style.getPropertyValue(w.property)).toBe("340px");
    w.refresh();
    expect(w.target.style.getPropertyValue(w.property)).toBe("340px");
    w.pointer("pointerup", 400 + direction * 90);
    expect(w.commit).toHaveBeenCalledExactlyOnceWith(350);
    expect(w.target.style.getPropertyValue(w.property)).toBe("350px");
    expect(w.frames.size).toBe(0);
    expect(document.documentElement).not.toHaveAttribute(
      "data-sidebar-resizing",
    );
  },
);

test.each([1, -1] as const)(
  "direction %s clamps previews, ignores other pointers and flushes a pending final move",
  (direction) => {
    const w = workspace(direction);
    w.pointer("pointerdown", 400);
    w.pointer("pointermove", 400 + direction * 1000, 2);
    w.pointer("pointerup", 400 + direction * 1000, 2);
    expect(w.frames.size).toBe(0);
    expect(w.commit).not.toHaveBeenCalled();
    w.pointer("pointermove", 400 + direction * 1000);
    w.frame();
    expect(w.target.style.getPropertyValue(w.property)).toBe("520px");
    w.pointer("pointermove", 400 - direction * 1000);
    w.pointer("pointerup", 400 - direction * 1000);
    expect(w.commit).toHaveBeenCalledExactlyOnceWith(220);
    expect(w.target.style.getPropertyValue(w.property)).toBe("220px");
    expect(w.frames.size).toBe(0);
  },
);

test.each(["pointercancel", "blur", "unmount"])(
  "%s restores preview and cancels pending work without committing",
  (end) => {
    const w = workspace(-1);
    w.pointer("pointerdown", 400);
    w.pointer("pointermove", 320);
    w.frame();
    expect(w.target.style.getPropertyValue(w.property)).toBe("340px");
    w.pointer("pointermove", 300);
    if (end === "unmount") w.view.unmount();
    else if (end === "blur") fireEvent(window, new Event("blur"));
    else w.pointer(end, 300);
    w.frame();
    expect(w.commit).not.toHaveBeenCalled();
    expect(w.target.style.getPropertyValue(w.property)).toBe("260px");
    expect(document.documentElement).not.toHaveAttribute(
      "data-sidebar-resizing",
    );
    expect(document.body.style.userSelect).toBe("");
  },
);

test.each([1, -1] as const)(
  "direction %s leaves width intent unchanged without horizontal movement",
  (direction) => {
    const w = workspace(direction);
    w.pointer("pointerdown", 400);
    w.pointer("pointerup", 400);
    expect(w.commit).not.toHaveBeenCalled();
    w.pointer("pointerdown", 400);
    w.pointer("pointermove", 400);
    w.frame();
    w.pointer("pointerup", 400);
    expect(w.commit).not.toHaveBeenCalled();
    expect(w.target.style.getPropertyValue(w.property)).toBe("260px");
  },
);

test.each([1, -1] as const)(
  "direction %s commits horizontal movement first reported on release",
  (direction) => {
    const w = workspace(direction);
    w.pointer("pointerdown", 400);
    w.pointer("pointerup", 400 + direction * 30);
    expect(w.commit).toHaveBeenCalledExactlyOnceWith(290);
  },
);
