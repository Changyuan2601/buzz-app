// buzz-agent-host: runs one of this machine's Buzz agents without the desktop app.
//
//   buzz-agent-host run <pubkey>
//
// The agent is one the app saved here, and it runs with the settings, teams
// and sessions the app saved for it. The app's own executable holds its key
// and its claim on the agent (`custody.ts`): BUZZ_APP names it, or else it is
// the installed app. While the installed app runs the agent, this host waits.
import { agentsNative } from "../features/agents/native";
import { appExecutable, startCustody } from "./custody";
import { host } from "./host";

const usage = "Usage: buzz-agent-host run <pubkey>";
const log = (message: string) =>
  console.error(`${new Date().toISOString()} ${message}`);

async function main(args: readonly string[]) {
  const [command, pubkey, ...rest] = args;
  if (
    command !== "run" ||
    !pubkey ||
    !/^[0-9a-f]{64}$/.test(pubkey) ||
    rest.length
  ) {
    console.error(usage);
    process.exit(2);
  }
  const custody = startCustody(appExecutable(), pubkey, (reason) => {
    log(`${reason}; stopped`);
    process.exit(1);
  });
  const identity = (await agentsNative(custody.call).list()).find(
    (agent) => agent.pubkey === pubkey && !agent.deleted,
  );
  if (!identity) throw new Error(`No agent ${pubkey} is saved on this machine`);
  let stopping = false;
  let stop: (() => Promise<void>) | undefined;
  const quit = () => {
    if (stopping || !stop) process.exit(stop ? 1 : 0);
    stopping = true;
    log("Stopping");
    void stop()
      .then(() => custody.close())
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  stop = await host({
    identity,
    call: custody.call,
    log,
    onGone: (reason) => {
      log(`${reason}; stopped`);
      void custody.close().finally(() => process.exit(0));
    },
  });
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
