import { invoke } from "@tauri-apps/api/core";

// Shared by both login owners so re-enabling a plugin cannot reuse an old revision.
let generation = 0;
export function handoffBackupSession(
  source: "builderlab" | "hosted",
  credential: string | null,
  send: <T>(
    command: string,
    args: Record<string, unknown>,
  ) => Promise<T> = invoke,
) {
  void send("nsec_backup_session", {
    source,
    generation: ++generation,
    credential,
  }).catch(() => {});
}
