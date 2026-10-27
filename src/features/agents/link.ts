// The link between the agents' two owners: the Manager, which the screens use,
// and the Runner, which runs agents. They may run in different pages, so only
// JSON data crosses: no functions, no shared objects. Each side serves named
// topics, values the other side watches and is sent again when they change,
// and named commands, which answer one call. Either side may serve both.
//
// Either page may reload. Each side says hello with a new instance when it
// starts. A side that hears a new instance from its peer watches again what
// it watched, ends the calls it was waiting on, and stops serving what the
// old peer watched.

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

/** A `MessagePort`, or a link to a page in another webview. It delivers each
 * message once, in the order sent. */
export type LinkPort = {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
};

/** A value the other side can watch, for one set of arguments. */
export type Topic = (args: Json) => Readonly<{
  get(): Json;
  subscribe(listener: () => void): () => void;
}>;
export type Command = (args: Json) => Json | Promise<Json>;
export type Served = Readonly<{
  topics?: Readonly<Record<string, Topic>>;
  commands?: Readonly<Record<string, Command>>;
}>;

type Frame =
  | Readonly<{ kind: "hello"; instance: string }>
  | Readonly<{
      kind: "watch";
      from: string;
      key: string;
      topic: string;
      args: Json;
    }>
  | Readonly<{ kind: "unwatch"; from: string; key: string }>
  | Readonly<{
      kind: "call";
      from: string;
      id: number;
      command: string;
      args: Json;
    }>
  // What a side sends for a watch or call names the instance it is for, so a
  // page that reloaded does not take what was meant for its last load.
  | Readonly<{ kind: "value"; for: string; key: string; value: Json }>
  | Readonly<{ kind: "result"; for: string; id: number; value: Json }>
  | Readonly<{ kind: "error"; for: string; id: number; message: string }>;

const keyOf = (topic: string, args: Json) => `${topic}:${JSON.stringify(args)}`;
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export type Link = ReturnType<typeof link>;

/** One side of the link over `port`, serving `served` to the other side. */
export function link(port: LinkPort, served: Served = {}) {
  const instance = crypto.randomUUID();
  let peer: string | undefined;
  let closed = false;
  const post = (frame: Frame) => {
    if (!closed) port.postMessage(frame);
  };

  // What this side watches of the other's.
  const watched = new Map<
    string,
    {
      topic: string;
      args: Json;
      value: Json | undefined;
      listeners: Set<() => void>;
    }
  >();
  // What this side serves to the other's watches.
  const serving = new Map<
    string,
    Readonly<{ watcher: string; stop(): void }>
  >();
  const calls = new Map<
    number,
    Readonly<{ resolve(value: Json): void; reject(error: Error): void }>
  >();
  let next = 0;

  const stopServing = () => {
    for (const { stop } of serving.values()) stop();
    serving.clear();
  };
  const serve = (watcher: string, key: string, name: string, args: Json) => {
    serving.get(key)?.stop();
    const topic = served.topics?.[name];
    if (!topic) {
      console.warn(`The agents link has no topic ${name}`);
      return;
    }
    const source = topic(args);
    let sent: string | undefined;
    let queued = false;
    const send = () => {
      queued = false;
      if (serving.get(key) !== entry) return;
      const value = source.get();
      const json = JSON.stringify(value);
      // Several changes in one task are one message, and none is sent for a
      // change that leaves the value as it was.
      if (json === sent) return;
      sent = json;
      post({ kind: "value", for: watcher, key, value });
    };
    const unsubscribe = source.subscribe(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(send);
    });
    const entry = Object.freeze({
      watcher,
      stop() {
        unsubscribe();
        if (serving.get(key) === entry) serving.delete(key);
      },
    });
    serving.set(key, entry);
    send();
  };
  const answer = async (
    asker: string,
    id: number,
    name: string,
    args: Json,
  ) => {
    try {
      const command = served.commands?.[name];
      if (!command) throw new Error(`The agents link has no command ${name}`);
      const value = (await command(args)) ?? null;
      post({ kind: "result", for: asker, id, value });
    } catch (error) {
      post({ kind: "error", for: asker, id, message: messageOf(error) });
    }
  };
  // The other side reloaded or started: what it watched and was owed is
  // gone with its last page.
  const meet = (other: string) => {
    const reloaded = peer !== undefined;
    peer = other;
    // It may not have heard this side's hello.
    post({ kind: "hello", instance });
    // What was sent before the first hello reached the page that answers it;
    // what was sent to a page that reloaded did not.
    if (!reloaded) return;
    stopServing();
    for (const pending of calls.values())
      pending.reject(new Error("The agents page reloaded"));
    calls.clear();
    for (const [key, { topic, args }] of watched)
      post({ kind: "watch", from: instance, key, topic, args });
  };

  port.onmessage = ({ data }: MessageEvent<Frame>) => {
    if (closed) return;
    switch (data.kind) {
      case "hello":
        if (data.instance !== peer) meet(data.instance);
        return;
      case "watch":
        serve(data.from, data.key, data.topic, data.args);
        return;
      case "unwatch": {
        const entry = serving.get(data.key);
        if (entry?.watcher === data.from) entry.stop();
        return;
      }
      case "value": {
        if (data.for !== instance) return;
        const entry = watched.get(data.key);
        if (!entry) return;
        entry.value = data.value;
        for (const listener of [...entry.listeners]) listener();
        return;
      }
      case "call":
        void answer(data.from, data.id, data.command, data.args);
        return;
      case "result":
        if (data.for !== instance) return;
        calls.get(data.id)?.resolve(data.value);
        calls.delete(data.id);
        return;
      case "error":
        if (data.for !== instance) return;
        calls.get(data.id)?.reject(new Error(data.message));
        calls.delete(data.id);
        return;
    }
  };
  post({ kind: "hello", instance });

  return {
    /** The value of the other side's `topic`, as last sent, while watched. */
    read(topic: string, args: Json = null): Json | undefined {
      return watched.get(keyOf(topic, args))?.value;
    },
    /** Watches the other side's `topic` until the returned stop. */
    watch(topic: string, args: Json, listener: () => void) {
      const key = keyOf(topic, args);
      let entry = watched.get(key);
      if (!entry) {
        entry = { topic, args, value: undefined, listeners: new Set() };
        watched.set(key, entry);
        post({ kind: "watch", from: instance, key, topic, args });
      }
      const listeners = entry.listeners;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size || watched.get(key)?.listeners !== listeners) return;
        watched.delete(key);
        post({ kind: "unwatch", from: instance, key });
      };
    },
    /** Calls the other side's `command`. */
    call(command: string, args: Json = null): Promise<Json> {
      if (closed) return Promise.reject(new Error("The agents link is closed"));
      const id = ++next;
      return new Promise<Json>((resolve, reject) => {
        calls.set(id, { resolve, reject });
        post({ kind: "call", from: instance, id, command, args });
      });
    },
    close() {
      if (closed) return;
      closed = true;
      stopServing();
      for (const pending of calls.values())
        pending.reject(new Error("The agents link is closed"));
      calls.clear();
      watched.clear();
      port.onmessage = null;
      port.close();
    },
  };
}
