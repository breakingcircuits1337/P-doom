/**
 * Artifacts — files an agent commits under `artifacts/<thread>/` and links from
 * the comment that announces them.
 *
 * Design note: the link lives in the *body* (rendered), but the machine-readable
 * declaration lives in the `ARTIFACTS` *header*, because that is the only place
 * a path can survive a round trip exactly. `renderArtifactFooter` produces the
 * human-facing links; `stripArtifactFooter` removes them again so
 * `parseMessage(renderMessage(...))` still round-trips.
 */

import { issue, type ProtocolIssue } from "./errors.js";
import type { ArtifactRef, ChannelRef } from "./types.js";
import { channelId } from "./thread.js";

export const ARTIFACT_ROOT = "artifacts";
/** Invisible marker that begins the generated footer. */
export const FOOTER_MARKER = "<!-- llm-messageboard:artifacts -->";
export const MAX_ARTIFACT_DEPTH = 8;
export const MAX_ARTIFACTS = 50;
const NAME_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const MAX_PATH_LENGTH = 240;

/**
 * Reject anything that could escape the artifact directory or create a hidden
 * file: absolute paths, `..`, empty segments, leading dots, backslashes,
 * control characters, and absurd depth.
 */
export function validateArtifactName(name: string): ProtocolIssue | undefined {
  const bad = (message: string): ProtocolIssue =>
    issue("invalid-artifact-name", message, "ARTIFACTS");

  if (name.length === 0) return bad("artifact name is empty");
  if (name.length > MAX_PATH_LENGTH) {
    return bad(`artifact name exceeds ${MAX_PATH_LENGTH} characters`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return bad("artifact name contains control characters");
  }
  if (name.startsWith("/") || name.startsWith("\\")) {
    return bad("artifact name must be relative to the artifact directory");
  }
  if (name.includes("\\")) {
    return bad("artifact name must use forward slashes");
  }
  const segments = name.split("/");
  if (segments.length > MAX_ARTIFACT_DEPTH) {
    return bad(`artifact name is deeper than ${MAX_ARTIFACT_DEPTH} segments`);
  }
  for (const segment of segments) {
    if (segment.length === 0) return bad("artifact name has an empty segment");
    if (segment === "." || segment === "..") {
      return bad("artifact name may not contain '.' or '..' segments");
    }
    if (segment.startsWith(".")) {
      return bad(`artifact segment "${segment}" may not start with a dot`);
    }
    if (!NAME_SEGMENT.test(segment)) {
      return bad(`artifact segment "${segment}" has illegal characters`);
    }
  }
  return undefined;
}

/**
 * Artifact directory for a thread: `artifacts/42` or `artifacts/42/plan`.
 * Keyed by issue number (not `owner/repo`) because artifacts live *inside* the
 * repository, which already establishes the owner and repo.
 */
export function artifactDir(channel: ChannelRef, sub?: string | null): string {
  const base = `${ARTIFACT_ROOT}/${channel.issue}`;
  return sub === undefined || sub === null || sub === "" ? base : `${base}/${sub}`;
}

/** Full repo-relative path for a file in a thread's artifact directory. */
export function artifactPath(
  channel: ChannelRef,
  sub: string | null,
  name: string,
): string {
  const problem = validateArtifactName(name);
  if (problem) throw new Error(problem.message);
  return `${artifactDir(channel, sub)}/${name}`;
}

export function refFromPath(path: string): ArtifactRef {
  const segments = path.split("/");
  return { path, name: segments[segments.length - 1] ?? path };
}

/** Parse the value of an `ARTIFACTS:` header — a comma-separated path list. */
export function parseArtifactList(value: string): {
  refs: ArtifactRef[];
  issues: ProtocolIssue[];
} {
  const refs: ArtifactRef[] = [];
  const problems: ProtocolIssue[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(",")) {
    const name = raw.trim();
    if (name.length === 0) continue;
    const problem = validateArtifactName(name);
    if (problem) {
      problems.push(problem);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    // `name` here is thread-relative, so the display name is its basename.
    refs.push(refFromPath(name));
  }
  if (refs.length > MAX_ARTIFACTS) {
    problems.push(
      issue(
        "too-many-artifacts",
        `at most ${MAX_ARTIFACTS} artifacts per message`,
        "ARTIFACTS",
      ),
    );
  }
  return { refs: problems.length > 0 ? refs.slice(0, MAX_ARTIFACTS) : refs, issues: problems };
}

export function formatArtifactList(refs: readonly ArtifactRef[]): string {
  return refs.map((ref) => ref.path).join(", ");
}

export interface ArtifactRenderContext {
  channel: ChannelRef;
  sub?: string | null;
  /** Branch/ref for blob links. Omit to render plain code paths. */
  ref?: string;
  /** GitHub base URL, for enterprise installs. Defaults to https://github.com. */
  serverUrl?: string;
}

export function blobUrl(
  ctx: ArtifactRenderContext,
  path: string,
): string | undefined {
  if (ctx.ref === undefined || ctx.ref.length === 0) return undefined;
  const server = ctx.serverUrl ?? "https://github.com";
  const base = server.replace(/\/+$/, "");
  const repo = `${ctx.channel.owner}/${ctx.channel.repo}`;
  return `${base}/${repo}/blob/${encodeURIComponent(ctx.ref)}/${path}`;
}

/** Visible artifact footer appended to a published comment. */
export function renderArtifactFooter(
  refs: readonly ArtifactRef[],
  ctx: ArtifactRenderContext,
): string {
  if (refs.length === 0) return "";
  const dir = artifactDir(ctx.channel, ctx.sub);
  const lines = refs.map((ref) => {
    const path = `${dir}/${ref.path}`;
    const url = blobUrl(ctx, path);
    return url === undefined
      ? `- \`${ref.path}\` — \`${path}\``
      : `- [\`${ref.path}\`](${url}) — \`${path}\``;
  });
  const count = refs.length === 1 ? "1 file" : `${refs.length} files`;
  return [
    FOOTER_MARKER,
    "**Artifacts**",
    "",
    ...lines,
    "",
    `<sub>${count} · \`${dir}/\`</sub>`,
  ].join("\n");
}

/** Remove a generated footer, leaving the authored body untouched. */
export function stripArtifactFooter(body: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === FOOTER_MARKER);
  if (start === -1) return body;
  return lines.slice(0, start).join("\n").replace(/[\s]+$/, "");
}

/** Compose a full comment body: authored body, then the generated footer. */
export function composeCommentBody(
  body: string,
  refs: readonly ArtifactRef[],
  ctx: ArtifactRenderContext,
): string {
  const footer = renderArtifactFooter(refs, ctx);
  if (footer.length === 0) return body;
  return body.length === 0 ? footer : `${body}\n\n${footer}`;
}

export function artifactChannelLabel(channel: ChannelRef, sub?: string | null): string {
  const dir = artifactDir(channel, sub);
  return `${channelId(channel)} → ${dir}/`;
}
