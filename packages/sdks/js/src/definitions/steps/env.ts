import {
  containsInputToken,
  type EnvVarSpec,
  type EnvVarsInput,
} from "../../env-vars";
import {
  createPromptInputProxy,
  type PromptInputProxy,
} from "./prompt-template";

/**
 * Authoring helpers for a step's `environment.vars` option, and the definition-time
 * normalization that turns the authored record into the `envJson` wire shape
 * (`../../env-vars.ts`).
 */

const SECRET_LOOKING_NAME = /SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE/i;

/**
 * True for names that look like they hold a credential. A static (input-free)
 * literal on such a name is rejected at definition time unless the author opts
 * in with `unsafeAllowStatic`.
 */
export function isSecretLookingEnvName(name: string): boolean {
  return SECRET_LOOKING_NAME.test(name);
}

export type ValueOpts = {
  readonly value: string;
  readonly secret?: boolean;
  /**
   * Allows a static (input-free) value on a secret-looking name such as
   * `API_TOKEN`. Never serialized. A static value is still stored in
   * plaintext, so only use this for values that are not actually secret.
   */
  readonly unsafeAllowStatic?: boolean;
};

/**
 * `secret: true` and `default` are mutually exclusive: a default is stored in
 * the definition in plaintext.
 */
export type InheritOpts =
  | {
      readonly from?: string;
      readonly secret: true;
      readonly optional?: boolean;
      readonly default?: never;
    }
  | {
      readonly from?: string;
      readonly secret?: false;
      readonly optional?: boolean;
      readonly default?: string;
    };

export type EnvValue<TSecret extends boolean = boolean> = {
  readonly kind: "value";
  readonly value: string;
  readonly secret: TSecret;
  readonly unsafeAllowStatic: boolean;
};

export type EnvInherit<
  TSecret extends boolean = boolean,
  TOptional extends boolean = boolean,
  TDefault extends string | undefined = string | undefined,
> = {
  readonly kind: "inherit";
  readonly from: string | undefined;
  readonly secret: TSecret;
  readonly optional: TOptional;
  readonly default: TDefault;
};

export type EnvEntry = string | EnvValue | EnvInherit;
export type EnvRecord = Record<string, EnvEntry>;

/** Runs once at definition time, against the same input proxy `agentPrompt` uses. */
export type EnvFn<TInput, TEnv extends EnvRecord = EnvRecord> = (context: {
  input: PromptInputProxy<TInput>;
}) => TEnv;

type SecretOf<O> = O extends { secret: infer S }
  ? S extends false
    ? false
    : true
  : false;

type OptionalOf<O> = O extends { optional: infer P }
  ? P extends false
    ? false
    : true
  : false;

type DefaultOf<O> = O extends { default: infer D extends string }
  ? D
  : undefined;

type PromptEntryValue<E> = E extends { kind: "inherit" }
  ? E extends { default: string }
    ? string
    : E extends { optional: false }
      ? string
      : string | undefined
  : string;

/**
 * The `env` object an `agentPrompt` callback receives when the step declares
 * `environment.vars`: only declared, non-secret keys. An entry whose secrecy is
 * not provably `false` is dropped.
 */
export type PromptEnv<TEnv extends EnvRecord> = {
  [
    K in keyof TEnv as TEnv[K] extends string
      ? K
      : TEnv[K] extends { secret: false }
        ? K
        : never
  ]: PromptEntryValue<TEnv[K]>;
};

/**
 * The prompt `env` type for a step: strict (`PromptEnv`) once
 * `environment.vars` is declared, today's loose record otherwise. Undeclared
 * `vars` leaves `TEnv` at its `EnvRecord` default, whose index signature is the
 * marker.
 */
export type PromptEnvContext<TEnv extends EnvRecord> = string extends keyof TEnv
  ? PromptInputProxy<Record<string, string | undefined>>
  : PromptEnv<TEnv>;

/**
 * Entries produced by `Env.value`/`Env.inherit`. Anything else in the record
 * is a bare value, which is usually an input-proxy object rather than a
 * primitive string, so it cannot be told apart by `typeof` or by shape (the
 * proxy answers every property read).
 */
const helperEntries = new WeakSet();

function brand<T extends EnvValue | EnvInherit>(entry: T): T {
  helperEntries.add(entry);
  return entry;
}

export const Env = {
  /**
   * A literal or `{{input.…}}` template value. Same as writing a bare string,
   * with an explicit `secret` flag.
   *
   * - Source: the step definition itself, rendered against the run's input.
   * - Stored: yes, as the template, in plaintext. Visible in the API and UI.
   * - Masked: in logs, when `secret` is true. A secret must contain an
   *   `{{input.…}}` token, because a static secret would be stored in
   *   plaintext.
   */
  value<const O extends ValueOpts>(opts: O): EnvValue<SecretOf<O>> {
    return brand({
      kind: "value",
      value: opts.value,
      secret: (opts.secret ?? false) as SecretOf<O>,
      unsafeAllowStatic: opts.unsafeAllowStatic ?? false,
    });
  },

  /**
   * Reads the variable from the **worker** host (`.boboddy/.env`, then
   * `process.env`), not from the devcontainer's `containerEnv`. The name
   * defaults to the key; `from` renames it.
   *
   * - Source: the worker environment at run time.
   * - Stored: only the variable name (plus `default`, which is plaintext).
   * - Masked: in logs, when `secret` is true. A secret cannot carry a
   *   `default`.
   *
   * A required variable that is missing from the worker fails the step before
   * it starts; `optional` omits it, and `default` fills it.
   */
  inherit<const O extends InheritOpts = Record<never, never>>(
    opts?: O,
  ): EnvInherit<SecretOf<O>, OptionalOf<O>, DefaultOf<O>> {
    return brand({
      kind: "inherit",
      from: opts?.from,
      secret: (opts?.secret ?? false) as SecretOf<O>,
      optional: (opts?.optional ?? false) as OptionalOf<O>,
      default: opts?.default as DefaultOf<O>,
    });
  },
} as const;

function isHelperEntry(entry: EnvEntry): entry is EnvValue | EnvInherit {
  return typeof entry === "object" && helperEntries.has(entry);
}

function assertNotStaticSecret(
  name: string,
  value: string,
  flags: Pick<EnvValue, "secret" | "unsafeAllowStatic">,
): void {
  if (containsInputToken(value)) return;

  if (flags.secret) {
    throw new Error(
      `Env "${name}": a secret must interpolate an input token; a static secret would be stored in plaintext. Use Env.inherit({ secret: true }) to read it from the worker.`,
    );
  }
  if (isSecretLookingEnvName(name) && !flags.unsafeAllowStatic) {
    throw new Error(
      `Env "${name}": a static value on a secret-looking name would be stored in plaintext. Use Env.inherit({ secret: true }) to read it from the worker, or Env.value({ value, unsafeAllowStatic: true }) if it is not actually secret.`,
    );
  }
}

function toEnvVarSpec(name: string, entry: EnvEntry): EnvVarSpec {
  if (!isHelperEntry(entry)) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-template-expression -- a bare input reference is an input-proxy object typed as string; the template coerces it to its {{input.…}} token
    const value = `${entry}`;
    assertNotStaticSecret(name, value, {
      secret: false,
      unsafeAllowStatic: false,
    });
    return { name, source: "value", value, secret: false };
  }
  if (entry.kind === "value") {
    assertNotStaticSecret(name, entry.value, entry);
    return { name, source: "value", value: entry.value, secret: entry.secret };
  }
  return {
    name,
    source: "inherit",
    from: entry.from ?? name,
    secret: entry.secret,
    optional: entry.optional,
    ...(entry.default !== undefined ? { default: entry.default } : {}),
  };
}

/**
 * Runs the authored `environment.vars` function once and returns the wire
 * shape, or `null` when the step declares no `vars` (or an empty record).
 * Throws on a static secret, or a static literal on a secret-looking name.
 */
export function normalizeEnv<TInput>(
  fn: EnvFn<TInput> | undefined,
): EnvVarsInput | null {
  if (!fn) return null;
  const record = fn({ input: createPromptInputProxy<TInput>(["input"]) });
  const specs = Object.entries(record).map(([name, entry]) =>
    toEnvVarSpec(name, entry),
  );
  return specs.length > 0 ? specs : null;
}
