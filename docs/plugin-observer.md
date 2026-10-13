# Native plugin execution metadata

This producer exports Codex execution metadata for an external attention tool. It does not declare semantic task state, restore PR watchers, or enable Switchboard consumption. Other plugin harnesses remain unsupported.

## Native custody and routing

The bundled Codex runtime attaches its original signature-bearing Buzz trigger to the same owned native write that submits `turn/start` or `turn/steer`. Native verifies the NIP-01 hash/signature, the saved agent's `buzz.codex` type, and the owner or unconditional owner attestation. Channel and root come from signed references. Conditional attestations fail closed. Current task authorization and channel membership remain separate consumer checks.

`HostProcesses` observes JSONL input in the same serialization order as native stdin writes, and observes stdout before forwarding it to the renderer. Intake binding alone creates no execution record. A successful native turn response establishes acceptance; native turn-start/activity establishes liveness; native completion establishes that turn's terminal outcome. One turn may carry multiple Buzz roots, each retained separately. A completion never settles another active turn.

## Export

The fixed app-data path is `plugin-observer/v1/runtime.json`. Native atomically replaces an owner-readable file every ten seconds. Nothing is posted to a relay. The file contains:

```json
{"version":1,"events":["original signed Nostr envelopes"]}
```

Each envelope is kind 9, authored by a currently hosted Codex agent, with its owner attestation and `t=buzz-plugin-observer-v1`. Ordinary agent publication rejects that reserved purpose tag. Native signs one payload per agent without exposing keys. Consumers recompute the original event hash/signature and validate the purpose, schema, author, owner, relay and current task independently. Arbitrary local JSON or a supplied proof marker is insufficient.

The signed content contains `version`, `producer` (`buzz.codex/native`), `generation`, `sequence`, `generated_at_ms`, `complete`, `diagnostic`, `agent`, `owner`, `relay` and `sessions`. Each session contains `relay`, `owner`, `agent`, `channel_id`, `root_id`, `trigger_id`, `trigger_ids`, `codex_thread_id`, `turn_id`, `state` and `observed_at_ms`. States are `accepted`, `running`, `completed`, `failed`, `interrupted` and `unknown`. All timestamps are Unix milliseconds. Acceptance is not liveness. Exporter heartbeats never advance a session's observation time.

## Coverage and failures

Coverage concerns native turns within one source generation, not all historical Codex work or app intake that has not reached a native turn. A consumer must require the current authorized trigger's correlation before using terminal evidence. It must consider all active sessions for an agent before concluding that agent is idle. Freshness and complete coverage are both required; a quiet running stream eventually becomes execution unknown.

Records, pending routes and frames are bounded. Truncation, malformed/oversized frames, missing route/acceptance and process outages fail closed. A page reset creates a new generation; late output from retired processes cannot populate it. A replacement process after an outage starts a new generation. Prior generation evidence may remain history but cannot establish current idle. Export/signing failure leaves the prior file to expire.

## Inventory ownership

A native session mapping associates execution evidence with its Buzz task. It must not create a second action owner from differently rendered Codex asks. Shared channel sessions can map several distinct Buzz roots to one Codex thread. Preserve explicit handoffs and genuinely standalone Codex work, and revalidate provenance at Next and both submission boundaries. This producer changes no session scope or visibility setting.
