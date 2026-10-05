import { execFileSync } from "node:child_process";
import { posix, win32 } from "node:path";

// Hermit owns POSIX tools; Windows CI provisions the same pins through rustup.
export function runtimeBuildPlatform(
  root,
  platform = process.platform,
  inherited = process.env,
) {
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  // Read before scrubbing: a shell-wide target dir also hosts this build.
  const [, targetDir] =
    Object.entries(inherited).find(
      ([key]) => (windows ? key.toUpperCase() : key) === "CARGO_TARGET_DIR",
    ) ?? [];
  // Keep shared-cache builds independent of injected credentials and shell
  // compiler overrides. User Cargo config and CC/CFLAGS still apply unkeyed.
  const env = Object.fromEntries(
    Object.entries(inherited).filter(
      ([key]) =>
        !/^(BUZZ_|BUZZODZ_|NOSTR_|DATABRICKS_|CARGO_(BUILD|ENCODED|PROFILE|TARGET)_|RUSTC$|RUSTC_|RUSTFLAGS$|RUSTDOCFLAGS$)/i.test(
          key,
        ),
    ),
  );
  // On Windows preserve the runner's Path spelling. Duplicate PATH/Path keys
  // cause Node to select only one, silently dropping provisioned tools.
  if (!windows) env.PATH = `${path.join(root, "bin")}:${env.PATH ?? ""}`;
  let common;
  try {
    common = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    // Not a Git checkout: no shared bundle cache or target.
  }
  // Pinned upstream sources and scrubbed settings make one target safe to share
  // across worktrees; its own subdirectory keeps it apart from app artifacts.
  env.CARGO_TARGET_DIR = targetDir
    ? path.resolve(targetDir, "agent-runtime-build")
    : common
      ? path.join(common, "buzz-agent-runtime", "target")
      : path.join(root, "target/agent-runtime-build");
  return {
    env,
    common,
    cargo: windows ? "cargo.exe" : path.join(root, "bin/cargo"),
    rustc: windows ? "rustc.exe" : path.join(root, "bin/rustc"),
  };
}
