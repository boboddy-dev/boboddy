import { BoboddyClient } from "./generated";
import { createClient } from "./generated/client";

export * from "./task-plane-client";
export * from "./generated/";

export function createBoboddyClient(baseUrl: string) {
  const client = createClient({ baseUrl });
  return new BoboddyClient({ client });
}
