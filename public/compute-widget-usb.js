/** Repaints the widget's frames in the device's dark palette before streaming. */
export function attachUsbDisplay(button, status) {
  if (new URLSearchParams(location.search).get("embedded") === "true") return;
  const invoke =
    window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) return;
  const canvas = document.getElementById("display");
  button.disabled = false;
  status.textContent = "Connect your display with USB.";
  const target = document.createElement("canvas");
  target.width = target.height = 128;
  target.className = "dark";
  target.style.display = "none";
  document.body.append(target);
  const context = target.getContext("2d", { willReadFrequently: true });
  let connected = false;
  let controlBusy = false;
  let frameBusy = false;
  let lastSent = -Infinity;
  let disposed = false;
  let epoch = 0;
  const reset = () => {
    connected = false;
    button.textContent = "Connect USB";
    button.title = "";
    status.textContent = "Connect your display with USB.";
    button.setAttribute("aria-label", "Connect USB compute display");
  };
  const fail = (error) => {
    reset();
    button.textContent = "Retry USB";
    status.textContent = String(error);
    button.title = String(error);
    button.setAttribute("aria-label", `USB display: ${error}. Try again`);
  };
  const toggle = async () => {
    if (controlBusy) return;
    controlBusy = true;
    button.disabled = true;
    const current = ++epoch;
    try {
      if (connected) {
        reset();
        await invoke("mesh_compute_widget_usb_disconnect");
      } else {
        button.textContent = "Connecting…";
        status.textContent = "Connecting to your display…";
        const port = await invoke("mesh_compute_widget_usb_connect");
        if (disposed || current !== epoch) return;
        connected = true;
        button.textContent = "Disconnect USB";
        status.textContent = `Connected: ${port}`;
        button.title = port;
        button.setAttribute("aria-label", "Disconnect USB compute display");
      }
    } catch (error) {
      if (!disposed && current === epoch) fail(error);
    } finally {
      controlBusy = false;
      button.disabled = false;
    }
  };
  button.addEventListener("click", toggle);
  const send = async (event) => {
    const now = performance.now();
    if (
      !connected ||
      controlBusy ||
      frameBusy ||
      disposed ||
      now - lastSent < 1000 / 15
    )
      return;
    frameBusy = true;
    lastSent = now;
    const current = epoch;
    try {
      event.detail.paint(context, 128, 128, getComputedStyle(target));
      const rgba = context.getImageData(0, 0, 128, 128).data;
      const pixels = new Uint8Array(32768);
      for (let pixel = 0; pixel < 16384; pixel++) {
        const offset = pixel * 4;
        const rgb =
          ((rgba[offset] >> 3) << 11) |
          ((rgba[offset + 1] >> 2) << 5) |
          (rgba[offset + 2] >> 3);
        pixels[pixel * 2] = rgb & 255;
        pixels[pixel * 2 + 1] = rgb >> 8;
      }
      await invoke("mesh_compute_widget_usb_frame", {
        pixels: btoa(String.fromCharCode(...pixels)),
      });
    } catch (error) {
      if (!disposed && current === epoch) {
        fail(error);
        invoke("mesh_compute_widget_usb_disconnect").catch(() => {});
      }
    } finally {
      frameBusy = false;
    }
  };
  canvas.addEventListener("compute-frame", send);
  const dispose = () => {
    disposed = true;
    epoch++;
    canvas.removeEventListener("compute-frame", send);
    invoke("mesh_compute_widget_usb_disconnect").catch(() => {});
    button.removeEventListener("click", toggle);
    target.remove();
  };
  window.addEventListener("pagehide", dispose, { once: true });
  return dispose;
}
