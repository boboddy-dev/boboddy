import * as readline from "node:readline";
import type { HandoffCheckTrigger } from "./init-project-handoff";

/**
 * The real {@link HandoffCheckTrigger}: a timer that Enter on stdin cuts
 * short. The terminal stays in cooked mode (`terminal: false`), so Ctrl+C is
 * still an ordinary SIGINT rather than a keypress readline swallows.
 */
export function listenForEnter(): HandoffCheckTrigger {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });
  let wake: (() => void) | undefined;
  let pressedWhileIdle = false;

  rl.on("line", () => {
    if (wake) {
      wake();
    } else {
      pressedWhileIdle = true;
    }
  });

  return {
    wait: (delayMs) =>
      new Promise((resolve) => {
        if (pressedWhileIdle) {
          pressedWhileIdle = false;
          resolve("enter");
          return;
        }
        const timer = setTimeout(() => {
          wake = undefined;
          resolve("timer");
        }, delayMs);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve("enter");
        };
      }),
    close: () => {
      wake?.();
      rl.close();
    },
  };
}
