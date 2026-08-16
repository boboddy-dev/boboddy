import { open } from "node:fs/promises";
import type { ArtifactKind } from "@boboddy/sdk/contracts/artifacts";

/**
 * Classifies a collected artifact by inspecting its actual contents rather
 * than trusting its name. Playwright traces are zip archives, and Playwright's
 * own Trace Viewer accepts a zip as a trace based on one rule: it contains at
 * least one entry whose name ends in `.trace` (see
 * `packages/isomorphic/trace/traceLoader.ts` in `playwright-core`). That
 * covers every writer shape Playwright itself produces — the raw library's
 * `trace.trace`/`trace.network`/`trace.stacks`, and the `@playwright/test`
 * runner's `test.trace` / ordinal-prefixed multi-context entries
 * (`0-trace.trace`, `1-trace.trace`, ...).
 *
 * We mirror that exact check by reading only the zip's central directory
 * (entry names), never decompressing entry bodies — so this is near-free even
 * for large trace archives, and non-`.zip` artifacts never pay the cost of
 * opening the file at all.
 */
export async function detectArtifactKind(
  relativeStorePath: string,
  sourcePath: string,
): Promise<ArtifactKind> {
  const base = relativeStorePath.toLowerCase().split("/").pop() ?? "";
  if (!base.endsWith(".zip")) {
    return "generic";
  }

  const entryNames = await readZipEntryNames(sourcePath).catch(() => []);
  const isTrace = entryNames.some((name) => TRACE_ENTRY_PATTERN.test(name));
  return isTrace ? "playwright-trace" : "generic";
}

const TRACE_ENTRY_PATTERN = /\.trace$/;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_FILE_HEADER_SIGNATURE = 0x02014b50;
const EOCD_RECORD_SIZE = 22;
const MAX_ZIP_COMMENT_SIZE = 0xffff;
const CENTRAL_DIRECTORY_FILE_HEADER_SIZE = 46;

/**
 * Reads a zip file's central directory and returns every entry name, without
 * decompressing any entry body. Returns `[]` (rather than throwing) if the
 * file isn't a well-formed zip, so callers can treat "not a zip" the same as
 * "no trace entry found".
 *
 * Does not support the ZIP64 format (archives with 64k+ entries or a central
 * directory larger than 4GB) — Playwright trace archives never approach
 * those limits, and an unsupported archive fails closed to an empty entry
 * list rather than misparsing.
 */
async function readZipEntryNames(filePath: string): Promise<string[]> {
  const file = await open(filePath, "r");
  try {
    const { size } = await file.stat();
    const tailSize = Math.min(size, EOCD_RECORD_SIZE + MAX_ZIP_COMMENT_SIZE);
    const tail = Buffer.alloc(tailSize);
    await file.read(tail, 0, tailSize, size - tailSize);

    const eocdOffset = findEocdOffset(tail);
    if (eocdOffset === -1) {
      return [];
    }

    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const centralDirectoryOffset = tail.readUInt32LE(eocdOffset + 16);
    const centralDirectorySize =
      size - tailSize + eocdOffset - centralDirectoryOffset;
    if (centralDirectorySize < 0) {
      return [];
    }

    const centralDirectory = Buffer.alloc(centralDirectorySize);
    await file.read(
      centralDirectory,
      0,
      centralDirectorySize,
      centralDirectoryOffset,
    );

    return readEntryNames(centralDirectory, entryCount);
  } finally {
    await file.close();
  }
}

/** Scans backwards for the End Of Central Directory record signature. */
function findEocdOffset(tail: Buffer): number {
  for (let offset = tail.length - EOCD_RECORD_SIZE; offset >= 0; offset--) {
    if (tail.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  return -1;
}

/** Walks fixed-size central directory file headers, collecting entry names. */
function readEntryNames(
  centralDirectory: Buffer,
  entryCount: number,
): string[] {
  const names: string[] = [];
  let offset = 0;

  for (
    let i = 0;
    i < entryCount &&
    offset + CENTRAL_DIRECTORY_FILE_HEADER_SIZE <= centralDirectory.length;
    i++
  ) {
    if (
      centralDirectory.readUInt32LE(offset) !==
      CENTRAL_DIRECTORY_FILE_HEADER_SIGNATURE
    ) {
      break;
    }

    const nameLength = centralDirectory.readUInt16LE(offset + 28);
    const extraFieldLength = centralDirectory.readUInt16LE(offset + 30);
    const commentLength = centralDirectory.readUInt16LE(offset + 32);
    const nameStart = offset + CENTRAL_DIRECTORY_FILE_HEADER_SIZE;

    names.push(
      centralDirectory.toString("utf8", nameStart, nameStart + nameLength),
    );
    offset = nameStart + nameLength + extraFieldLength + commentLength;
  }

  return names;
}
