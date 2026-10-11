import { Channel, invoke } from "@tauri-apps/api/core";
import type { LiveSocket } from "./live";

/** No reconnect policy here. live.ts owns connection generations and NIP-42. */
export class NativeSocket implements LiveSocket {
  readyState = 0;
  readonly connectionTimeoutMs = 180000;
  onopen: LiveSocket["onopen"] = null;
  onmessage: LiveSocket["onmessage"] = null;
  onerror: LiveSocket["onerror"] = null;
  onclose: LiveSocket["onclose"] = null;
  private readonly id = crypto.randomUUID();
  private browser?: WebSocket;
  private closed = false;
  constructor(private readonly url: string) {
    void this.connect();
  }
  private async connect() {
    try {
      const onEvent = new Channel<
        { type: "text"; data: string } | { type: "closed" }
      >((event) => {
        if (this.closed) return;
        if (event.type === "text")
          this.onmessage?.(new MessageEvent("message", { data: event.data }));
        else this.finish();
      });
      const mode = await invoke<"public" | "native">("relay_socket_connect", {
        id: this.id,
        relay: this.url,
        onEvent,
      });
      if (this.closed) {
        void invoke("relay_socket_close", { id: this.id }).catch(() => {});
        return;
      }
      if (mode === "public") {
        // Native discovery explicitly admitted a valid non-FI community.
        const ws = new WebSocket(this.url);
        this.browser = ws;
        ws.onopen = (event) => {
          if (!this.closed) {
            this.readyState = 1;
            this.onopen?.(event);
          }
        };
        ws.onmessage = (event) => {
          if (!this.closed) return this.onmessage?.(event);
        };
        ws.onerror = (event) => {
          if (!this.closed) this.onerror?.(event);
        };
        ws.onclose = () => this.finish();
      } else {
        this.readyState = 1;
        this.onopen?.(new Event("open"));
        await invoke("relay_socket_start", { id: this.id });
      }
    } catch (error) {
      if (this.closed) return;
      const event = Object.assign(new Event("error"), {
        terminal: true,
        message:
          typeof error === "string"
            ? error
            : "Native relay connection unavailable",
      });
      this.onerror?.(event);
      this.finish();
    }
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error("Socket is not open");
    if (this.browser) this.browser.send(data);
    else
      void invoke("relay_socket_send", { id: this.id, data }).catch(() =>
        this.finish(),
      );
  }
  private finish() {
    if (this.closed) return;
    this.close();
    this.onclose?.(new CloseEvent("close"));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.browser?.close();
    void invoke("relay_socket_close", { id: this.id }).catch(() => {});
  }
}
export const nativeSocket = (url: string): LiveSocket => new NativeSocket(url);
