import { expect, it, vi } from "vitest";
import type { Credential } from "./browser";
import { createOAuthSession } from "./session";
import type { CredentialStore } from "./store";
import { deferred } from "../test-helpers";

const credential: Credential = {
  value: "private-token",
  account: {
    subject: "user",
    email: "a@example.com",
    canUseRemoteAgents: true,
  },
};
it("keeps credentials outside UI snapshots and clears them on sign-out and disposal", async () => {
  const acquire = vi.fn(async () => credential);
  const session = createOAuthSession(acquire);
  const listener = vi.fn();
  const unsubscribe = session.subscribe(listener);
  await session.signIn();
  expect(session.snapshot()).toEqual({
    status: "signed-in",
    account: credential.account,
  });
  expect(session.credential()).toBe(credential);
  session.signOut();
  expect(() => session.credential()).toThrow("Sign in");
  expect(session.snapshot()).toEqual({ status: "signed-out" });
  expect(listener).toHaveBeenCalled();
  listener.mockClear();
  unsubscribe();
  await session.signIn();
  session.dispose();
  expect(listener).not.toHaveBeenCalled();
  expect(() => session.credential()).toThrow("Sign in");
  await session.signIn();
  await expect(
    session.ensureSignedIn(new AbortController().signal),
  ).rejects.toThrow("session is closed");
  expect(acquire).toHaveBeenCalledTimes(2);
});
it.each(["cancel", "signOut", "dispose"] as const)(
  "%s settles a creation wait and rejects late credentials",
  async (action) => {
    const release = deferred<Credential>();
    let signal: AbortSignal | undefined;
    const session = createOAuthSession(async (current) => {
      signal = current;
      return release.promise;
    });
    const pending = session.signIn();
    const rejected = expect(
      session.ensureSignedIn(new AbortController().signal),
    ).rejects.toThrow("Sign-in canceled.");
    try {
      expect(session.snapshot().status).toBe("pending");
      session[action]();
      expect(signal?.aborted).toBe(true);
      await rejected;
    } finally {
      release.resolve(credential);
      await pending;
    }
    expect(session.snapshot()).toEqual({ status: "signed-out" });
    expect(() => session.credential()).toThrow("Sign in");
  },
);
it("a stale failure cannot replace a new sign-in", async () => {
  const old = deferred<Credential>();
  const acquire = vi
    .fn()
    .mockImplementationOnce(() => old.promise)
    .mockResolvedValueOnce(credential);
  const session = createOAuthSession(acquire);
  const pending = session.signIn();
  session.cancel();
  await session.signIn();
  old.reject(new Error("stale failure"));
  await pending;
  expect(session.snapshot()).toEqual({
    status: "signed-in",
    account: credential.account,
  });
  expect(session.credential()).toBe(credential);
});
it("creation joins an existing Settings login and aborts its wait without canceling the shared attempt", async () => {
  const release = deferred<Credential>();
  const acquire = vi.fn(() => release.promise);
  const session = createOAuthSession(acquire);
  const settings = session.signIn();
  const canceled = new AbortController();
  const aborted = expect(
    session.ensureSignedIn(canceled.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  const waiting = session.ensureSignedIn(new AbortController().signal);
  try {
    canceled.abort();
    await aborted;
    expect(session.snapshot().status).toBe("pending");
    expect(acquire).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve(credential);
    await settings;
    await waiting;
  }
  expect(session.credential()).toBe(credential);
  await session.ensureSignedIn(new AbortController().signal);
  expect(acquire).toHaveBeenCalledTimes(1);
});

/** An in-memory store that records every operation in order. */
function fakeStore(saved?: Credential) {
  const log: string[] = [];
  let value = saved;
  const store: CredentialStore & {
    log: string[];
    saved(): Credential | undefined;
  } = {
    log,
    saved: () => value,
    async read() {
      log.push("read");
      return value;
    },
    async write(credential) {
      log.push("write");
      value = credential;
    },
    async clear() {
      log.push("clear");
      value = undefined;
    },
  };
  return store;
}
const settled = () => new Promise<void>((done) => setTimeout(done, 0));
const refreshed: Credential = {
  ...credential,
  account: { ...credential.account, canUseRemoteAgents: false },
};

it("saves the credential at sign-in and forgets it at sign-out, in that order", async () => {
  const store = fakeStore();
  const verify = vi.fn(async () => credential);
  const session = createOAuthSession(async () => credential, { store, verify });
  await session.signIn();
  await settled();
  expect(store.saved()).toBe(credential);
  session.signOut();
  await settled();
  expect(store.saved()).toBeUndefined();
  expect(store.log).toEqual(["write", "clear"]);
  expect(verify).not.toHaveBeenCalled();
});

it("a store that fails leaves the sign-in working in memory", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const store = fakeStore();
    // Native commands fail with plain strings.
    store.write = async () => {
      throw "The Keychain is unavailable";
    };
    store.read = async () => {
      throw new Error("The Keychain is unavailable");
    };
    const session = createOAuthSession(async () => credential, {
      store,
      verify: async () => credential,
    });
    await session.restore();
    expect(session.snapshot()).toEqual({ status: "signed-out" });
    await session.signIn();
    await settled();
    expect(session.credential()).toBe(credential);
    expect(session.snapshot().status).toBe("signed-in");
    expect(warn.mock.calls).toEqual([
      ["Builderlab sign-in could not be read", "The Keychain is unavailable"],
      ["Builderlab sign-in could not be saved", "The Keychain is unavailable"],
    ]);
  } finally {
    warn.mockRestore();
  }
});

it("restores a saved sign-in without the browser and saves a changed account", async () => {
  const store = fakeStore(credential);
  const acquire = vi.fn(async () => credential);
  const verify = vi.fn(async () => refreshed);
  const session = createOAuthSession(acquire, { store, verify });
  const listener = vi.fn();
  session.subscribe(listener);
  await session.restore();
  await settled();
  expect(acquire).not.toHaveBeenCalled();
  expect(verify).toHaveBeenCalledWith(credential, expect.any(AbortSignal));
  expect(session.snapshot()).toEqual({
    status: "signed-in",
    account: refreshed.account,
  });
  expect(session.credential()).toBe(refreshed);
  expect(store.saved()).toBe(refreshed);
  expect(store.log).toEqual(["read", "write"]);
  // Signed in at once, then the refreshed account.
  expect(listener).toHaveBeenCalledTimes(2);
  await session.ensureSignedIn(new AbortController().signal);
  expect(acquire).not.toHaveBeenCalled();
});

it("an unchanged account keeps the restored credential object and writes nothing", async () => {
  const store = fakeStore(credential);
  const session = createOAuthSession(async () => credential, {
    store,
    verify: async () => ({ ...credential, account: { ...credential.account } }),
  });
  await session.restore();
  expect(session.credential()).toBe(credential);
  expect(store.log).toEqual(["read"]);
});

it("forgets a saved sign-in the server rejects", async () => {
  const store = fakeStore(credential);
  const session = createOAuthSession(async () => credential, {
    store,
    verify: async () => {
      throw Object.assign(new Error("Builderlab sign-in failed (HTTP 401)."), {
        status: 401,
      });
    },
  });
  await session.restore();
  await settled();
  expect(session.snapshot()).toEqual({
    status: "signed-out",
    error: "Your Builderlab sign-in expired. Sign in again.",
  });
  expect(() => session.credential()).toThrow("Sign in");
  expect(store.saved()).toBeUndefined();
  expect(store.log).toEqual(["read", "clear"]);
});

it.each([
  ["a server that cannot be reached", new Error("Builderlab request failed")],
  [
    "a refusal other than 401",
    Object.assign(new Error("HTTP 503"), { status: 503 }),
  ],
])("%s keeps the saved sign-in", async (_, failure) => {
  const store = fakeStore(credential);
  const session = createOAuthSession(async () => credential, {
    store,
    verify: async () => {
      throw failure;
    },
  });
  await session.restore();
  await settled();
  expect(session.snapshot()).toEqual({
    status: "signed-in",
    account: credential.account,
  });
  expect(session.credential()).toBe(credential);
  expect(store.log).toEqual(["read"]);
});

it.each(["signOut", "signIn"] as const)(
  "%s during the launch check wins over its late answer",
  async (action) => {
    const store = fakeStore(credential);
    const answer = deferred<Credential>();
    let signal: AbortSignal | undefined;
    const fresh: Credential = { ...credential, value: "fresh-token" };
    const session = createOAuthSession(async () => fresh, {
      store,
      verify: (_, current) => {
        signal = current;
        return answer.promise;
      },
    });
    const restoring = session.restore();
    await settled();
    expect(session.credential()).toBe(credential);
    await session[action]();
    expect(signal?.aborted).toBe(true);
    answer.resolve(refreshed);
    await restoring;
    await settled();
    if (action === "signOut") {
      expect(session.snapshot()).toEqual({ status: "signed-out" });
      expect(store.saved()).toBeUndefined();
      expect(store.log).toEqual(["read", "clear"]);
    } else {
      expect(session.credential()).toBe(fresh);
      expect(store.saved()).toBe(fresh);
      expect(store.log).toEqual(["read", "write"]);
    }
  },
);

it("a sign-in and sign-out that both finish while the launch read is pending leave the session signed out", async () => {
  const store = fakeStore(credential);
  const read = deferred<Credential | undefined>();
  store.read = () => {
    store.log.push("read");
    return read.promise;
  };
  const fresh: Credential = { ...credential, value: "fresh-token" };
  const verify = vi.fn(async () => credential);
  const session = createOAuthSession(async () => fresh, { store, verify });
  const listener = vi.fn();
  session.subscribe(listener);
  const restoring = session.restore();
  try {
    await session.signIn();
    session.signOut();
    await settled();
    expect(store.saved()).toBeUndefined();
    listener.mockClear();
  } finally {
    // The blob as it was before the sign-out deleted it.
    read.resolve(credential);
    await restoring;
  }
  await settled();
  expect(session.snapshot()).toEqual({ status: "signed-out" });
  expect(() => session.credential()).toThrow("Sign in");
  expect(listener).not.toHaveBeenCalled();
  expect(verify).not.toHaveBeenCalled();
  expect(store.log).toEqual(["read", "write", "clear"]);
});

it("nothing saved, a browser build, or disposal leaves sign-in available", async () => {
  const store = fakeStore();
  const verify = vi.fn(async () => credential);
  const session = createOAuthSession(async () => credential, { store, verify });
  await session.restore();
  expect(session.snapshot()).toEqual({ status: "signed-out" });
  await createOAuthSession(async () => credential).restore();
  const saved = fakeStore(credential);
  const disposed = createOAuthSession(async () => credential, {
    store: saved,
    verify,
  });
  disposed.dispose();
  await disposed.restore();
  expect(() => disposed.credential()).toThrow("Sign in");
  // Closing Buzz is not signing out: the saved sign-in stays for the next launch.
  expect(saved.saved()).toBe(credential);
  expect(verify).not.toHaveBeenCalled();
});
