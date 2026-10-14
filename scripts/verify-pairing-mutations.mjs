#!/usr/bin/env node
// Mutate copies of the actual executable owner; never alter the checkout.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const owner = join(root, "crates/pairing-policy/src/lib.rs");
const original = readFileSync(owner, "utf8");
const digest = (text) => createHash("sha256").update(text).digest("hex");
const sysroot = spawnSync(join(root, "bin/rustc"), ["--print", "sysroot"], {
  encoding: "utf8",
});
if (sysroot.status !== 0) throw new Error("Pinned Rust is required");
const env = {
  ...process.env,
  VERUS_USE_RUSTUP: "0",
  LD_LIBRARY_PATH: `${sysroot.stdout.trim()}/lib:${process.env.LD_LIBRARY_PATH || ""}`,
  DYLD_LIBRARY_PATH: `${sysroot.stdout.trim()}/lib:${process.env.DYLD_LIBRARY_PATH || ""}`,
};
const mutations = [
  [
    "offer session",
    "|| self.peer.is_some() || !key_eq(&self.session, &session)",
    "|| self.peer.is_some()",
  ],
  [
    "negotiated legacy mode",
    "|| self.code_mode || self.peer.is_none()",
    "|| self.peer.is_none()",
  ],
  [
    "authenticated guess peer",
    "|| !self.code_mode || !self.issued || self.guesses >= 5\n            || !self.accepts_peer(&peer)",
    "|| !self.code_mode || !self.issued || self.guesses >= 5",
  ],
  ["permanent guess budget", "self.guesses >= 5", "self.guesses >= 6"],
  [
    "matching submitted code",
    "candidate.unwrap() == self.code",
    "candidate.unwrap() != self.code",
  ],
  [
    "once-only issuance",
    "|| !self.code_mode || self.issued || code >= 1_000_000",
    "|| !self.code_mode || code >= 1_000_000",
  ],
  ["fresh native generation", "self.generation += 1;", "self.generation += 0;"],
  ["superseded worker", "active.generation == attempt.generation", "true"],
  [
    "revocation admission",
    "if self.closed || self.revoked {",
    "if self.closed {",
  ],
  [
    "closed attempt admission",
    "if self.closed || self.generation == u64::MAX",
    "if self.generation == u64::MAX",
  ],
  [
    "one distinct transfer",
    "if !self.current(attempt) || self.released || !live",
    "if !self.current(attempt) || !live",
  ],
  ["release deadline", "self.released || !live", "self.released || false"],
  [
    "pinned human",
    "|| !key_eq(&attempt.human, &proposal.binding.human)",
    "|| false",
  ],
  [
    "selected community",
    "|| !bytes_eq(&attempt.community, &proposal.binding.community)",
    "|| false",
  ],
  [
    "native session binding",
    "|| self.session.is_none() || !key_eq(&self.session.unwrap(), &session)",
    "|| self.session.is_none()",
  ],
  [
    "authorization session",
    "|| !key_eq(&authorization.session, &session)",
    "|| false",
  ],
  [
    "authorization locked peer",
    "|| !key_eq(&authorization.peer, &peer)",
    "|| false",
  ],
  ["immutable retry bytes", "{ self.bytes.clone() }", "{ Vec::new() }"],
  ["absorbing native close", "self.closed = true;", "self.closed = false;"],
  [
    "persist before Ready",
    "if !persisted || !matches!(self, Custody::Missing)",
    "if !matches!(self, Custody::Missing)",
  ],
  [
    "peer success acknowledgement",
    "|| !key_eq(&auth.peer, &ack.peer)",
    "|| false",
  ],
];
const temporary = mkdtempSync(join(tmpdir(), "buzz-pairing-mutations-"));
function verify(source) {
  const path = join(temporary, "lib.rs");
  writeFileSync(path, source);
  const result = spawnSync(
    join(root, "bin/verus"),
    ["--crate-type", "lib", path, "--output-json"],
    { cwd: root, env, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  let report;
  try {
    report = JSON.parse(result.stdout)["verification-results"];
  } catch {
    throw new Error(
      `Verifier did not produce proof evidence: ${result.stderr}`,
    );
  }
  return { status: result.status, report, stderr: result.stderr };
}
try {
  const baseline = verify(original);
  if (
    baseline.status !== 0 ||
    !baseline.report?.success ||
    !(baseline.report.verified > 0)
  )
    throw new Error("Unmutated production proof failed");
  for (const [name, from, to] of mutations) {
    if (original.split(from).length !== 2)
      throw new Error(`Mutation ${name} must have one exact target`);
    let mutated = original.replace(from, to);
    if (name === "permanent guess budget") {
      // Weaken both the entry guard and terminal exhaustion together so a sixth
      // guess becomes reachable, rather than changing a redundant guard alone.
      mutated = mutated.replace(
        "self.guesses == 5 { self.state",
        "self.guesses == 6 { self.state",
      );
    }
    const result = verify(mutated);
    if (
      result.status === 0 ||
      result.report?.success ||
      !(result.report?.errors > 0)
    )
      throw new Error(
        `Mutation ${name} was not rejected by proof: ${result.stderr}`,
      );
    console.log(`Rejected: ${name} (${result.report.errors} proof errors)`);
    // Restore byte-for-byte before the next mutation, independently of process exit.
    writeFileSync(join(temporary, "lib.rs"), original);
    if (
      digest(readFileSync(join(temporary, "lib.rs"), "utf8")) !==
      digest(original)
    )
      throw new Error("Mutation restoration failed");
  }
  console.log(
    `${mutations.length} security mutations rejected; executable owner unchanged (${digest(original)})`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
  if (digest(readFileSync(owner, "utf8")) !== digest(original)) {
    process.stderr.write(
      "Production owner changed during mutation verification\n",
    );
    process.exitCode = 1;
  }
}
