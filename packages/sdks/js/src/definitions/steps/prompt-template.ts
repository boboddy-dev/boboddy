/**
 * Type that maps T to a string-embeddable proxy shape.
 * `-?` strips optionality so `input.user?.email` and `input.user.email` both work —
 * the proxy is never nullish, so optional chaining is a no-op at definition time.
 * `& string` lets each node embed in template literals (`${input.title}`).
 */
export type PromptInputProxy<T> = {
  [K in keyof T]-?: PromptInputProxy<NonNullable<T[K]>>;
} & string;

export function createPromptInputProxy<T>(path: string[] = []): PromptInputProxy<T> {
  const token = () => (path.length ? `{{${path.join(".")}}}` : "");

  return new Proxy(Object.freeze({}), {
    get(_, key) {
      if (key === Symbol.toPrimitive || key === "valueOf") {
        return (_hint: string) => token();
      }
      if (key === "toString") {
        return () => token();
      }
      if (typeof key !== "string") return undefined;
      return createPromptInputProxy([...path, key]);
    },
  }) as unknown as PromptInputProxy<T>;
}

/**
 * Renders a prompt template string by replacing `{{dot.path}}` tokens with
 * values resolved from the provided input object. Missing or null values
 * are replaced with an empty string.
 */
export function renderPromptTemplate(
  template: string,
  inputJson: unknown,
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
    const value = path
      .split(".")
      .reduce<unknown>(
        (curr, key) =>
          curr != null ? (curr as Record<string, unknown>)[key] : undefined,
        inputJson,
      );
    return value != null ? String(value) : "";
  });
}
