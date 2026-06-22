/**
 * Parser and formatter for Fluxer outbound target strings.
 */
import type { FluxerTarget } from "./types.js";

const FLUXER_SNOWFLAKE_RE = /^\d{5,}$/u;

/**
 * Parses `channel:<channel_id>`, `dm:<user_id>`, or a bare Fluxer snowflake as
 * a channel target.
 */
export function parseFluxerTarget(raw: string): FluxerTarget {
  const value = raw.trim();
  if (!value) {
    throw new Error("Fluxer target is required");
  }
  const [prefix, ...rest] = value.split(":");
  const body = rest.join(":").trim();
  if (prefix === "channel" && body) {
    return { chatType: "group", kind: "channel", id: body };
  }
  if (prefix === "dm" && body) {
    return { chatType: "direct", kind: "dm", id: body };
  }
  if (!body && FLUXER_SNOWFLAKE_RE.test(value)) {
    return { chatType: "group", kind: "channel", id: value };
  }
  throw new Error(`Unsupported Fluxer target: ${raw}`);
}

/** Formats a parsed Fluxer target back into canonical target syntax. */
export function buildFluxerTarget(target: FluxerTarget): string {
  return `${target.kind}:${target.id}`;
}

/** Normalizes user-entered Fluxer target text for channel routing. */
export function normalizeFluxerTarget(raw: string): string {
  return buildFluxerTarget(parseFluxerTarget(raw));
}

/** Reports whether a target string can be offered to the Fluxer parser. */
export function looksLikeFluxerTarget(raw: string): boolean {
  const value = raw.trim();
  return /^(channel|dm):/i.test(value) || FLUXER_SNOWFLAKE_RE.test(value);
}
