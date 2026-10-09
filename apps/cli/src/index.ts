// IMPORTANT: this side-effect import MUST come first. It pins BOBODDY_LOG_LEVEL
// for the interactive case before any worker module (pulled in transitively by
// the imports below) constructs its module-level pino loggers. Moving it down
// will re-introduce noisy logs interleaving with the reporter UI.
import "./lib/bootstrap";

import { run } from "./cli";

const exitCode = await run();
process.exit(exitCode);
