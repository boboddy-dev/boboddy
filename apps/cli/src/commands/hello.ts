import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import { withReporter } from "../lib/command-output";

export interface HelloArguments {
  name: string;
}

export function createHelloMessage(name: string): string {
  return `Hello, ${name}!`;
}

async function handler(
  arguments_: ArgumentsCamelCase<HelloArguments>,
): Promise<void> {
  await withReporter("hello", ({ reporter }) => {
    reporter.success(createHelloMessage(arguments_.name));
  });
}

export const helloCommand: CommandModule<object, HelloArguments> = {
  command: "hello [name]",
  describe: "Print a friendly greeting",
  builder: (argv: Argv<object>) =>
    argv.positional("name", {
      describe: "The name to greet",
      type: "string",
      default: "world",
    }),
  handler,
};
