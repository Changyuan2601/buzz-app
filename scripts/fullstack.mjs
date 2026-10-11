// Runs the desktop (or web) frontend against a local Docker relay at
// wss://localhost:3443. Every checkout shares one relay and its volumes, so the
// secrets and Caddy's local CA live once per user, outside any worktree.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { nip19 } from "nostr-tools";
import { loadEnv } from "vite";

const RELAY_URL = "wss://localhost:3443";
const root = fileURLToPath(new URL("..", import.meta.url));
const state = `${homedir()}/.buzz-foundation/fullstack`;
const envFile = `${state}/.env`;
const caFile = `${state}/caddy-root.crt`;
const compose = [
  "compose",
  "--env-file",
  envFile,
  "-f",
  fileURLToPath(new URL("./fullstack/compose.yml", import.meta.url)),
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) {
    console.error(`${command}: ${result.error.message}`);
    process.exit(1);
  }
  return result.status ?? 1;
}

function docker(...args) {
  const status = run("docker", [...compose, ...args]);
  if (status !== 0) process.exit(status);
}

/** The relay is closed; its owner is the same public pin the broker signs as. */
function ownerHex() {
  const pin = (
    loadEnv("development", root, "BUZZ_DEV_VIEWER").BUZZ_DEV_VIEWER ?? ""
  ).trim();
  if (/^[0-9a-f]{64}$/.test(pin)) return pin;
  try {
    const decoded = nip19.decode(pin);
    if (decoded.type === "npub") return decoded.data;
  } catch {}
  console.error(
    "Set BUZZ_DEV_VIEWER (npub or hex) in .env.local; it becomes the local relay owner.",
  );
  process.exit(1);
}

/** Generated once: rotating these would orphan the database and media volumes. */
function ensureEnv() {
  if (existsSync(envFile)) return;
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const hex = (bytes) => randomBytes(bytes).toString("hex");
  const values = {
    RELAY_OWNER_PUBKEY: ownerHex(),
    BUZZ_RELAY_PRIVATE_KEY: hex(32),
    BUZZ_GIT_HOOK_HMAC_SECRET: hex(32),
    POSTGRES_PASSWORD: hex(16),
    REDIS_PASSWORD: hex(16),
    BUZZ_S3_ACCESS_KEY: hex(10),
    BUZZ_S3_SECRET_KEY: hex(20),
  };
  writeFileSync(
    envFile,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
    { mode: 0o600 },
  );
}

const [command = "desktop", ...args] = process.argv.slice(2);
if (command === "down") docker("down", ...args);
else if (command === "logs") docker("logs", ...args);
else if (command === "desktop" || command === "web" || command === "up") {
  ensureEnv();
  docker("up", "--detach", "--wait");
  // Caddy writes its local CA shortly after start; Node trusts only this file.
  const ca = "caddy:/data/caddy/pki/authorities/local/root.crt";
  for (let tries = 20; run("docker", [...compose, "cp", ca, caFile]); tries--) {
    if (tries === 0) process.exit(1);
    spawnSync("sleep", ["0.5"]);
  }
  console.log(
    `Local relay ready at ${RELAY_URL} (just fullstack down to stop).`,
  );
  if (command !== "up") {
    const target =
      command === "web"
        ? ["pnpm", ["dev", ...args]]
        : [process.execPath, [`${root}scripts/desktop-dev.mjs`, ...args]];
    process.exit(
      run(...target, {
        cwd: root,
        env: {
          ...process.env,
          BUZZ_RELAY_URL: RELAY_URL,
          BUZZ_DEV_OPEN_RELAY: "1",
          NODE_EXTRA_CA_CERTS: caFile,
        },
      }),
    );
  }
} else {
  console.error("Usage: just fullstack [desktop|web|up|down|logs] [args...]");
  process.exit(1);
}
