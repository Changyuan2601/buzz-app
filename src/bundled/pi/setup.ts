// Pi's providers, as Pi itself has them: the ones it offers, their models,
// saving a provider's key, and testing that a model answers. Keys go to Pi's
// own `~/.pi/agent/auth.json`, shared with the `pi` command, never into Buzz.
import type { ModelChoice } from "../../features/agents/ModelPicker";
import type { SharedProvider } from "../../features/providers/shared";
import type { Pi } from "./pi";

export type Provider = Readonly<{
  id: string;
  name: string;
  /** Takes an API key, saved here. */
  key: boolean;
  /** Signs in through the `pi` command rather than with a key. */
  signsIn: boolean;
  /** Where Pi finds its credentials, when it has them. */
  configured?: string;
  /** A connection Buzz shares, signed in to apart from Pi. */
  shared?: true;
}>;

export type Providers = Readonly<{
  providers: readonly Provider[];
  /** What Pi's settings pick when an agent names no provider or model. */
  defaults: Readonly<{ provider?: string; model?: string; thinking?: string }>;
}>;

/** A model, with the thinking levels it supports, lowest first. */
export type PiModel = ModelChoice & Readonly<{ thinking: readonly string[] }>;

export type Tested = Readonly<{ ok: boolean; message: string }>;

export class PiSetup {
  private listing: Promise<Providers> | undefined;
  private readonly listed = new Map<string, Promise<readonly PiModel[]>>();

  constructor(
    private readonly pi: Pick<Pi, "request">,
    readonly shared?: SharedProvider,
  ) {}

  /** Reads providers and models again, as after signing in. */
  refresh() {
    this.listing = undefined;
    this.listed.clear();
  }

  /** Pi's providers, and the one Buzz shares first, read once until a key is
   * saved. */
  providers(): Promise<Providers> {
    if (this.listing) return this.listing;
    const listing = this.pi
      .request<Providers>("providers")
      .then(async (listed) => {
        const { shared } = this;
        if (!shared) return listed;
        const connected = await shared.connected().catch(() => false);
        return {
          ...listed,
          providers: [
            {
              id: shared.id,
              name: shared.name,
              key: false,
              signsIn: false,
              ...(connected ? { configured: "Buzz" } : {}),
              shared: true as const,
            },
            ...listed.providers,
          ],
        };
      });
    this.listing = listing;
    listing.catch(() => {
      if (this.listing === listing) this.listing = undefined;
    });
    return listing;
  }

  /** A provider's models, from Pi's catalog; none from a shared connection
   * before signing in. */
  models(id: string): Promise<readonly PiModel[]> {
    let models = this.listed.get(id);
    if (!models) {
      const { shared } = this;
      models = (async () => {
        if (id === shared?.id && !(await shared.connected())) return [];
        const listed = await this.pi.request<
          { id: string; name: string; thinking: string[] }[]
        >("models", { provider: id });
        return listed.map((model) => ({
          id: model.id,
          label: model.name || model.id,
          thinking: model.thinking,
        }));
      })();
      const listing = models;
      listing.catch(() => {
        if (this.listed.get(id) === listing) this.listed.delete(id);
      });
      this.listed.set(id, listing);
    }
    return models;
  }

  /** Saves a provider's API key with Pi's own login. */
  async login(id: string, key: string) {
    await this.pi.request("login", { provider: id, key });
    this.listing = undefined;
  }

  /** Asks the model for one short reply, without tools. */
  test(choice: Readonly<{ provider: string; model: string }>): Promise<Tested> {
    return this.pi.request<Tested>("test", choice);
  }
}
