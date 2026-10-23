// A relay connection a test answers by hand, for the app's live client
// (`subscribeRelayTraffic`) as the agent host runs it.
type Filter = Readonly<{ kinds?: number[]; "#h"?: string[] }>;

export class LiveSocket {
  readyState = 1;
  onmessage?: (event: { data: string }) => Promise<void>;
  onclose?: () => void;
  onerror?: () => void;
  readonly sent: unknown[][] = [];
  send(text: string) {
    this.sent.push(JSON.parse(text) as unknown[]);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  async receive(message: unknown[]) {
    await this.onmessage?.({ data: JSON.stringify(message) });
  }
  /** Asks for the login, accepts it, and gives back the login event. */
  async auth() {
    await this.receive(["AUTH", "challenge"]);
    const login = this.sent.find((message) => message[0] === "AUTH")?.[1] as
      | { id: string; pubkey: string; tags: string[][] }
      | undefined;
    if (!login) throw new Error("No login sent");
    await this.receive(["OK", login.id, true, ""]);
    return login;
  }
  /** The requests still open, by wire id. */
  private open() {
    const closed = new Set(
      this.sent.filter((message) => message[0] === "CLOSE").map((m) => m[1]),
    );
    return this.sent.filter(
      (message) => message[0] === "REQ" && !closed.has(message[1]),
    ) as [string, string, ...Filter[]][];
  }
  /** Ends the stored events of every open request: each is live. */
  async established() {
    for (const [, wire] of this.open()) await this.receive(["EOSE", wire]);
  }
  /** The wire ids of the open channel requests. */
  channelWires() {
    return this.open()
      .filter((message) =>
        (message.slice(2) as Filter[]).some((filter) => filter["#h"]),
      )
      .map((message) => message[1]);
  }
  /** The channels the open requests hear. */
  channels() {
    return [
      ...new Set(
        this.open().flatMap((message) =>
          (message.slice(2) as Filter[]).flatMap(
            (filter) => filter["#h"] ?? [],
          ),
        ),
      ),
    ].sort();
  }
  /** The wire id of the open global request `name`: `membership` hears the
   * relay's membership notices. */
  wire(name: "membership" | "profiles") {
    const kind = name === "membership" ? 44100 : 0;
    const found = this.open().find((message) =>
      (message.slice(2) as Filter[]).some((filter) =>
        filter.kinds?.includes(kind),
      ),
    );
    if (!found) throw new Error(`No ${name} request`);
    return found[1];
  }
}
