#!/usr/bin/env node
// A pretend agent provider for trying hosted Agents types. It holds each
// agent's key, takes the owner's NIP-OA attestation, publishes the agent's
// profile, and answers every mention by the owner with "ack" (or the reply its
// Status tab sets). It reads the community over HTTP like the app's own
// agents do: NIP-98 per request, with the attestation as `x-auth-tag`.
//
// Run from the repository root:  node examples/plugins/remote-ackbot/server.mjs
// FAIL_ACTIVATE=1 makes its first activation fail, to try Finish setup.
// It listens on 127.0.0.1:8787 (PORT changes it) and keeps its agents, keys
// included, in remote-ackbot.json beside this file (STATE changes it), which
// only you can read. It answers only the app and local pages, so a website
// you visit cannot drive it. Test use only: the keys are stored in plain text.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";

const PORT = Number(process.env.PORT ?? 8787);
const STATE =
  process.env.STATE ??
  new URL("./remote-ackbot.json", import.meta.url).pathname;
const POLL_MS = 2000;
// FAIL_ACTIVATE=1 fails the first activation, to try Finish setup.
let failActivation = process.env.FAIL_ACTIVATE === "1";

/** By pubkey: { secret, name, picture?, community, auth?, owner?, reply, since, replies } */
let agents = {};
try {
  agents = JSON.parse(readFileSync(STATE, "utf8"));
} catch {}
const save = () =>
  writeFileSync(STATE, JSON.stringify(agents, null, 2), { mode: 0o600 });
// The desktop app's webview origins, and pages served from this machine.
const ALLOWED =
  /^(?:tauri:\/\/localhost|https?:\/\/tauri\.localhost|https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)$/;
const log = (...args) => console.log(new Date().toISOString(), ...args);

// A local relay may be plain ws://.
const httpsOf = (community) =>
  community.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
const now = () => Math.floor(Date.now() / 1000);

/** NIP-OA: the owner signs sha256("nostr:agent-auth:<agent>:<conditions>"). */
function attests(auth, pubkey) {
  if (!Array.isArray(auth) || auth.length !== 4 || auth[0] !== "auth")
    return false;
  const [, owner, conditions, signature] = auth;
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${pubkey}:${conditions}`)
    .digest();
  try {
    return schnorr.verify(hexToBytes(signature), digest, hexToBytes(owner));
  } catch {
    return false;
  }
}

/** Signs `template` as the agent, its owner's attestation attached. */
function sign(agent, template) {
  return finalizeEvent(
    {
      created_at: now(),
      ...template,
      tags: [...(template.tags ?? []), agent.auth],
    },
    hexToBytes(agent.secret),
  );
}
/** NIP-98 authorization for posting `body` to `url` as the agent. */
function authorization(agent, url, body) {
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: now(),
      content: "",
      tags: [
        ["u", url],
        ["method", "POST"],
        ["payload", createHash("sha256").update(body).digest("hex")],
        ["nonce", bytesToHex(generateSecretKey()).slice(0, 32)],
      ],
    },
    hexToBytes(agent.secret),
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}
async function post(agent, path, payload) {
  const url = `${httpsOf(agent.community)}${path}`;
  const body = JSON.stringify(payload);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization(agent, url, body),
      "x-auth-tag": JSON.stringify(agent.auth),
    },
    body,
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${path} ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
const publish = (agent, template) =>
  post(agent, "/events", sign(agent, template));

function publishProfile(agent) {
  return publish(agent, {
    kind: 0,
    content: JSON.stringify({
      name: agent.name,
      bot: true,
      ...(agent.picture ? { picture: agent.picture } : {}),
    }),
  });
}

/** A chat message's time, to the millisecond: the second in `created_at` and
 * the rest in an `ms` tag, as the app orders messages within a second. A
 * reply is never earlier than the message it answers, even when this
 * computer's clock is behind the sender's. */
function messageTime(answering) {
  const value = answering.tags.find((tag) => tag[0] === "ms")?.[1];
  const offset = /^(0|[1-9]\d{0,2})$/.test(value ?? "") ? Number(value) : 0;
  const at = Math.max(Date.now(), answering.created_at * 1000 + offset + 1);
  return { created_at: Math.floor(at / 1000), ms: String(at % 1000) };
}

/** Answers each new mention by the owner, in its thread. */
const seen = new Set();
async function poll(pubkey) {
  const agent = agents[pubkey];
  if (!agent?.auth) return;
  const events = await post(agent, "/query", [
    { kinds: [9], "#p": [pubkey], since: agent.since, limit: 50 },
  ]);
  // Oldest first, so `since` only moves past what was answered.
  events.sort((a, b) => a.created_at - b.created_at);
  for (const event of events) {
    if (seen.has(event.id) || agent.acked?.includes(event.id)) continue;
    const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
    if (event.pubkey !== agent.owner || !channel) {
      seen.add(event.id);
      continue;
    }
    const root =
      event.tags.find((tag) => tag[0] === "e" && tag[3] === "root")?.[1] ??
      event.tags.find((tag) => tag[0] === "e" && tag[3] === "reply")?.[1] ??
      event.id;
    const { created_at, ms } = messageTime(event);
    await publish(agent, {
      kind: 9,
      created_at,
      content: agent.reply,
      tags: [
        ["h", channel],
        ["e", root, "", "reply"],
        ["p", event.pubkey],
        ["ms", ms],
      ],
    });
    seen.add(event.id);
    agent.since = Math.max(agent.since, event.created_at);
    // `since` is inclusive, so a restart would answer these again.
    agent.acked = [...(agent.acked ?? []), event.id].slice(-50);
    agent.replies++;
    save();
    log(
      `${agent.name} acked ${event.id.slice(0, 8)} in ${channel.slice(0, 8)}`,
    );
  }
}
/** Agents being polled, so a slow reply is never sent twice. */
const polling = new Set();
setInterval(() => {
  for (const pubkey of Object.keys(agents)) {
    if (polling.has(pubkey)) continue;
    polling.add(pubkey);
    poll(pubkey)
      .catch((error) =>
        log(`${agents[pubkey]?.name ?? pubkey} poll failed:`, error.message),
      )
      .finally(() => polling.delete(pubkey));
  }
}, POLL_MS);

/** The provider's HTTP API, one route per step of `remote` in the plugin. */
async function route(method, path, body) {
  if (method === "POST" && path === "/agents") {
    if (
      typeof body.name !== "string" ||
      !/^wss?:\/\//.test(body.community ?? "")
    )
      return [400, { error: "name and a wss:// community are required" }];
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    agents[pubkey] = {
      secret: bytesToHex(secret),
      name: body.name,
      community: body.community,
      reply: "ack",
      since: now(),
      replies: 0,
    };
    save();
    log(`provisioned ${body.name} ${pubkey.slice(0, 8)} for ${body.community}`);
    return [200, { pubkey }];
  }
  const match = path.match(/^\/agents\/([0-9a-f]{64})(\/[a-z]+)?$/);
  const pubkey = match?.[1];
  const agent = pubkey && agents[pubkey];
  if (!agent)
    return method === "DELETE" ? [200, {}] : [404, { error: "No such agent" }];
  const step = match[2] ?? "";
  if (method === "POST" && step === "/activate") {
    if (failActivation) {
      failActivation = false;
      return [
        503,
        { error: "The ack bot server failed on purpose (FAIL_ACTIVATE)" },
      ];
    }
    if (!attests(body.auth, pubkey))
      return [
        400,
        { error: "That is not the owner's attestation of this agent" },
      ];
    Object.assign(agent, {
      auth: body.auth,
      owner: body.auth[1],
      name: body.name ?? agent.name,
      since: now(),
    });
    await publishProfile(agent);
    save();
    log(`activated ${agent.name} for owner ${agent.owner.slice(0, 8)}`);
    return [200, {}];
  }
  if (method === "POST" && step === "/profile") {
    agent.name = body.name ?? agent.name;
    agent.picture = body.picture || undefined;
    if (agent.auth) await publishProfile(agent);
    save();
    return [200, {}];
  }
  if (method === "POST" && step === "/settings") {
    if (typeof body.reply !== "string" || !body.reply.trim())
      return [400, { error: "The reply cannot be empty" }];
    agent.reply = body.reply.trim();
    save();
    return [200, { reply: agent.reply, replies: agent.replies }];
  }
  if (method === "GET" && step === "")
    return [
      200,
      {
        name: agent.name,
        active: !!agent.auth,
        reply: agent.reply,
        replies: agent.replies,
      },
    ];
  if (method === "DELETE" && step === "") {
    delete agents[pubkey];
    save();
    log(`removed ${agent.name}`);
    return [200, {}];
  }
  return [404, { error: "No such route" }];
}

createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const origin = request.headers.origin;
  if (origin && !ALLOWED.test(origin)) {
    response.writeHead(403).end();
    return;
  }
  const headers = {
    ...(origin
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
      : {}),
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (request.method === "OPTIONS") {
    response.writeHead(204, headers).end();
    return;
  }
  let status = 500;
  let result = {};
  try {
    const raw = Buffer.concat(chunks).toString() || "{}";
    [status, result] = await route(
      request.method,
      request.url,
      JSON.parse(raw),
    );
  } catch (error) {
    result = { error: error.message };
    log(`${request.method} ${request.url} failed:`, error.message);
  }
  response.writeHead(status, headers).end(JSON.stringify(result));
}).listen(PORT, "127.0.0.1", () =>
  log(
    `remote ack bot provider on http://127.0.0.1:${PORT}, ${Object.keys(agents).length} agents`,
  ),
);
