import { access, readFile } from "node:fs/promises";
import path from "node:path";

export const BOBODDY_CONFIG_RELATIVE_PATH = ".boboddy/boboddy.jsonc";

const stripJsoncComments = (content: string): string => {
  let result = "";
  let inString = false;
  let escapeNextCharacter = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content.charAt(index);
    const nextCharacter = content.charAt(index + 1);

    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        result += character;
      }
      continue;
    }

    if (blockComment) {
      if (character === "*" && nextCharacter === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      result += character;

      if (escapeNextCharacter) {
        escapeNextCharacter = false;
        continue;
      }

      if (character === "\\") {
        escapeNextCharacter = true;
        continue;
      }

      if (character === '"') {
        inString = false;
      }

      continue;
    }

    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }

    if (character === "/" && nextCharacter === "/") {
      lineComment = true;
      index += 1;
      continue;
    }

    if (character === "/" && nextCharacter === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    result += character;
  }

  return result;
};

const stripTrailingCommas = (content: string): string => {
  let result = "";
  let inString = false;
  let escapeNextCharacter = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content.charAt(index);

    if (inString) {
      result += character;

      if (escapeNextCharacter) {
        escapeNextCharacter = false;
        continue;
      }

      if (character === "\\") {
        escapeNextCharacter = true;
        continue;
      }

      if (character === '"') {
        inString = false;
      }

      continue;
    }

    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }

    if (character === ",") {
      let lookaheadIndex = index + 1;
      while (lookaheadIndex < content.length) {
        const lookaheadCharacter = content.charAt(lookaheadIndex);
        if (/\s/u.test(lookaheadCharacter)) {
          lookaheadIndex += 1;
          continue;
        }

        if (lookaheadCharacter === "}" || lookaheadCharacter === "]") {
          break;
        }

        result += character;
        break;
      }

      if (lookaheadIndex >= content.length) {
        continue;
      }

      const lookaheadCharacter = content.charAt(lookaheadIndex);
      if (lookaheadCharacter === "}" || lookaheadCharacter === "]") {
        continue;
      }

      continue;
    }

    result += character;
  }

  return result;
};

const parseJsonc = (content: string): unknown =>
  JSON.parse(stripTrailingCommas(stripJsoncComments(content)));

type RawCommandEntry = {
  description?: unknown;
  run?: unknown;
  cwd?: unknown;
};

type RawServiceEntry = {
  description?: unknown;
  run?: unknown;
  cwd?: unknown;
  dependsOn?: unknown;
  expose?: { targetPort?: unknown; protocol?: unknown };
  healthcheck?: { protocol?: unknown; path?: unknown; expectedStatus?: unknown };
};

type RawBoboddyConfig = {
  version?: unknown;
  commands?: Record<string, RawCommandEntry>;
  services?: Record<string, RawServiceEntry>;
};

export type BoboddyCommandDefinition = {
  name: string;
  description: string;
  run: string;
  cwd: string | null;
};

export type BoboddyServiceDefinition = {
  name: string;
  description: string;
  run: string;
  cwd: string | null;
  dependsOn: string[];
  expose: {
    targetPort: number;
    protocol: string;
  };
  healthcheck: {
    protocol: string;
    path: string | null;
    expectedStatus: number | null;
  };
};

export type BoboddyConfig = {
  commands: BoboddyCommandDefinition[];
  services: BoboddyServiceDefinition[];
};

export type ParseBoboddyConfigResult =
  | { found: false }
  | { found: true; config: BoboddyConfig };

// eslint-disable-next-line local/no-unknown-parameter-type
const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

// eslint-disable-next-line local/no-unknown-parameter-type
const asNumber = (value: unknown): number | null =>
  typeof value === "number" ? value : null;

const parseCommands = (
  raw: Record<string, RawCommandEntry> | undefined,
): BoboddyCommandDefinition[] => {
  if (!raw) return [];
  return Object.entries(raw).map(([name, entry]) => ({
    name,
    description: asString(entry.description) ?? "",
    run: asString(entry.run) ?? "",
    cwd: asString(entry.cwd) ?? null,
  }));
};

const parseServices = (
  raw: Record<string, RawServiceEntry> | undefined,
): BoboddyServiceDefinition[] => {
  if (!raw) return [];
  return Object.entries(raw).map(([name, entry]) => {
    const expose = entry.expose ?? {};
    const healthcheck = entry.healthcheck ?? {};
    const dependsOn = Array.isArray(entry.dependsOn)
      ? entry.dependsOn.filter((d): d is string => typeof d === "string")
      : [];
    return {
      name,
      description: asString(entry.description) ?? "",
      run: asString(entry.run) ?? "",
      cwd: asString(entry.cwd) ?? null,
      dependsOn,
      expose: {
        targetPort: asNumber(expose.targetPort) ?? 0,
        protocol: asString(expose.protocol) ?? "http",
      },
      healthcheck: {
        protocol: asString(healthcheck.protocol) ?? "http",
        path: asString(healthcheck.path) ?? null,
        expectedStatus: asNumber(healthcheck.expectedStatus) ?? null,
      },
    };
  });
};

export async function parseBoboddyConfig(
  workspacePath: string,
): Promise<ParseBoboddyConfigResult> {
  const filePath = path.join(workspacePath, BOBODDY_CONFIG_RELATIVE_PATH);
  const exists = await access(filePath)
    .then(() => true)
    .catch(() => false);

  if (!exists) {
    return { found: false };
  }

  const content = await readFile(filePath, "utf8");
  const raw = parseJsonc(content) as RawBoboddyConfig;

  return {
    found: true,
    config: {
      commands: parseCommands(raw.commands),
      services: parseServices(raw.services),
    },
  };
}
