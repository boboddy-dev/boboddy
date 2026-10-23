/**
 * The artifact marker wire format, shared by the SDK (`Artifact.embed` /
 * `Artifact.link` and definition validation) and core (draft resolution and
 * rendering):
 *
 * - `![caption](artifact:signal/<stepKey>/<signalKey>)` / `[label](...)`
 *   point at a declared artifact signal and are required.
 * - `![caption](artifact:<name-or-glob>)` / `[label](...)` point at any file
 *   under `artifactsDir` and are optional.
 *
 * Text inside `[...]` escapes `\`, `[` and `]` with a backslash. A ref with
 * whitespace or `<`/`>` is wrapped in `<...>`; otherwise `\`, `(` and `)` are
 * backslash-escaped.
 */

export const ARTIFACT_MARKER_SCHEME = "artifact:";
const SIGNAL_REF_PREFIX = "signal/";

export type ArtifactMarkerKind = "embed" | "link";

export type ArtifactMarkerRef =
  | {
      readonly type: "signal";
      readonly stepKey: string;
      readonly signalKey: string;
    }
  | { readonly type: "path"; readonly pattern: string };

/** A marker found in a piece of text. `start`/`end` are string offsets. */
export type ArtifactMarkerMatch = {
  readonly kind: ArtifactMarkerKind;
  /** The caption (embed) or label (link), unescaped. */
  readonly text: string;
  /** Everything after `artifact:`, unescaped. */
  readonly rawRef: string;
  readonly ref: ArtifactMarkerRef;
  readonly start: number;
  readonly end: number;
};

const MARKER_PATTERN =
  /(!?)\[((?:\\.|[^\\\]\n])*)\]\((?:<artifact:((?:\\.|[^\\<>\n])*)>|artifact:((?:\\.|[^\\()\s])*))\)/g;

const unescapeMarkerText = (value: string): string =>
  value.replace(/\\(.)/g, "$1");

const escapeMarkerText = (value: string): string =>
  value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\[\]]/g, "\\$&");

const formatMarkerDestination = (rawRef: string): string => {
  if (/[\s<>]/.test(rawRef)) {
    if (/[\n\r]/.test(rawRef)) {
      throw new Error("Artifact marker refs cannot contain line breaks.");
    }
    return `<${ARTIFACT_MARKER_SCHEME}${rawRef.replace(/[\\<>]/g, "\\$&")}>`;
  }
  return `${ARTIFACT_MARKER_SCHEME}${rawRef.replace(/[\\()]/g, "\\$&")}`;
};

/** Splits the part after `artifact:` into a signal or path ref. */
export function parseArtifactMarkerRef(rawRef: string): ArtifactMarkerRef {
  if (!rawRef.startsWith(SIGNAL_REF_PREFIX)) {
    return { type: "path", pattern: rawRef };
  }
  const rest = rawRef.slice(SIGNAL_REF_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash === -1
    ? { type: "signal", stepKey: rest, signalKey: "" }
    : {
        type: "signal",
        stepKey: rest.slice(0, slash),
        signalKey: rest.slice(slash + 1),
      };
}

export function formatArtifactMarkerRef(ref: ArtifactMarkerRef): string {
  return ref.type === "signal"
    ? `${SIGNAL_REF_PREFIX}${ref.stepKey}/${ref.signalKey}`
    : ref.pattern;
}

/** Builds a marker string. `text` is the caption (embed) or label (link). */
export function buildArtifactMarker(
  kind: ArtifactMarkerKind,
  ref: ArtifactMarkerRef,
  text: string,
): string {
  const rawRef = formatArtifactMarkerRef(ref);
  if (rawRef.length === 0) {
    throw new Error("Artifact marker refs cannot be empty.");
  }
  const bang = kind === "embed" ? "!" : "";
  return `${bang}[${escapeMarkerText(text)}](${formatMarkerDestination(rawRef)})`;
}

/** Every artifact marker in `text`, in order. Other links are ignored. */
export function findArtifactMarkers(text: string): ArtifactMarkerMatch[] {
  const matches: ArtifactMarkerMatch[] = [];
  for (const match of text.matchAll(MARKER_PATTERN)) {
    const [whole, bang, label, bracketedRef, bareRef] = match;
    const rawRef = unescapeMarkerText(bracketedRef ?? bareRef ?? "");
    matches.push({
      kind: bang === "!" ? "embed" : "link",
      text: unescapeMarkerText(label ?? ""),
      rawRef,
      ref: parseArtifactMarkerRef(rawRef),
      start: match.index,
      end: match.index + whole.length,
    });
  }
  return matches;
}
