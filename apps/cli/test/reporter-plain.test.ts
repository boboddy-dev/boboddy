import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PlainReporter } from "../src/lib/reporter-plain";

describe("PlainReporter", () => {
  let writes: string[];
  let original: typeof process.stderr.write;

  beforeEach(() => {
    writes = [];
    original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };
  });

  afterEach(() => {
    process.stderr.write = original;
  });

  function captured(): string {
    return writes.join("");
  }

  test("info writes a `·`-prefixed line", () => {
    new PlainReporter().info("hi");
    expect(captured()).toContain("· hi\n");
  });

  test("success writes a `✓`-prefixed line", () => {
    new PlainReporter().success("done");
    expect(captured()).toContain("✓ done\n");
  });

  test("warn writes a `!`-prefixed line", () => {
    new PlainReporter().warn("careful");
    expect(captured()).toContain("! careful\n");
  });

  test("error writes a `✗`-prefixed line", () => {
    new PlainReporter().error("boom");
    expect(captured()).toContain("✗ boom\n");
  });

  test("start writes a line containing the title", () => {
    new PlainReporter().start("Title");
    expect(captured()).toContain("Title");
  });

  test("start includes a logs line when a log file path is given", () => {
    new PlainReporter("/tmp/boboddy.log").start("Title");
    const out = captured();
    expect(out).toContain("Title");
    expect(out).toContain("/tmp/boboddy.log");
  });

  test("startTask returns a handle whose succeed writes a `✓` line", () => {
    const task = new PlainReporter().startTask("working");
    task.succeed("ok");
    expect(captured()).toContain("✓ ok\n");
  });
});
