import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import repoPackage from "../../../package.json";
import { bugReportUrl, parseRepoRef, repoUrl } from "./bug-report";
import { BugReportLink, RepoLink } from "./BugReportLink";

const ISSUES = "https://github.com/barnuri/orch-skill/issues";

describe("bugReportUrl derivation", () => {
  test("https repository URL with .git gives the issues URL", () => {
    expect(bugReportUrl({ repository: "https://github.com/barnuri/orch-skill.git" })).toBe(ISSUES);
  });

  test("git+https object form (package.json style) gives the issues URL", () => {
    expect(bugReportUrl({ repository: { type: "git", url: "git+https://github.com/barnuri/orch-skill.git" } })).toBe(ISSUES);
  });

  test("scp-style ssh remote gives the issues URL", () => {
    expect(bugReportUrl({ repository: "git@github.com:barnuri/orch-skill.git" })).toBe(ISSUES);
  });

  test("github: shorthand gives the issues URL", () => {
    expect(bugReportUrl({ repository: "github:barnuri/orch-skill" })).toBe(ISSUES);
  });

  test("GitHub repo ignores homepage and still targets new issue", () => {
    expect(bugReportUrl({ repository: "https://github.com/barnuri/orch-skill", homepage: "https://example.com/docs" })).toBe(ISSUES);
  });
});

describe("bugReportUrl fallback to the repository homepage", () => {
  test("non-GitHub repository with no homepage falls back to the repo URL", () => {
    expect(bugReportUrl({ repository: "https://gitlab.com/acme/tool.git" })).toBe("https://gitlab.com/acme/tool");
  });

  test("non-GitHub repository with a homepage uses the homepage", () => {
    expect(bugReportUrl({ repository: "https://gitlab.com/acme/tool.git", homepage: "https://acme.example/tool" })).toBe(
      "https://acme.example/tool",
    );
  });

  test("homepage alone (no repository) is used", () => {
    expect(bugReportUrl({ homepage: "https://acme.example/tool" })).toBe("https://acme.example/tool");
  });

  test("unparseable repository falls back to the homepage", () => {
    expect(bugReportUrl({ repository: "not a repo", homepage: "https://acme.example/tool" })).toBe("https://acme.example/tool");
  });

  test("a non-http homepage is rejected", () => {
    expect(bugReportUrl({ homepage: "javascript:alert(1)" })).toBeNull();
  });

  test("no metadata resolves to null, so the link is not rendered", () => {
    expect(bugReportUrl({})).toBeNull();
    expect(bugReportUrl({ repository: "", homepage: null })).toBeNull();
  });
});

describe("parseRepoRef", () => {
  test("returns host, owner and name, dropping the .git suffix and extra path segments", () => {
    expect(parseRepoRef("https://github.com/barnuri/orch-skill.git/")).toEqual({ host: "github.com", owner: "barnuri", name: "orch-skill" });
  });

  test("returns null without an owner and a name", () => {
    expect(parseRepoRef("https://github.com/barnuri")).toBeNull();
  });
});

describe("RepoLink", () => {
  test("renders a new-tab anchor to the GitHub repo", () => {
    const html = renderToStaticMarkup(<RepoLink />);
    expect(html).toContain('href="https://github.com/barnuri/orch-skill"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('aria-label="Open the GitHub repo in a new tab"');
    expect(repoUrl(repoPackage)).toBe("https://github.com/barnuri/orch-skill");
  });

  test("renders nothing when no URL resolves", () => {
    expect(renderToStaticMarkup(<RepoLink meta={{}} />)).toBe("");
  });
});

describe("BugReportLink", () => {
  test("renders a new-tab anchor with rel, aria-label and title for this repo", () => {
    const html = renderToStaticMarkup(<BugReportLink />);
    expect(html).toContain(`href="${ISSUES}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('aria-label="Open the issues in a new tab"');
    expect(html).toContain('title="Issues"');
    expect(html).toContain("bug-report");
  });

  test("renders nothing when no URL resolves", () => {
    expect(renderToStaticMarkup(<BugReportLink meta={{}} />)).toBe("");
  });

  test("the package metadata resolves to the GitHub issues URL", () => {
    expect(bugReportUrl(repoPackage)).toBe(ISSUES);
  });
});
