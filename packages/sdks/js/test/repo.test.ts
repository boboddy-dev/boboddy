import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Env, Repo, Runtime, defineStep } from "../src";
import { compileRepo, type RepoSpec } from "../src/definitions/steps/repo";
import { compileEnvironment } from "../src/definitions/steps/runtime";
import { validateDefinitionSpecs } from "../src/definitions/validation";

describe("Repo constructors", () => {
  test("none() and readOnly() take no options", () => {
    expect(Repo.none()).toEqual({ mode: "none" });
    expect(Repo.readOnly()).toEqual({ mode: "readOnly" });
    // @ts-expect-error none takes no options
    Repo.none({ message: "x" });
    // @ts-expect-error readOnly takes no options
    Repo.readOnly({ message: "x" });
  });

  test("readWrite() without options is just the mode", () => {
    expect(Repo.readWrite()).toEqual({ mode: "readWrite" });
    expect(Repo.readWrite({})).toEqual({ mode: "readWrite" });
  });

  test("readWrite(opts) keeps message and onPushFailure", () => {
    expect(Repo.readWrite({ message: "m", onPushFailure: "warn" })).toEqual({
      mode: "readWrite",
      message: "m",
      onPushFailure: "warn",
    });
  });

  test("readWrite rejects an unknown onPushFailure at the type level", () => {
    // @ts-expect-error only "fail" and "warn"
    Repo.readWrite({ onPushFailure: "ignore" });
  });
});

describe("compileRepo — compatibility table", () => {
  const devcontainer = Runtime.devcontainer();
  const host = Runtime.host();
  const specs: Record<string, RepoSpec> = {
    readWrite: Repo.readWrite(),
    readOnly: Repo.readOnly(),
    none: Repo.none(),
  };

  test.each([
    ["readWrite", "devcontainer", devcontainer, true],
    ["readOnly", "devcontainer", devcontainer, true],
    ["none", "devcontainer", devcontainer, false],
    ["readWrite", "host", host, false],
    ["readOnly", "host", host, false],
    ["none", "host", host, true],
    ["readWrite", "no runtime", undefined, true],
    ["readOnly", "no runtime", undefined, true],
    ["none", "no runtime", undefined, false],
  ] as const)("%s on %s: allowed=%p", (mode, _label, runtime, allowed) => {
    const spec = specs[mode];
    if (!spec) throw new Error("missing spec");
    if (allowed) {
      expect(compileRepo(spec, runtime)).toEqual({ mode });
    } else {
      expect(() => compileRepo(spec, runtime)).toThrow(/cannot be used with/);
    }
  });

  test("a host step is rejected because it has no clone", () => {
    expect(() =>
      compileRepo(Repo.readWrite(), host, { stepKey: "triage" }),
    ).toThrow(
      'Step "triage" repo "readWrite" cannot be used with executionMode "no_workspace": a host step has no clone.',
    );
  });

  test("a devcontainer step is rejected because it reads config from the clone", () => {
    expect(() =>
      compileRepo(Repo.none(), devcontainer, { stepKey: "build" }),
    ).toThrow(
      'Step "build" repo "none" cannot be used with executionMode "workspace": a devcontainer step reads its config from the clone.',
    );
  });
});

describe("compileRepo — forms", () => {
  test("no repo compiles to undefined", () => {
    expect(compileRepo(undefined, undefined)).toBeUndefined();
    expect(compileRepo(undefined, Runtime.host())).toBeUndefined();
  });

  test("static form carries only what the author wrote", () => {
    expect(compileRepo(Repo.readWrite(), undefined)).toEqual({
      mode: "readWrite",
    });
    expect(
      compileRepo(Repo.readWrite({ onPushFailure: "warn" }), undefined),
    ).toEqual({ mode: "readWrite", onPushFailure: "warn" });
    expect(compileRepo(Repo.readWrite({ message: "fix" }), undefined)).toEqual({
      mode: "readWrite",
      message: "fix",
    });
  });

  test("an explicitly undefined option is dropped from the wire shape", () => {
    const config = compileRepo(
      { mode: "readWrite", message: undefined, onPushFailure: undefined },
      undefined,
    );
    expect(config).toEqual({ mode: "readWrite" });
    expect(Object.keys(config ?? {})).toEqual(["mode"]);
  });

  test("static form with a template string keeps the tokens", () => {
    expect(
      compileRepo(
        Repo.readWrite({ message: "fix: {{result.summary}}" }),
        undefined,
      ),
    ).toEqual({ mode: "readWrite", message: "fix: {{result.summary}}" });
  });

  test("function form renders input and result proxies into tokens", () => {
    const config = compileRepo<{ title: string }, { summary: string }>(
      ({ input, result }) =>
        Repo.readWrite({ message: `fix ${input.title}: ${result.summary}` }),
      undefined,
    );
    expect(config).toEqual({
      mode: "readWrite",
      message: "fix {{input.title}}: {{result.summary}}",
    });
  });

  test("function form coerces a bare proxy reference to its token", () => {
    const config = compileRepo<unknown, { summary: string }>(
      ({ result }) => Repo.readWrite({ message: result.summary }),
      undefined,
    );
    expect(config).toEqual({
      mode: "readWrite",
      message: "{{result.summary}}",
    });
  });

  test("function form renders nested paths", () => {
    const config = compileRepo<{ a: { b: string } }, { c: { d: string } }>(
      ({ input, result }) =>
        Repo.readWrite({ message: `${input.a.b}/${result.c.d}` }),
      undefined,
    );
    expect(config).toEqual({
      mode: "readWrite",
      message: "{{input.a.b}}/{{result.c.d}}",
    });
  });

  test("function form runs once", () => {
    let calls = 0;
    compileRepo(() => {
      calls += 1;
      return Repo.readOnly();
    }, undefined);
    expect(calls).toBe(1);
  });

  test("function form returning readOnly and none compiles to the bare mode", () => {
    expect(compileRepo(() => Repo.readOnly(), undefined)).toEqual({
      mode: "readOnly",
    });
    expect(compileRepo(() => Repo.none(), Runtime.host())).toEqual({
      mode: "none",
    });
  });

  test("function form is checked against the runtime too", () => {
    expect(() => compileRepo(() => Repo.readWrite(), Runtime.host())).toThrow(
      /a host step has no clone/,
    );
  });
});

describe("compileRepo — message rejections", () => {
  const compile = (message: string) =>
    compileRepo(Repo.readWrite({ message }), undefined, { stepKey: "s" });

  test("rejects a message over 500 characters", () => {
    expect(() => compile("a".repeat(501))).toThrow(/^Step "s" repo: message/);
  });

  test("accepts a 500 character message", () => {
    expect(compile("a".repeat(500))).toEqual({
      mode: "readWrite",
      message: "a".repeat(500),
    });
  });

  test("rejects a newline", () => {
    expect(() => compile("one\ntwo")).toThrow(/single line/);
  });

  test("rejects an env token", () => {
    expect(() => compile("deploy {{env.API_TOKEN}}")).toThrow(/tokens/);
  });

  test("rejects an unknown root", () => {
    expect(() => compile("{{boboddy.artifactsDir}}")).toThrow(/tokens/);
  });

  test("rejects an unknown onPushFailure from untyped callers", () => {
    expect(() =>
      compileRepo(
        { mode: "readWrite", onPushFailure: "ignore" } as unknown as RepoSpec,
        undefined,
      ),
    ).toThrow(/onPushFailure/);
  });
});

describe("compileEnvironment — repo", () => {
  test("no repo leaves it undefined and the key off the wire shape", () => {
    expect(compileEnvironment({}).repo).toBeUndefined();
    expect(compileEnvironment(undefined).repo).toBeUndefined();
  });

  test("compiles repo alongside runtime and vars", () => {
    const compiled = compileEnvironment({
      runtime: Runtime.devcontainer(),
      vars: () => ({ A: "x" }),
      repo: Repo.readOnly(),
    });
    expect(compiled.executionMode).toBe("workspace");
    expect(compiled.envJson).toHaveLength(1);
    expect(compiled.repo).toEqual({ mode: "readOnly" });
  });

  test("a host step accepts none and rejects the rest", () => {
    expect(
      compileEnvironment({ runtime: Runtime.host(), repo: Repo.none() }).repo,
    ).toEqual({ mode: "none" });
    expect(() =>
      compileEnvironment({
        runtime: Runtime.host(),
        // @ts-expect-error a host step has no clone
        repo: Repo.readWrite(),
      }),
    ).toThrow(/a host step has no clone/);
  });
});

describe("defineStep — repo", () => {
  const base = { key: "s", name: "S", agentPrompt: "go" } as const;

  test("omitted repo emits no repo field", () => {
    const spec = defineStep(base);
    expect(spec.repo).toBeUndefined();
    expect("repo" in spec).toBe(false);
  });

  test("static Repo.readOnly() emits repo", () => {
    const spec = defineStep({
      ...base,
      environment: { repo: Repo.readOnly() },
    });
    expect(spec.repo).toEqual({ mode: "readOnly" });
    expect(spec.executionMode).toBe("workspace");
  });

  test("Repo.readWrite() on a devcontainer step emits an explicit readWrite", () => {
    const spec = defineStep({
      ...base,
      environment: { runtime: Runtime.devcontainer(), repo: Repo.readWrite() },
    });
    expect(spec.repo).toEqual({ mode: "readWrite" });
  });

  test("Repo.none() on a host step emits an explicit none", () => {
    const spec = defineStep({
      ...base,
      environment: { runtime: Runtime.host(), repo: Repo.none() },
    });
    expect(spec.repo).toEqual({ mode: "none" });
    expect(spec.executionMode).toBe("no_workspace");
  });

  test("function form types result from the result schema and input from additionalInput", () => {
    const spec = defineStep({
      key: "implement",
      name: "Implement",
      additionalInput: z.object({ title: z.string() }),
      result: z.object({ summary: z.string() }),
      environment: {
        runtime: Runtime.devcontainer(),
        repo: ({ input, result }) =>
          Repo.readWrite({
            message: `fix: ${result.summary} (${input.title})`,
            onPushFailure: "warn",
          }),
      },
      agentPrompt: ({ input }) => `Fix: ${input.title}`,
    });
    expect(spec.repo).toEqual({
      mode: "readWrite",
      message: "fix: {{result.summary}} ({{input.title}})",
      onPushFailure: "warn",
    });
  });

  test("function form rejects an unknown result field at the type level", () => {
    defineStep({
      ...base,
      result: z.object({ summary: z.string() }),
      environment: {
        repo: ({ result }) => {
          // @ts-expect-error `nope` is not on the result schema
          void result.nope;
          return Repo.readOnly();
        },
      },
    });
  });

  test("function form rejects an unknown input field at the type level", () => {
    defineStep({
      ...base,
      additionalInput: z.object({ title: z.string() }),
      environment: {
        repo: ({ input }) => {
          // @ts-expect-error `nope` is not on additionalInput
          void input.nope;
          return Repo.readOnly();
        },
      },
    });
  });

  test("repo does not break vars inference, declared before or after vars", () => {
    const repoFirst = defineStep({
      key: "a",
      name: "A",
      additionalInput: z.object({ id: z.string() }),
      result: z.object({ summary: z.string() }),
      environment: {
        repo: ({ result }) =>
          Repo.readWrite({ message: `fix: ${result.summary}` }),
        vars: ({ input }) => ({ ID: input.id, LEVEL: Env.inherit() }),
      },
      agentPrompt: ({ env }) => {
        const id: string = env.ID;
        // @ts-expect-error undeclared keys are rejected once vars is declared
        void env.NOT_DECLARED;
        return id;
      },
    });
    const varsFirst = defineStep({
      key: "b",
      name: "B",
      additionalInput: z.object({ id: z.string() }),
      environment: {
        vars: ({ input }) => ({ ID: input.id }),
        repo: Repo.readOnly(),
      },
      agentPrompt: ({ env }) => env.ID,
    });
    expect(repoFirst.repo?.mode).toBe("readWrite");
    expect(varsFirst.repo).toEqual({ mode: "readOnly" });
  });

  test("the runtime and repo pairs are type errors where the types can express them", () => {
    const pairs = [
      () =>
        defineStep({
          ...base,
          // @ts-expect-error a host step has no clone, so readWrite is rejected
          environment: { runtime: Runtime.host(), repo: Repo.readWrite() },
        }),
      () =>
        defineStep({
          ...base,
          // @ts-expect-error a host step has no clone, so readOnly is rejected
          environment: { runtime: Runtime.host(), repo: Repo.readOnly() },
        }),
      () =>
        defineStep({
          ...base,
          // @ts-expect-error a devcontainer step reads its config from the clone
          environment: { runtime: Runtime.devcontainer(), repo: Repo.none() },
        }),
      () =>
        defineStep({
          ...base,
          // @ts-expect-error an omitted runtime is a devcontainer step
          environment: { repo: Repo.none() },
        }),
    ];
    for (const pair of pairs)
      expect(pair).toThrow(/^Step "s" repo ".*" cannot be used with/);
  });

  test("a produced spec passes validateDefinitionSpecs", () => {
    const steps = [
      defineStep({
        ...base,
        key: "rw",
        environment: { repo: Repo.readWrite() },
      }),
      defineStep({
        ...base,
        key: "ro",
        environment: { repo: Repo.readOnly() },
      }),
      defineStep({
        ...base,
        key: "host",
        environment: { runtime: Runtime.host(), repo: Repo.none() },
      }),
    ];
    expect(validateDefinitionSpecs({ pipelines: [], steps })).toEqual([]);
  });
});
