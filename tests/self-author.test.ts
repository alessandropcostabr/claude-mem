import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  isSubstantiveTool,
  decideSelfAuthor,
  recordSubstantiveEvent,
  getSubstantiveCount,
  resetSubstantiveCount,
  getSelfAuthorConfig,
} from "../src/shared/self-author.js";

describe("isSubstantiveTool", () => {
  it("treats mutating tools as substantive", () => {
    expect(isSubstantiveTool("Edit")).toBe(true);
    expect(isSubstantiveTool("Write")).toBe(true);
    expect(isSubstantiveTool("MultiEdit")).toBe(true);
    expect(isSubstantiveTool("Bash")).toBe(true);
    expect(isSubstantiveTool("NotebookEdit")).toBe(true);
  });

  it("treats read-only tools as non-substantive", () => {
    expect(isSubstantiveTool("Read")).toBe(false);
    expect(isSubstantiveTool("Grep")).toBe(false);
    expect(isSubstantiveTool("Glob")).toBe(false);
    expect(isSubstantiveTool("TodoWrite")).toBe(false);
  });
});

describe("decideSelfAuthor", () => {
  const base = { enabled: true, stopHookActive: false, substantiveCount: 5, threshold: 4 };

  it("blocks to self-author when substantive activity reaches the threshold", () => {
    expect(decideSelfAuthor(base).block).toBe(true);
  });

  it("blocks when the substantive count equals the threshold exactly", () => {
    expect(decideSelfAuthor({ ...base, substantiveCount: 4, threshold: 4 }).block).toBe(true);
  });

  it("does not block when self-authoring is disabled", () => {
    expect(decideSelfAuthor({ ...base, enabled: false }).block).toBe(false);
  });

  it("does not block on Stop re-entry (the self-authoring turn itself)", () => {
    expect(decideSelfAuthor({ ...base, stopHookActive: true }).block).toBe(false);
  });

  it("does not block when activity is below the threshold", () => {
    expect(decideSelfAuthor({ ...base, substantiveCount: 3, threshold: 4 }).block).toBe(false);
  });
});

describe("substantive event counter (persistent across hook processes)", () => {
  it("counts to zero for an unseen session", () => {
    const dir = mkdtempSync(join(tmpdir(), "sa-"));
    try {
      expect(getSubstantiveCount("sess-1", dir)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accumulates recorded events and resets to zero", () => {
    const dir = mkdtempSync(join(tmpdir(), "sa-"));
    try {
      recordSubstantiveEvent("sess-1", dir);
      recordSubstantiveEvent("sess-1", dir);
      recordSubstantiveEvent("sess-1", dir);
      expect(getSubstantiveCount("sess-1", dir)).toBe(3);

      resetSubstantiveCount("sess-1", dir);
      expect(getSubstantiveCount("sess-1", dir)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps counts isolated per session", () => {
    const dir = mkdtempSync(join(tmpdir(), "sa-"));
    try {
      recordSubstantiveEvent("sess-A", dir);
      recordSubstantiveEvent("sess-B", dir);
      recordSubstantiveEvent("sess-B", dir);
      expect(getSubstantiveCount("sess-A", dir)).toBe(1);
      expect(getSubstantiveCount("sess-B", dir)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("getSelfAuthorConfig", () => {
  it("defaults to disabled (opt-in) with a conservative threshold", () => {
    const cfg = getSelfAuthorConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.threshold).toBe(4);
  });

  it("enables only on the explicit 'true' flag and parses the threshold", () => {
    const cfg = getSelfAuthorConfig({
      CLAUDE_MEM_SELF_AUTHOR_ENABLED: "true",
      CLAUDE_MEM_SELF_AUTHOR_THRESHOLD: "8",
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.threshold).toBe(8);
  });

  it("falls back to the default threshold on a non-numeric value", () => {
    const cfg = getSelfAuthorConfig({ CLAUDE_MEM_SELF_AUTHOR_THRESHOLD: "abc" });
    expect(cfg.threshold).toBe(4);
  });

  it("derives the state dir from CLAUDE_MEM_DATA_DIR", () => {
    const cfg = getSelfAuthorConfig({ CLAUDE_MEM_DATA_DIR: "/custom/data" });
    expect(cfg.stateDir).toBe("/custom/data/self-author");
  });
});
