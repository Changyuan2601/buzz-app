// A configured inference connection. Harnesses consume its catalog and auth;
// each harness integration owns how that connection becomes API requests.
import type { ComponentType } from "react";
export const DATABRICKS_ID = "buzz.databricks";

export type ProviderModel = Readonly<{
  id: string;
  label: string;
  /** Discovery facts; each harness decides which families and routes it can
   * use, such as `mlflow/v1/responses` or `anthropic/v1/messages`. */
  family: string;
  apis: readonly string[];
}>;
/** Where a harness process sends requests, and the command it runs for a
 * current access token, which it prints. */
export type ProviderConnection = Readonly<{
  host: string;
  command: string;
  args: readonly string[];
}>;
export type SharedProvider = Readonly<{
  id: string;
  name: string;
  connected(): Promise<boolean>;
  models(): Promise<readonly ProviderModel[]>;
  connection(): Promise<ProviderConnection>;
  Connection: ComponentType<{ onChange(): void; disabled?: boolean }>;
}>;
