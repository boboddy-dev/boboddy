import * as readline from "node:readline";

/**
 * Blocks until the user presses Enter. Used to gate `init`'s browser
 * hand-off (#141): v1 is manual by design — no polling, no deep link — so
 * this is the entire "wait" step.
 */
export function waitForKeypress(promptMessage: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(promptMessage, () => {
      rl.close();
      resolve();
    });
  });
}
