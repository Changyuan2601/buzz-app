import { expect, it } from "vitest";
import { createBrowserHistory } from "./browser-history";
import { createNavigationController } from "./controller";
import { homeTarget } from "./history";

const settings = {
  version: 1,
  kind: "settings",
  section: "appearance",
} as const;
const hash = (target: unknown) =>
  `#buzz=${encodeURIComponent(JSON.stringify(target))}`;
function browser(initialHash = "") {
  const events = new EventTarget();
  let entries = [{ state: null as unknown, hash: initialHash }],
    index = 0;
  const location = { pathname: "/", search: "", hash: initialHash };
  const storage = new Map<string, string>();
  const history = {
    get state() {
      return entries[index]?.state;
    },
    replaceState(state: unknown, _title: string, url?: string) {
      if (url) location.hash = new URL(url, "https://app.example").hash;
      entries[index] = { state, hash: location.hash };
    },
    pushState(state: unknown, _title: string, url: string) {
      entries = entries.slice(0, index + 1);
      location.hash = new URL(url, "https://app.example").hash;
      entries.push({ state, hash: location.hash });
      index++;
    },
    back() {
      traverse(-1);
    },
    forward() {
      traverse(1);
    },
  };
  function notify() {
    events.dispatchEvent(new Event("popstate"));
    events.dispatchEvent(new Event("hashchange"));
  }
  function traverse(delta: number) {
    if (!entries[index + delta]) return;
    index += delta;
    location.hash = entries[index]?.hash ?? "";
    notify();
  }
  const host = {
    history,
    location,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  } as unknown as Window;
  return {
    host,
    edit(value: string) {
      history.pushState(null, "", `/${value}`);
      notify();
    },
    length: () => entries.length,
  };
}
it("adopts a hash edit exactly once, preserves visits and restores forward after reload", () => {
  const b = browser();
  const driver = createBrowserHistory(b.host);
  let notifications = 0;
  driver.attach(() => notifications++);
  const home = driver.snapshot().current.id;
  b.edit(hash(settings));
  expect(notifications).toBe(1);
  expect(b.length()).toBe(2);
  const opened = driver.snapshot().current;
  expect(opened.target).toEqual(settings);
  driver.back();
  expect(driver.snapshot().current.id).toBe(home);
  driver.dispose();
  const reloaded = createBrowserHistory(b.host);
  expect(reloaded.snapshot().canGoForward).toBe(true);
  reloaded.forward();
  expect(reloaded.snapshot().current).toEqual(opened);
  reloaded.dispose();
});
it("invalid addresses settle failure, including retry, until explicit navigation leaves them", async () => {
  const b = browser("#buzz=%7B");
  const controller = createNavigationController(createBrowserHistory(b.host));
  expect(controller.navigation.snapshot()).toMatchObject({
    status: "failed",
    reason: "invalid-target",
  });
  expect(await controller.navigation.retry()).toEqual({
    status: "failed",
    reason: "invalid-target",
  });
  const pending = controller.navigation.open(homeTarget);
  expect(controller.navigation.snapshot().status).toBe("opening");
  controller.complete(controller.navigation.snapshot().attempt, {
    status: "opened",
  });
  expect(await pending).toEqual({ status: "opened" });
  controller.navigation.back();
  expect(controller.navigation.snapshot()).toMatchObject({
    status: "failed",
    reason: "invalid-target",
  });
  controller.dispose();
});
it("the URL overrides a mismatched restored stamp", () => {
  const b = browser();
  createBrowserHistory(b.host).dispose();
  b.host.location.hash = hash(settings);
  const driver = createBrowserHistory(b.host);
  expect(driver.snapshot().current.target).toEqual(settings);
  driver.dispose();
});
it("driver attachment is exclusive even after detachment", () => {
  const b = browser();
  const driver = createBrowserHistory(b.host);
  driver.attach(() => {})();
  expect(() => driver.attach(() => {})).toThrow("already has an owner");
  driver.dispose();
});

it("resolving a visit rewrites its address without losing identity or the forward branch", () => {
  const b = browser();
  const driver = createBrowserHistory(b.host);
  const host = createNavigationController(driver);
  void host.navigation.open(settings);
  const forward = host.navigation.snapshot().entry;
  host.navigation.back();
  const current = host.navigation.snapshot().attempt;
  expect(
    host.resolve(current, { version: 1, kind: "settings", section: "profile" }),
  ).toBe(true);
  expect(host.navigation.snapshot().entry.id).toBe(current.entry.id);
  expect(host.navigation.snapshot().canGoForward).toBe(true);
  expect(b.length()).toBe(2);
  expect(b.host.location.hash).toBe(
    hash({ version: 1, kind: "settings", section: "profile" }),
  );
  host.navigation.forward();
  expect(host.navigation.snapshot().entry).toEqual(forward);
  host.dispose();
});
