// The agents service as the screens' page has it when agents run in another
// page. What screens read and call goes over the agents port. What a
// plugin's UI entry adds, its tools, hosted types and what its types show,
// is listed with the service under the plugin's identity until the plugin
// stops. What only running agents use belongs in the plugin's agent entry,
// which runs where the agents do.
import { type Context, Service } from "@deepseek-ai/cordis";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { RelayData } from "../relay/service";
import { communityDestination } from "../communities/destination";
import type { connectAgents } from "./port";
import type { Remote } from "./handles";
import type { AgentKey } from "./membership";
import type {
  AgentPresentation,
  Agents,
  AgentsClient,
  AgentType,
  RegisteredAgentType,
} from "./service";

type Client = ReturnType<typeof connectAgents>;

const apart = (what: string) =>
  new Error(
    `${what} is for running agents, which run in another page: use it from the plugin's agent entry.`,
  );

export class ScreensAgents extends Service implements Agents {
  // What screens read and call, as the client has it.
  declare readonly snapshot: AgentsClient["snapshot"];
  declare readonly subscribe: AgentsClient["subscribe"];
  declare readonly resumeInterrupted: AgentsClient["resumeInterrupted"];
  declare readonly dismissInterrupted: AgentsClient["dismissInterrupted"];
  declare readonly find: AgentsClient["find"];
  declare readonly create: AgentsClient["create"];
  declare readonly creationRequests: AgentsClient["creationRequests"];
  declare readonly dismissCreation: AgentsClient["dismissCreation"];
  declare readonly approveCreation: AgentsClient["approveCreation"];
  declare readonly updateRequests: AgentsClient["updateRequests"];
  declare readonly dismissUpdate: AgentsClient["dismissUpdate"];
  declare readonly approveUpdate: AgentsClient["approveUpdate"];
  declare readonly finish: AgentsClient["finish"];
  declare readonly portable: AgentsClient["portable"];
  declare readonly port: AgentsClient["port"];
  declare readonly portTeam: AgentsClient["portTeam"];
  declare readonly save: AgentsClient["save"];
  declare readonly previewRetype: AgentsClient["previewRetype"];
  declare readonly retype: AgentsClient["retype"];
  declare readonly remove: AgentsClient["remove"];
  declare readonly memberships: AgentsClient["memberships"];
  declare readonly forget: AgentsClient["forget"];
  declare readonly joinable: AgentsClient["joinable"];
  declare readonly join: AgentsClient["join"];
  declare readonly leave: AgentsClient["leave"];
  declare readonly interruptible: AgentsClient["interruptible"];
  declare readonly sessionState: AgentsClient["sessionState"];
  declare readonly session: AgentsClient["session"];
  declare readonly interrupt: AgentsClient["interrupt"];
  declare readonly unarchive: AgentsClient["unarchive"];
  declare readonly classifier: AgentsClient["classifier"];
  declare readonly setClassifierKey: AgentsClient["setClassifierKey"];
  declare readonly clearClassifierKey: AgentsClient["clearClassifierKey"];
  declare readonly saveTeam: AgentsClient["saveTeam"];
  declare readonly removeTeam: AgentsClient["removeTeam"];
  private readonly client: Client;
  private readonly open: (community: string) => RelayData | undefined;
  constructor(
    ctx: Context,
    client: Client,
    open: (community: string) => RelayData | undefined,
  ) {
    super(ctx, "agents");
    const {
      present: _present,
      addTool: _addTool,
      register: _register,
      local: _local,
      activity: _activity,
      follow: _follow,
      close: _close,
      types: _types,
      ...screens
    } = client;
    Object.assign(this, screens);
    this.client = client;
    this.open = open;
  }
  private owner(what: string) {
    const owner = this.ctx.pluginOwner;
    if (!owner) throw new Error(`Only a plugin ${what}`);
    return owner;
  }
  types = () =>
    this.client.types() as unknown as readonly RegisteredAgentType[];
  register<Config>(type: AgentType<Config>) {
    const withdraw = this.client.register(
      type as unknown as AgentType,
      this.owner("registers agent types"),
    );
    this.ctx.effect(() => withdraw);
  }
  present<Exposed, Config>(
    typeId: string,
    present: (exposed: Remote<Exposed>) => AgentPresentation<Config>,
  ) {
    const { id } = this.owner("presents agent types");
    const stop = this.client.present(
      `${id}/${typeId}`,
      present as unknown as Parameters<Client["present"]>[1],
    );
    this.ctx.effect(() => stop);
  }
  addTool(tool: AddedTool) {
    const withdraw = this.client.addTool(tool, this.owner("adds agent tools"));
    this.ctx.effect(() => withdraw);
  }
  /** This page's own connection to the running agent's community. */
  relay(key: AgentKey) {
    const agent = this.client
      .snapshot()
      .running.find((running) => running.key === key);
    if (!agent) return undefined;
    try {
      return this.open(communityDestination(agent.relay).url);
    } catch {
      return undefined;
    }
  }
  addAttentionSource(): never {
    throw apart("addAttentionSource");
  }
  attentionProviders(): never {
    throw apart("attentionProviders");
  }
  tools(): never {
    throw apart("tools");
  }
  wake(): never {
    throw apart("wake");
  }
  handle(): never {
    throw apart("handle");
  }
  core(): never {
    throw apart("core");
  }
  note(): never {
    throw apart("note");
  }
  get storage(): never {
    throw apart("storage");
  }
}
