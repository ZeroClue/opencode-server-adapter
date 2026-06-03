import { describe, expect, it } from "vitest";
import { sessionCodec } from "../codec.js";

describe("sessionCodec", () => {
  it("deserializes sessionId from various key formats", () => {
    expect(sessionCodec.deserialize({ sessionId: "ses_123" })).toEqual({ sessionId: "ses_123" });
    expect(sessionCodec.deserialize({ session_id: "ses_456" })).toEqual({ sessionId: "ses_456" });
    expect(sessionCodec.deserialize({ sessionID: "ses_789" })).toEqual({ sessionId: "ses_789" });
  });

  it("returns null for empty or missing sessionId", () => {
    expect(sessionCodec.deserialize({})).toBeNull();
    expect(sessionCodec.deserialize({ sessionId: "" })).toBeNull();
    expect(sessionCodec.deserialize(null)).toBeNull();
    expect(sessionCodec.deserialize("not an object")).toBeNull();
  });

  it("serializes and deserializes round-trips correctly", () => {
    const params = { sessionId: "ses_abc", cwd: "/tmp" };
    const serialized = sessionCodec.serialize(params);
    expect(serialized).toEqual({ sessionId: "ses_abc", cwd: "/tmp" });
    expect(sessionCodec.deserialize(serialized)).toEqual(params);
  });

  it("extracts cwd from workdir and folder fallbacks", () => {
    expect(sessionCodec.deserialize({ sessionId: "s1", workdir: "/workspace" }))
      .toEqual({ sessionId: "s1", cwd: "/workspace" });
    expect(sessionCodec.deserialize({ sessionId: "s1", folder: "/home" }))
      .toEqual({ sessionId: "s1", cwd: "/home" });
  });

  it("getDisplayId returns sessionId string", () => {
    expect(sessionCodec.getDisplayId!({ sessionId: "ses_123" })).toBe("ses_123");
    expect(sessionCodec.getDisplayId!(null)).toBeNull();
  });
});