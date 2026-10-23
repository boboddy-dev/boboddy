import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  EMBEDDABLE_ARTIFACT_EXTENSIONS,
  artifactAcceptsFile,
  artifactFileExtension,
  findArtifactFields,
  isEmbeddableArtifactExtension,
  matchArtifactNode,
} from "../src/contracts/artifacts";
import { artifact } from "../src/definitions/artifacts";

const KEYWORD = "x-boboddy-artifact";

describe("findArtifactFields", () => {
  test.concurrent("returns nothing for a missing or plain schema", () => {
    expect(findArtifactFields(null)).toEqual([]);
    expect(findArtifactFields(undefined)).toEqual([]);
    expect(
      findArtifactFields(z.toJSONSchema(z.object({ a: z.string() }))),
    ).toEqual([]);
  });

  test.concurrent("finds top-level, nullable and nested fields", () => {
    const schema = z.toJSONSchema(
      z.object({
        reproVideo: artifact({ accept: [".mp4"] }).describe("The repro"),
        trace: artifact().nullable(),
        details: z.object({ screenshot: artifact({ accept: [".png"] }) }),
        summary: z.string(),
      }),
    );
    expect(findArtifactFields(schema)).toEqual([
      {
        path: "reproVideo",
        accept: [".mp4"],
        nullable: false,
        description: "The repro",
        inArray: false,
      },
      {
        path: "trace",
        accept: [],
        nullable: true,
        description: null,
        inArray: false,
      },
      {
        path: "details.screenshot",
        accept: [".png"],
        nullable: false,
        description: null,
        inArray: false,
      },
    ]);
  });

  test.concurrent("marks fields inside arrays", () => {
    const schema = z.toJSONSchema(
      z.object({
        shots: z.array(artifact({ accept: [".png"] })),
        runs: z.array(z.object({ video: artifact() })),
      }),
    );
    expect(
      findArtifactFields(schema).map(({ path, inArray }) => ({
        path,
        inArray,
      })),
    ).toEqual([
      { path: "shots[]", inArray: true },
      { path: "runs[].video", inArray: true },
    ]);
  });

  test.concurrent("follows local $refs and union branches", () => {
    const schema = {
      type: "object",
      properties: {
        clip: { $ref: "#/$defs/clip" },
        either: {
          oneOf: [
            {
              type: "object",
              properties: { a: { type: "string", [KEYWORD]: { accept: [] } } },
            },
            { type: "object", properties: { b: { type: "number" } } },
          ],
        },
      },
      $defs: { clip: { type: "string", [KEYWORD]: { accept: [".webm"] } } },
    };
    expect(findArtifactFields(schema).map((field) => field.path)).toEqual([
      "clip",
      "either.a",
    ]);
  });

  test.concurrent("survives a self-referencing $ref", () => {
    const schema = {
      type: "object",
      properties: { loop: { $ref: "#" } },
    };
    expect(findArtifactFields(schema)).toEqual([]);
  });

  test.concurrent("does not treat the root as a field", () => {
    expect(findArtifactFields({ type: "string", [KEYWORD]: {} })).toEqual([]);
  });
});

describe("matchArtifactNode", () => {
  test.concurrent("matches direct and nullable nodes only", () => {
    const direct = { type: "string", [KEYWORD]: { accept: [".png"] } };
    expect(matchArtifactNode(direct)).toEqual({
      accept: [".png"],
      nullable: false,
      description: null,
    });
    expect(
      matchArtifactNode({ anyOf: [direct, { type: "null" }] }),
    ).toMatchObject({ nullable: true });
    expect(
      matchArtifactNode({ anyOf: [direct, { type: "number" }] }),
    ).toBeNull();
    expect(matchArtifactNode({ type: "string" })).toBeNull();
    expect(matchArtifactNode(true)).toBeNull();
  });
});

describe("artifact extension helpers", () => {
  test.concurrent("extracts lower-cased extensions", () => {
    expect(artifactFileExtension("out/Video.MP4")).toBe(".mp4");
    expect(artifactFileExtension("README")).toBe("");
    expect(artifactFileExtension(".hidden")).toBe("");
    expect(artifactFileExtension("dir.d/file")).toBe("");
  });

  test.concurrent("checks files against accept", () => {
    expect(artifactAcceptsFile([], "anything.bin")).toBe(true);
    expect(artifactAcceptsFile([".mp4"], "clip.MP4")).toBe(true);
    expect(artifactAcceptsFile([".mp4"], "clip.webm")).toBe(false);
  });

  test.concurrent("only Jira embeds in v1", () => {
    expect(EMBEDDABLE_ARTIFACT_EXTENSIONS.jira).toEqual([
      ".png",
      ".gif",
      ".mp4",
      ".webm",
    ]);
    expect(isEmbeddableArtifactExtension("jira", ".MP4")).toBe(true);
    expect(isEmbeddableArtifactExtension("jira", ".mov")).toBe(false);
    expect(isEmbeddableArtifactExtension("github", ".png")).toBe(false);
    expect(isEmbeddableArtifactExtension("bitbucket", ".png")).toBe(false);
  });
});
