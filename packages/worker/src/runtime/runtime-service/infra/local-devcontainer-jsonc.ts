import path from "node:path";
import type { AnyJsonValue } from "../../../common/contracts/json";
import { ConfigurationError } from "../../../lib/errors";

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

export const parseDevcontainerConfigContent = (
  content: string,
): AnyJsonValue => {
  try {
    return JSON.parse(
      stripTrailingCommas(stripJsoncComments(content)),
    ) as AnyJsonValue;
  } catch (error) {
    throw new ConfigurationError(
      `Invalid devcontainer config: ${error instanceof Error ? error.message : "Unable to parse config"}`,
      "DEVCONTAINER_CONFIG_INVALID",
    );
  }
};

export const parseDevcontainerWorkspaceFolderFromContent = (
  content: string,
  workspacePath: string,
): string | null => {
  const config = parseDevcontainerConfigContent(content);
  if (
    typeof config !== "object" ||
    config === null ||
    Array.isArray(config) ||
    typeof config["workspaceFolder"] !== "string"
  ) {
    return null;
  }

  const workspaceFolder = config["workspaceFolder"].trim();
  if (!workspaceFolder) {
    return null;
  }

  return path.posix.normalize(
    workspaceFolder.replaceAll(
      "${localWorkspaceFolderBasename}",
      path.basename(workspacePath),
    ),
  );
};
