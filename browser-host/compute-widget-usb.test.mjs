// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { attachUsbDisplay } from "../public/compute-widget-usb.js";

let dispose;
const paint = vi.fn();
function attach() {
  return attachUsbDisplay(
    document.getElementById("usb-connect"),
    document.getElementById("usb-status"),
  );
}
function frameEvent() {
  return new CustomEvent("compute-frame", { detail: { paint } });
}
afterEach(() => {
  dispose?.();
  dispose = undefined;
  cleanup();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  delete window.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  paint.mockClear();
});

function fixture(invoke) {
  document.body.innerHTML =
    '<canvas id="display"></canvas><button id="usb-connect" aria-label="Connect USB compute display" disabled>Connect USB</button><p id="usb-status" role="status"></p>';
  window.__TAURI_INTERNALS__ = { invoke };
  const rgba = new Uint8ClampedArray(128 * 128 * 4);
  rgba.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    getImageData: () => ({ data: rgba }),
  });
  return document.getElementById("display");
}

it("connects explicitly and sends RGB565 frames without queueing while a write is pending", async () => {
  let release;
  const invoke = vi.fn((command) => {
    if (command.endsWith("_frame"))
      return new Promise((resolve) => {
        release = resolve;
      });
    return Promise.resolve("/dev/cu.usbmodem101");
  });
  const canvas = fixture(invoke);
  dispose = attach();
  const connect = screen.getByRole("button", {
    name: "Connect USB compute display",
  });
  expect(connect.textContent).toBe("Connect USB");
  expect(connect.disabled).toBe(false);
  fireEvent(canvas, frameEvent());
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Connect USB compute display" }),
  );
  await screen.findByRole("button", { name: "Disconnect USB compute display" });
  try {
    fireEvent(canvas, frameEvent());
    fireEvent(canvas, frameEvent());
    const writes = invoke.mock.calls.filter(([command]) =>
      command.endsWith("_frame"),
    );
    expect(writes).toHaveLength(1);
    expect(document.querySelector("canvas.dark").style.display).toBe("none");
    expect(paint).toHaveBeenCalledTimes(1);
    expect(paint.mock.calls[0].slice(1, 3)).toEqual([128, 128]);
    const data = Buffer.from(writes[0][1].pixels, "base64");
    expect(data.length).toBe(32768);
    expect([...data.subarray(0, 6)]).toEqual([0, 248, 224, 7, 31, 0]);
    fireEvent.click(
      screen.getByRole("button", { name: "Disconnect USB compute display" }),
    );
    await screen.findByRole("button", { name: "Connect USB compute display" });
    expect(invoke).toHaveBeenCalledWith("mesh_compute_widget_usb_disconnect");
  } finally {
    release();
  }
  await Promise.resolve();
});

it("shows retry on connection failure and releases the transport on disposal", async () => {
  const invoke = vi.fn((command) =>
    command.endsWith("_connect")
      ? Promise.reject("Firmware not found")
      : Promise.resolve(),
  );
  const canvas = fixture(invoke);
  dispose = attach();
  fireEvent.click(screen.getByRole("button"));
  await screen.findByRole("button", { name: /Firmware not found/ });
  expect(screen.getByRole("status").textContent).toBe("Firmware not found");
  dispose();
  dispose = undefined;
  expect(invoke).toHaveBeenCalledWith("mesh_compute_widget_usb_disconnect");
  fireEvent(canvas, frameEvent());
  expect(invoke.mock.calls.some(([name]) => name.endsWith("_frame"))).toBe(
    false,
  );
});

it("stops sending after USB failure and allows a fresh connection", async () => {
  const invoke = vi.fn((command) =>
    command.endsWith("_frame")
      ? Promise.reject("Unplugged")
      : Promise.resolve("port"),
  );
  const canvas = fixture(invoke);
  dispose = attach();
  fireEvent.click(screen.getByRole("button"));
  await screen.findByRole("button", { name: "Disconnect USB compute display" });
  fireEvent(canvas, frameEvent());
  await screen.findByRole("button", { name: /Unplugged/ });
  fireEvent.click(screen.getByRole("button"));
  await screen.findByRole("button", { name: "Disconnect USB compute display" });
});

it("does not open USB in embedded settings or a browser", () => {
  const invoke = vi.fn();
  fixture(invoke);
  window.history.replaceState(null, "", "?embedded=true");
  expect(attach()).toBeUndefined();
  window.history.replaceState(null, "", "/");
  delete window.__TAURI_INTERNALS__;
  expect(attach()).toBeUndefined();
  expect(invoke).not.toHaveBeenCalled();
});

it("does not revive a connection that resolves after disposal", async () => {
  let release;
  const invoke = vi.fn((command) =>
    command.endsWith("_connect")
      ? new Promise((resolve) => {
          release = resolve;
        })
      : Promise.resolve(),
  );
  const canvas = fixture(invoke);
  dispose = attach();
  fireEvent.click(screen.getByRole("button"));
  const button = screen.getByRole("button");
  expect(button.disabled).toBe(true);
  dispose();
  dispose = undefined;
  release("port");
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent(canvas, frameEvent());
  expect(invoke.mock.calls.some(([name]) => name.endsWith("_frame"))).toBe(
    false,
  );
});
