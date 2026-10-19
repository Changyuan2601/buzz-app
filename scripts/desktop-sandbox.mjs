// A development sandbox is a dev copy of Buzz that starts as a clean install. It
// has its own app identifier, Keychain items, plugin storage and WebView data store.
// Erasing it touches only names that carry `.sandbox.<name>`, so the installed app
// and every other dev copy keep their data. Supported on macOS only for now.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const BASE = "dev.local.buzz.foundation";
// Keychain services of a debug build, as in crates/credential-store,
// crates/agent-controller/src/credentials.rs and src-tauri/src/jev.rs.
const HUMAN = `${BASE}.identity.debug`;
const SERVICES = [HUMAN, `${BASE}.agents`, `${BASE}.jev-key.debug`];

export function validSandbox(name) {
  return typeof name === "string" && /^[a-z0-9-]{1,32}$/.test(name);
}

export const sandboxed = (name, sandbox) => `${name}.sandbox.${sandbox}`;

export function sandboxPaths(sandbox, home = homedir()) {
  const identifier = sandboxed(BASE, sandbox);
  const support = join(home, "Library/Application Support");
  return {
    identifier,
    appData: join(support, identifier),
    caches: join(home, "Library/Caches", identifier),
    webkitData: join(home, "Library/WebKit", identifier),
    // Outside app data, so erasing can find the WebView store it replaces.
    state: join(support, `${BASE}.sandboxes`, `${sandbox}.json`),
    support,
    backups: join(home, ".buzz-foundation/nsec-backups"),
    locks: join(home, ".buzz-foundation-credential-locks"),
    webkit: join(home, "Library/WebKit"),
  };
}

function readStore(paths) {
  try {
    const { store } = JSON.parse(readFileSync(paths.state, "utf8"));
    return /^[0-9a-f]{32}$/.test(store) ? store : undefined;
  } catch {
    return undefined;
  }
}

function newStore(paths) {
  const store = randomBytes(16).toString("hex");
  mkdirSync(dirname(paths.state), { recursive: true });
  writeFileSync(paths.state, `${JSON.stringify({ store })}\n`);
  return store;
}

/** The sandbox's WebView data store as 32 hex digits, created on first use. */
export function webviewStore(paths) {
  return readStore(paths) ?? newStore(paths);
}

/**
 * Tauri config for the sandbox: its identifier, and every window of `conf` with
 * its name in the title and held back (`create: false`), so the app opens it on
 * the sandbox's WebView data store. Tauri's config codegen can't carry the store
 * itself. Tauri replaces arrays when it merges configs, so this carries the whole
 * window list.
 */
export function sandboxConfig(sandbox, conf) {
  return {
    identifier: sandboxed(BASE, sandbox),
    app: {
      windows: (conf.app?.windows ?? []).map((window) => ({
        ...window,
        title: `${window.title ?? "Buzz Foundation"} (sandbox: ${sandbox})`,
        create: false,
      })),
    },
  };
}

/** Deletes each Keychain item of exactly `service`; returns how many it deleted. */
function deleteItems(service) {
  let count = 0;
  while (
    spawnSync("security", ["delete-generic-password", "-s", service], {
      stdio: "ignore",
    }).status === 0
  ) {
    if (++count > 1000)
      throw new Error(`Too many Keychain items for ${service}`);
  }
  return count;
}

function remove(path, sandbox, removed) {
  // Every erased name carries the sandbox; anything else is a bug.
  if (!path.includes(sandboxed("", sandbox)))
    throw new Error(`Refusing to remove ${path}: not in sandbox ${sandbox}`);
  if (!existsSync(path)) return;
  rmSync(path, { recursive: true, force: true });
  removed.push(path);
}

/** Folders WebKit named for `store`, at most four levels under ~/Library/WebKit. */
function storeFolders(root, store) {
  const uuid = store
    .toUpperCase()
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Unreadable or vanished: nothing of ours is there.
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.name.toUpperCase() === uuid) found.push(path);
      else if (depth < 3) walk(path, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/**
 * Erases the sandbox so its next launch is a first run. `keepIdentity` keeps its
 * human key, so the next launch signs in as the same person; everything else,
 * including agents, communities and WebView storage, starts over.
 */
export function eraseSandbox(sandbox, { keepIdentity = false } = {}) {
  if (!validSandbox(sandbox))
    throw new Error(`Invalid sandbox name: ${sandbox}`);
  if (process.platform !== "darwin")
    throw new Error(
      "Erasing a development sandbox is supported on macOS only.",
    );
  const paths = sandboxPaths(sandbox);
  const removed = [];
  const keychain = [];
  for (const path of [paths.appData, paths.caches, paths.webkitData])
    remove(path, sandbox, removed);
  for (const service of SERVICES) {
    if (keepIdentity && service === HUMAN) continue;
    const scoped = sandboxed(service, sandbox);
    const count = deleteItems(scoped);
    if (count) keychain.push(`${scoped} (${count})`);
    if (service !== HUMAN) continue;
    // Sign-out markers, records and locks named `…<service>.<suffix>`; the dot
    // keeps sandbox `a` from matching sandbox `ab`.
    for (const entry of readdirSync(paths.support))
      if (entry.includes(`${scoped}.`))
        remove(join(paths.support, entry), sandbox, removed);
    remove(join(paths.backups, scoped), sandbox, removed);
  }
  // The agent key bundle's lock (crates/agent-controller bundle_lock.rs).
  remove(
    join(paths.locks, sandboxed("agent-bundle-v1.lock", sandbox)),
    sandbox,
    removed,
  );
  // WebKit names a store's folder after its identifier, a random UUID, so a
  // match is this sandbox's. A new identifier gives clean storage regardless.
  const store = readStore(paths);
  if (store)
    for (const path of storeFolders(paths.webkit, store)) {
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    }
  newStore(paths);
  return { removed, keychain };
}
