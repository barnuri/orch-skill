import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontMatter, scanSkills } from "./scan-skills";

const root = await mkdtemp(join(tmpdir(), "skills-scan-"));
const other = await mkdtemp(join(tmpdir(), "skills-scan-2-"));

async function skill(base: string, folder: string, body: string): Promise<void> {
  await mkdir(join(base, folder), { recursive: true });
  await writeFile(join(base, folder, "SKILL.md"), body);
}

describe("parseFrontMatter", () => {
  test("reads a single-line name and quoted description", () => {
    expect(parseFrontMatter('---\nname: xlsx\ndescription: "spreadsheet files"\n---\nbody')).toEqual({ name: "xlsx", description: "spreadsheet files" });
  });

  test("joins a folded description", () => {
    const text = "---\nname: orch\ndescription: >\n  orchestrate work\n  across harnesses\nmodel: x\n---\n";
    expect(parseFrontMatter(text)).toEqual({ name: "orch", description: "orchestrate work across harnesses" });
  });

  test("returns no name without front matter", () => {
    expect(parseFrontMatter("# just a doc")).toEqual({ name: null, description: "" });
  });
});

describe("scanSkills", () => {
  test("lists skill folders with name and description, sorted by name", async () => {
    await skill(root, "beta", "---\nname: beta\ndescription: second\n---\n");
    await skill(root, "alpha", "---\nname: alpha\ndescription: first\n---\n");
    await mkdir(join(root, "no-skill-md"), { recursive: true });
    expect(await scanSkills([root])).toEqual([
      { name: "alpha", description: "first" },
      { name: "beta", description: "second" },
    ]);
  });

  test("dedupes by name: the earlier root wins", async () => {
    await skill(other, "alpha", "---\nname: alpha\ndescription: from the second root\n---\n");
    await skill(other, "gamma", "---\nname: gamma\ndescription: only here\n---\n");
    const found = await scanSkills([root, other]);
    expect(found.find((s) => s.name === "alpha")?.description).toBe("first");
    expect(found.map((s) => s.name)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("uses the folder name when the front matter has no name, and skips missing roots", async () => {
    await skill(other, "folder-only", "---\ndescription: no name line\n---\n");
    const found = await scanSkills([join(root, "missing"), other]);
    expect(found).toContainEqual({ name: "folder-only", description: "no name line" });
  });
});
