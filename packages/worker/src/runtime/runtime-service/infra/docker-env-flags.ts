/**
 * Expands an env record into repeated `docker exec` `-e KEY=VALUE` flag pairs,
 * in the record's insertion order. Docker applies later `-e` flags over earlier
 * ones, so callers order layers by concatenating results (provider env, then
 * step env). Values travel as argv and are never shell-interpreted.
 */
export function buildDockerEnvFlags(
  env: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(env).flatMap(([key, value]) => [
    "-e",
    `${key}=${value}`,
  ]);
}
