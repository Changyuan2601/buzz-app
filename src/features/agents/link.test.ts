import { afterEach, expect, it, vi } from "vitest";
import { type Json, type Link, link, type LinkPort, type Served } from "./link";

const open: Link[] = [];
afterEach(() => {
  for (const side of open.splice(0)) side.close();
});

/** A store a topic serves, as a side's own state would be. */
function store<T extends Json>(value: T) {
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The two ends of one channel, as two pages are. */
function pages() {
  const channel = new MessageChannel();
  const side = (port: LinkPort, served?: Served) => {
    const one = link(port, served);
    open.push(one);
    return one;
  };
  return {
    first: (served?: Served) => side(channel.port1, served),
    second: (served?: Served) => side(channel.port2, served),
  };
}

it("sends a watched topic's value, and again only when it changes", async () => {
  const count = store<number>(1);
  const { first, second } = pages();
  first({ topics: { count: () => count } });
  const runner = second();
  const heard = vi.fn();
  runner.watch("count", null, heard);
  await vi.waitFor(() => expect(runner.read("count")).toBe(1));
  heard.mockClear();
  count.set(2);
  count.set(3);
  await vi.waitFor(() => expect(runner.read("count")).toBe(3));
  // Two changes in one task are one message.
  expect(heard).toHaveBeenCalledTimes(1);
  count.set(3);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(heard).toHaveBeenCalledTimes(1);
});

it("serves a topic for each set of arguments, and stops when nobody watches", async () => {
  const subscribed = vi.fn();
  const stopped = vi.fn();
  const { first, second } = pages();
  first({
    topics: {
      double: (args) => ({
        get: () => (args as number) * 2,
        subscribe() {
          subscribed(args);
          return () => stopped(args);
        },
      }),
    },
  });
  const client = second();
  const stop = client.watch("double", 2, () => {});
  const again = client.watch("double", 2, () => {});
  client.watch("double", 5, () => {});
  await vi.waitFor(() => {
    expect(client.read("double", 2)).toBe(4);
    expect(client.read("double", 5)).toBe(10);
  });
  expect(subscribed.mock.calls).toEqual([[2], [5]]);
  stop();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(stopped).not.toHaveBeenCalled();
  again();
  await vi.waitFor(() => expect(stopped).toHaveBeenCalledWith(2));
  expect(client.read("double", 2)).toBeUndefined();
});

it("answers a command with its value or its error", async () => {
  const { first, second } = pages();
  first({
    commands: {
      add: (args) => {
        const [a, b] = args as [number, number];
        return a + b;
      },
      fail: async () => {
        throw new Error("No such agent on this device");
      },
    },
  });
  const client = second();
  await expect(client.call("add", [2, 3])).resolves.toBe(5);
  await expect(client.call("fail")).rejects.toThrow(
    "No such agent on this device",
  );
  await expect(client.call("missing")).rejects.toThrow(
    "The agents link has no command missing",
  );
});

it("either side serves, so each can watch and call the other", async () => {
  const records = store({ a: 1 });
  const status = store<string>("idle");
  const { first, second } = pages();
  const manager = first({ topics: { records: () => records } });
  const runner = second({
    topics: { status: () => status },
    commands: { ping: () => "pong" },
  });
  manager.watch("status", null, () => {});
  runner.watch("records", null, () => {});
  await vi.waitFor(() => {
    expect(manager.read("status")).toBe("idle");
    expect(runner.read("records")).toEqual({ a: 1 });
  });
  await expect(manager.call("ping")).resolves.toBe("pong");
});

/** Two ends whose second page can be replaced while the first keeps going. */
function reloading() {
  let to: MessagePort | undefined;
  const first: LinkPort = {
    onmessage: null,
    postMessage: (message) => to?.postMessage(message),
    close() {},
  };
  const load = (served?: Served) => {
    const channel = new MessageChannel();
    to = channel.port1;
    channel.port1.onmessage = (event) => first.onmessage?.(event);
    const page = link(channel.port2, served);
    open.push(page);
    return page;
  };
  return { first, load };
}

it("watches again, and ends its waiting calls, when the other page reloads", async () => {
  const { first, load } = reloading();
  const manager = link(first);
  open.push(manager);
  let release: (value: Json) => void = () => {};
  const old = load({
    topics: { status: () => store("old") },
    commands: { slow: () => new Promise<Json>((done) => (release = done)) },
  });
  manager.watch("status", null, () => {});
  await vi.waitFor(() => expect(manager.read("status")).toBe("old"));
  const waiting = manager.call("slow");
  await new Promise((resolve) => setTimeout(resolve, 10));
  load({ topics: { status: () => store("new") } });
  await expect(waiting).rejects.toThrow("The agents page reloaded");
  await vi.waitFor(() => expect(manager.read("status")).toBe("new"));
  // The old page's late answer reaches nobody.
  old.close();
  release(1);
});

it("does not answer a call for a page that has since reloaded", async () => {
  const { first, load } = reloading();
  let release: (value: Json) => void = () => {};
  const runner = link(first, {
    commands: {
      slow: () => new Promise<Json>((done) => (release = done)),
      fast: () => "fast",
    },
  });
  open.push(runner);
  const old = load();
  void old.call("slow").catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  const page = load();
  // The new page's first call has the same id as the old page's.
  const answer = page.call("fast");
  release("slow");
  await expect(answer).resolves.toBe("fast");
});
