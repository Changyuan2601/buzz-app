// Lifecycle for plugin producers. The host owns registration, cancellation and delivery;
// plugins own execution. A resolved run is terminal until its watch is edited.
import type { HostProcess, HostProcessOptions } from "../host/service";
import type { Agent } from "./service";
import type { AttentionObject, SourceWatch } from "./attention";

export type AttentionSource = Readonly<{
  id: string;
  /** Discovery metadata for tools that configure this provider. */
  description?: string;
  configExample?: Readonly<Record<string, unknown>>;
  run(
    input: Readonly<{
      /** The agent's membership key, as `Agents.wake` takes. */
      agent: string;
      watch: SourceWatch;
      signal: AbortSignal;
      /** Runs a declared process as this watch's agent and destination.
       * Buzz revokes access when this run returns, throws or is cancelled. */
      spawn(
        process: string,
        options: Omit<HostProcessOptions, "mcp">,
      ): Promise<HostProcess>;
      /** Empty output wakes nothing. Throws when delivery cannot be queued. */
      emit(text: string): void;
    }>,
  ): Promise<void>;
}>;
/** Host registration after binding the plugin's command capability. */
export type AttentionProducer = Omit<AttentionSource, "run"> & {
  run(
    input: Omit<Parameters<AttentionSource["run"]>[0], "spawn">,
  ): Promise<void>;
};
type SourceObject = AttentionObject & { value: SourceWatch };
export class AttentionSources {
  private runs = new Map<
    string,
    { object: SourceObject; stop: AbortController; done: boolean }
  >();
  constructor(
    private host: {
      emit(
        agent: string,
        object: SourceObject,
        text: string,
        current: () => boolean,
      ): void;
      completed(agent: string, object: SourceObject): boolean;
      finish(agent: string, object: SourceObject): Promise<void>;
    },
    private tails = new Map<string, Promise<void>>(),
  ) {}
  reconcile(
    provider: string,
    source: AttentionProducer,
    agents: readonly Agent[],
  ) {
    const wanted = new Map<string, { agent: Agent; object: SourceObject }>();
    for (const agent of agents) {
      if (!agent.attentionEnabled) continue;
      for (const object of Object.values(agent.attention)) {
        const value = object.value;
        if (
          value.type === "source" &&
          value.provider === provider &&
          value.enabled &&
          agent.attention[`interest/${value.interest_id}`]?.value.type ===
            "interest"
        )
          wanted.set(`${provider}/${agent.key}/${object.slug}`, {
            agent,
            object: object as SourceObject,
          });
      }
    }
    for (const [key, run] of this.runs) {
      if (wanted.get(key)?.object === run.object) continue;
      run.stop.abort();
      this.runs.delete(key);
    }
    for (const [key, { agent, object }] of wanted) {
      if (this.runs.has(key) || this.host.completed(agent.key, object))
        continue;
      const run = { object, stop: new AbortController(), done: false };
      this.runs.set(key, run);
      const emit = (text: string) => {
        if (run.stop.signal.aborted || run.done)
          throw new Error("This source watch is no longer running");
        if (text.trim())
          this.host.emit(
            agent.key,
            object,
            text,
            () => !run.stop.signal.aborted,
          );
      };
      let succeeded = false;
      const previous = this.tails.get(key);
      const done = Promise.resolve(previous)
        .then(async () => {
          if (run.stop.signal.aborted || this.host.completed(agent.key, object))
            return;
          await source.run({
            agent: agent.key,
            watch: object.value,
            signal: run.stop.signal,
            emit,
          });
          succeeded = true;
        })
        .catch((error) => {
          if (!run.stop.signal.aborted)
            console.warn(`Attention source ${provider} failed`, error);
        })
        .finally(async () => {
          run.done = true;
          if (succeeded && !run.stop.signal.aborted)
            await this.host
              .finish(agent.key, object)
              .catch((error) =>
                console.warn(
                  "Attention source completion was not saved",
                  error,
                ),
              );
          if (this.tails.get(key) === done) this.tails.delete(key);
        });
      this.tails.set(key, done);
    }
  }
  stop() {
    for (const run of this.runs.values()) run.stop.abort();
    this.runs.clear();
  }
}
