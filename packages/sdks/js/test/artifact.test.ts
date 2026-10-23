import { describe, expect, test } from "bun:test";
import { z as plainZod } from "zod";
import { z } from "../src";
import {
  Artifact,
  ArtifactTypes,
  artifact,
  normalizeArtifactAccept,
} from "../src/definitions/artifacts";

describe("normalizeArtifactAccept", () => {
  test.concurrent("treats an omitted list as accepting any file", () => {
    expect(normalizeArtifactAccept(undefined)).toEqual([]);
    expect(normalizeArtifactAccept([])).toEqual([]);
  });

  test.concurrent("keeps order and drops duplicates", () => {
    expect(normalizeArtifactAccept([".mp4", ".webm", ".mp4"])).toEqual([
      ".mp4",
      ".webm",
    ]);
  });

  test.concurrent("accepts multi-part extensions", () => {
    expect(normalizeArtifactAccept([".tar.gz"])).toEqual([".tar.gz"]);
  });

  test.concurrent("rejects an upper-case entry with a hint", () => {
    expect(() => normalizeArtifactAccept(["MP4"])).toThrow(
      "Did you mean `.mp4`?",
    );
    expect(() => normalizeArtifactAccept([".MP4"])).toThrow(
      '".MP4" must be lower-case. Did you mean `.mp4`?',
    );
  });

  test.concurrent("rejects an entry with no leading dot", () => {
    expect(() => normalizeArtifactAccept(["mp4"])).toThrow(
      '"mp4" must be a file extension starting with a dot. Did you mean `.mp4`?',
    );
  });

  test.concurrent("rejects an entry that is not an extension", () => {
    expect(() => normalizeArtifactAccept([".mp 4"])).toThrow(
      '".mp 4" is not a valid file extension.',
    );
    expect(() => normalizeArtifactAccept(["."])).toThrow(
      "is not a valid file extension",
    );
  });

  test.concurrent("reports every bad entry at once", () => {
    expect(() => normalizeArtifactAccept(["MP4", "gif", ".png"])).toThrow(
      /"MP4".*"gif"/,
    );
  });

  test.concurrent("presets expand to plain extensions", () => {
    expect(normalizeArtifactAccept([...ArtifactTypes.video, ".gif"])).toEqual([
      ".mp4",
      ".webm",
      ".mov",
      ".gif",
    ]);
    expect(normalizeArtifactAccept(ArtifactTypes.image)).toEqual([
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".svg",
    ]);
  });
});

describe("artifact()", () => {
  test.concurrent("serialises to a string with the artifact keyword", () => {
    const schema = plainZod.object({
      video: artifact({ accept: [".mp4", ".mp4", ".webm"] }),
      any: artifact(),
    });
    expect(plainZod.toJSONSchema(schema)).toMatchObject({
      properties: {
        video: {
          type: "string",
          "x-boboddy-artifact": { accept: [".mp4", ".webm"] },
        },
        any: { type: "string", "x-boboddy-artifact": { accept: [] } },
      },
    });
  });

  test.concurrent("throws at definition time for a bad accept list", () => {
    expect(() => artifact({ accept: ["MP4"] })).toThrow("artifact({ accept })");
  });

  test.concurrent("keeps the keyword through nullable and describe", () => {
    const schema = plainZod.object({
      video: artifact({ accept: [".mp4"] })
        .nullable()
        .describe("Repro video"),
    });
    expect(plainZod.toJSONSchema(schema).properties?.["video"]).toMatchObject({
      description: "Repro video",
      anyOf: [
        { type: "string", "x-boboddy-artifact": { accept: [".mp4"] } },
        { type: "null" },
      ],
    });
  });

  test.concurrent("parses plain strings", () => {
    expect(artifact().parse("out/video.mp4")).toBe(
      Artifact.path("out/video.mp4"),
    );
    expect(() => artifact().parse(42)).toThrow();
  });

  test.concurrent("z re-exports Zod with artifact attached", () => {
    expect(z.artifact).toBe(artifact);
    expect(typeof z.object).toBe("function");
    expect(z.toJSONSchema(z.object({ a: z.artifact() }))).toMatchObject({
      properties: { a: { "x-boboddy-artifact": { accept: [] } } },
    });
  });
});

describe("Artifact.path", () => {
  test.concurrent("returns the relative path unchanged", () => {
    const path: string = Artifact.path("shots/one.png");
    expect(path).toBe("shots/one.png");
  });
});
