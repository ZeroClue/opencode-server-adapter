import { describe, expect, it } from "vitest";
import { getOpenCodeServerConfigSchema } from "../config-schema.js";

describe("getOpenCodeServerConfigSchema", () => {
  it("includes the server, model, remote-sync, and agent-home fields", () => {
    const schema = getOpenCodeServerConfigSchema();
    const keys = schema.fields.map((f) => f.key);

    for (const expected of [
      "hostname",
      "port",
      "timeoutSec",
      "password",
      "command",
      "mode",
      "model",
      "cheapModel",
      "agent",
      "steps",
      "instructionsFilePath",
      "promptTemplate",
      "agentHomeDir",
      "agentHomeRemoteDir",
      "deployAgentHomePlugin",
      "paperclipApiUrl",
      "sshHost",
      "sshPort",
      "sshUsername",
      "sshPrivateKey",
      "sshKnownHosts",
      "strictHostKeyChecking",
      "remoteServerCwd",
      "cwd",
    ]) {
      expect(keys, `missing field "${expected}"`).toContain(expected);
    }
  });

  it("declares no duplicate keys", () => {
    const keys = getOpenCodeServerConfigSchema().fields.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("declares a combobox option set for mode", () => {
    const mode = getOpenCodeServerConfigSchema().fields.find((f) => f.key === "mode");
    expect(mode?.type).toBe("combobox");
    const values = (mode?.options ?? []).map((o) => o.value);
    expect(values).toContain("spawn");
    expect(values).toContain("connect");
  });

  it("gives number fields numeric defaults", () => {
    for (const f of getOpenCodeServerConfigSchema().fields.filter((f) => f.type === "number")) {
      expect(typeof f.default).toBe("number");
    }
  });
});
