import { createLogger } from "../../../lib/logger";

type WorkLogDetails = Record<string, unknown>;

const workLogger = createLogger({
  name: "@boboddy/worker",
  level: process.env["BOBODDY_LOG_LEVEL"] ?? "info",
}).child({ scope: "work" });

export function logWork(
  scope: string,
  message: string,
  details?: WorkLogDetails,
): void {
  workLogger.info({ ...details, workScope: scope }, message);
}

export function logWorkDebug(
  scope: string,
  message: string,
  details?: WorkLogDetails,
): void {
  workLogger.debug({ ...details, workScope: scope }, message);
}

export function logWorkError(
  scope: string,
  message: string,
  details?: WorkLogDetails,
): void {
  workLogger.error({ ...details, workScope: scope }, message);
}
