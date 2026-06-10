export const AI_IMAGE_REGISTRY = "ghcr.io/boboddy-dev/boboddy/ai-worker";
export const AI_IMAGE_TAG = "v0.1.38-alpha";

const PINNED_IMAGE = `${AI_IMAGE_REGISTRY}:${AI_IMAGE_TAG}`;

export type AiImage = {
  /** Full image reference, e.g. "ghcr.io/boboddy-dev/boboddy/ai-worker:v0.1.38-alpha" */
  readonly ref: string;
};

/**
 * Resolves the AI worker image to use for a runtime session.
 *
 * Uses PROJECT_RUNTIME_SESSION_AI_IMAGE if set (e.g. for local dev overrides),
 * otherwise falls back to the image pinned in this file.
 */
export function resolveAiImage(): AiImage {
  const ref =
    process.env["PROJECT_RUNTIME_SESSION_AI_IMAGE"]?.trim() || PINNED_IMAGE;
  return { ref };
}
