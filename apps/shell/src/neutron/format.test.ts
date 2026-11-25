import { describe, expect, it } from "vitest";

import {
  buildBatchRenamePlan,
  formatBytes,
  highlightFuzzyName,
  parseBreadcrumbs,
} from "./format";

describe("neutron formatting helpers", () => {
  it("formats byte sizes concisely", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(25 * 1024 * 1024)).toBe("25 MB");
  });

  it("builds breadcrumbs across local, remote, and archive locations", () => {
    expect(parseBreadcrumbs("/Users/razeen/Github", "local")).toEqual([
      { label: "/", path: "/" },
      { label: "Users", path: "/Users" },
      { label: "razeen", path: "/Users/razeen" },
      { label: "Github", path: "/Users/razeen/Github" },
    ]);

    expect(
      parseBreadcrumbs("remote://kagutsuchi/Users/razeen/Research", "remote", "kagutsuchi"),
    ).toEqual([
      { label: "kagutsuchi", path: "remote://kagutsuchi/" },
      { label: "Users", path: "remote://kagutsuchi/Users" },
      { label: "razeen", path: "remote://kagutsuchi/Users/razeen" },
      { label: "Research", path: "remote://kagutsuchi/Users/razeen/Research" },
    ]);

    expect(parseBreadcrumbs("archive:///tmp/a.zip!docs/sub", "archive")).toEqual([
      { label: "/", path: "/" },
      { label: "tmp", path: "/tmp" },
      { label: "a.zip", path: "archive:///tmp/a.zip!" },
      { label: "docs", path: "archive:///tmp/a.zip!docs" },
      { label: "sub", path: "archive:///tmp/a.zip!docs/sub" },
    ]);
  });

  it("plans batch renames preserving file extensions and numbering", () => {
    const plan = buildBatchRenamePlan(
      [
        { name: "draft_01.md", path: "/tmp/draft_01.md" },
        { name: "draft_02.md", path: "/tmp/draft_02.md" },
      ],
      { find: "draft", replace: "final", prefix: "v{n}_", suffix: "" },
    );
    expect(plan).toEqual([
      {
        from: "/tmp/draft_01.md",
        oldName: "draft_01.md",
        newName: "v01_final_01.md",
        changed: true,
      },
      {
        from: "/tmp/draft_02.md",
        oldName: "draft_02.md",
        newName: "v02_final_02.md",
        changed: true,
      },
    ]);
  });

  it("segments fuzzy match highlight runs", () => {
    expect(highlightFuzzyName("Sidebar.tsx", [0, 4, 8])).toEqual([
      { text: "S", hit: true },
      { text: "ide", hit: false },
      { text: "b", hit: true },
      { text: "ar.", hit: false },
      { text: "t", hit: true },
      { text: "sx", hit: false },
    ]);
  });
});
