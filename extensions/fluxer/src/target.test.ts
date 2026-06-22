// Fluxer tests cover target parsing and normalization.
import { describe, expect, it } from "vitest";
import { buildFluxerTarget, normalizeFluxerTarget, parseFluxerTarget } from "./target.js";

describe("Fluxer targets", () => {
  it("parses channel and bare snowflake targets", () => {
    expect(parseFluxerTarget("channel:123456789")).toEqual({
      chatType: "group",
      kind: "channel",
      id: "123456789",
    });
    expect(normalizeFluxerTarget("123456789")).toBe("channel:123456789");
  });

  it("parses dm targets", () => {
    expect(buildFluxerTarget(parseFluxerTarget("dm:987654321"))).toBe("dm:987654321");
    expect(parseFluxerTarget("dm:987654321")).toEqual({
      chatType: "direct",
      kind: "dm",
      id: "987654321",
    });
  });

  it("rejects ambiguous bare names", () => {
    expect(() => parseFluxerTarget("general")).toThrow("Unsupported Fluxer target");
  });
});
