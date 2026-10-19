import os from "node:os";

/**
 * The developer's (or CI runner's) real home, captured at module evaluation
 * before any test points `HOME` at a temp dir. Only the OpenCode runtime
 * payload cache lives here so it survives across tests and runs; credentials
 * and agent config stay under each test's isolated `HOME`.
 */
const realHome = os.homedir();

export const PAYLOAD_HOME_ENV = "BOBODDY_TEST_PAYLOAD_HOME";

export function resolveIntegrationPayloadHome(): string {
  return process.env[PAYLOAD_HOME_ENV] ?? realHome;
}
