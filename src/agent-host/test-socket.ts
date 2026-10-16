// A relay connection a test answers by hand, for the agent feed.
/** A relay connection the test answers by hand. */
export class FakeSocket {
  static readonly OPEN = 1;
  static last: FakeSocket | undefined;
  readyState = 0;
  readonly sent: unknown[][] = [];
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(text: string) {
    this.sent.push(JSON.parse(text) as unknown[]);
  }
  close() {}
  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  opened() {
    this.readyState = FakeSocket.OPEN;
    this.emit("open");
  }
  receive(message: unknown[]) {
    this.emit("message", { data: JSON.stringify(message) });
  }
  reqs() {
    return this.sent.filter((message) => message[0] === "REQ");
  }
}

/** The id of the latest request for subscription `key`. */
export const latest = (socket: FakeSocket, key: string) => {
  const id = socket
    .reqs()
    .map((message) => String(message[1]))
    .filter((id) => id === key || id.startsWith(`${key}:`))
    .at(-1);
  if (!id) throw new Error(`No ${key} request`);
  return id;
};
/** The subscription keys of the requests sent, in order. */
export const asked = (socket: FakeSocket) =>
  socket.reqs().map((message) => String(message[1]).replace(/:\d+$/, ""));

/** The id of the login the feed sent. */
export const loginId = (socket: FakeSocket) => {
  const login = socket.sent.find((message) => message[0] === "AUTH");
  if (!login) throw new Error("No login sent");
  return (login[1] as { id: string }).id;
};
