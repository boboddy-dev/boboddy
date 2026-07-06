import { z } from "zod";

export const artifactKindSchema = z.enum(["generic", "playwright-trace"]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;
