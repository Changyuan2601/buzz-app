import type { Spawn } from "./goose";
import script from "./storage.sh?raw";

/** All callers (turns, setup and history) use the same private database.
 * The bundled Goose executable still resolves through the host's grant. */
export const withHome =
  (spawn: Spawn): Spawn =>
  async (id, options) => {
    if (id !== "goose") return spawn(id, options);
    let home = "";
    let error = "";
    const setup = await spawn("storage", {
      args: [script],
      onStdout: (data) => {
        home += data;
      },
      onStderr: (data) => {
        error += data;
      },
    });
    if ((await setup.exited) !== 0 || !home.trim().startsWith("/"))
      throw new Error(error.trim() || "Could not prepare Buzz's Goose home");
    return spawn(id, {
      ...options,
      env: { ...options?.env, GOOSE_PATH_ROOT: home.trim() },
    });
  };
