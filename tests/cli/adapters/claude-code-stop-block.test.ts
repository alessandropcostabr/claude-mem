import { describe, it, expect } from "bun:test";
import { claudeCodeAdapter } from "../../../src/cli/adapters/claude-code.js";

describe("claudeCodeAdapter formatOutput — Stop block passthrough", () => {
  it("emits decision and reason so the Stop hook actually blocks", () => {
    const out = claudeCodeAdapter.formatOutput({
      continue: true,
      decision: "block",
      reason: "please save observations",
    }) as Record<string, unknown>;

    expect(out.decision).toBe("block");
    expect(out.reason).toBe("please save observations");
  });

  it("emits continue when present", () => {
    const out = claudeCodeAdapter.formatOutput({ continue: true }) as Record<string, unknown>;
    expect(out.continue).toBe(true);
  });

  it("does not emit decision for a plain continue result", () => {
    const out = claudeCodeAdapter.formatOutput({ continue: true, suppressOutput: true }) as Record<string, unknown>;
    expect(out.decision).toBeUndefined();
  });
});

describe("claudeCodeAdapter normalizeInput — stop_hook_active", () => {
  it("maps stop_hook_active to stopHookActive (loop guard)", () => {
    const input = claudeCodeAdapter.normalizeInput({
      session_id: "s1",
      cwd: process.cwd(),
      stop_hook_active: true,
    });
    expect(input.stopHookActive).toBe(true);
  });
});
