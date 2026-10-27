// Reads a saved session's transcript through standard ACP: a short-lived
// harness process replays it with `session/load`, and its updates become
// `Transcript` turns. Nothing is prompted.
import type { Transcript } from "../../agents/activity-transcript";
import type { OptionState, StartConfirmed, TranscriptRead } from "./types";

/** The transcript, or undefined when the harness can't replay one. */
export async function readTranscript(
  _read: TranscriptRead,
): Promise<Transcript | undefined> {
  throw new Error("not built yet");
}

/** A Check's look at the options a new session offers, with no Buzz tools
 * and no prompt; undefined on any failure. */
export async function probeOptions(
  _start: StartConfirmed,
  _cwd: string,
  _signal?: AbortSignal,
): Promise<OptionState | undefined> {
  throw new Error("not built yet");
}
