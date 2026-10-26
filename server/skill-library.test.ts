import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBundledSkills, loadUserSkills, mergeSkills, parseSkillManifest, selectBundledSkills, skillInstructionsFor, type BundledSkill } from "./skill-library.ts";

const phone: BundledSkill = {
  directory: "/skills/phone-harness",
  instructions: "---\nname: phone-harness\ndescription: test\n---\nUse phone tools.",
  manifest: {
    id: "phone-harness",
    name: "Phone Harness",
    version: "0.1.0",
    description: "Control a phone",
    defaultEnabled: true,
    triggerTerms: ["android", "phone"],
    requiredCapabilities: ["phoneMcp"],
  },
};

describe("bundled skill library", () => {
  it("selects a skill only when both its trigger and capability are present", () => {
    const rendered = skillInstructionsFor("Open Uber on my Android", ["phoneMcp"], [phone]);
    expect(rendered).toContain("Use phone tools");
    expect(rendered).not.toContain('root="/skills/phone-harness"');
    expect(skillInstructionsFor("Open Uber on my Android", ["phoneMcp"], [phone], { includeRoot: true }))
      .toContain('root="/skills/phone-harness"');
    expect(skillInstructionsFor("Open Uber on my Android", [], [phone])).toBe("");
    expect(skillInstructionsFor("Write a poem", ["phoneMcp"], [phone])).toBe("");
  });

  it("requires the manifest id to match its isolated folder", () => {
    expect(() => parseSkillManifest({
      ...phone.manifest,
      id: "other-skill",
    }, "/skills/phone-harness")).toThrow(/invalid id/);
  });

  it("loads a user skill without letting a broken sibling disable it", () => {
    const root = mkdtempSync(join(tmpdir(), "relay-skills-"));
    const valid = join(root, "file-expense");
    mkdirSync(valid);
    writeFileSync(join(valid, "manifest.json"), JSON.stringify({
      id: "file-expense", name: "File expense", version: "1.0.0", description: "File expenses",
      defaultEnabled: true, triggerTerms: ["expense"], requiredCapabilities: [],
    }));
    writeFileSync(join(valid, "SKILL.md"), "---\nname: file-expense\ndescription: File expenses\n---\nDo it safely.\n");
    const broken = join(root, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, "manifest.json"), "not json");
    writeFileSync(join(broken, "SKILL.md"), "broken");

    expect(loadUserSkills(root).map((skill) => skill.manifest.id)).toEqual(["file-expense"]);
  });

  it("does not let a user skill shadow a bundled skill id", () => {
    expect(mergeSkills([phone], [{ ...phone, instructions: "user replacement" }])).toEqual([phone]);
  });

  it("treats a non-directory user skill root as empty", () => {
    const root = mkdtempSync(join(tmpdir(), "relay-skills-root-"));
    const file = join(root, "not-a-directory");
    writeFileSync(file, "nope");
    expect(loadUserSkills(file)).toEqual([]);
  });
});

describe("bundled verification skill", () => {
  // Build the reviewed authoring adapter inline in a tmp dir.
  const bundledRoot = mkdtempSync(join(tmpdir(), "relay-bundled-skills-"));
  const adapterDir = join(bundledRoot, "create-verification-skill");
  mkdirSync(adapterDir);
  writeFileSync(join(adapterDir, "manifest.json"), JSON.stringify({
    id: "create-verification-skill", name: "Create verification skill", version: "1.0.0",
    description: "Authors a verification skill on explicit request",
    defaultEnabled: true,
    triggerTerms: ["create-verification-skill", "make a verification skill"],
    requiredCapabilities: ["skillAuthoring"],
  }));
  writeFileSync(join(adapterDir, "SKILL.md"), [
    "---",
    "name: create-verification-skill",
    "description: Authors a verification skill on explicit request",
    "---",
    "When the person explicitly asks to create a verification skill,",
    "use the skill_manage tool to scaffold it. Never claim a skill exists",
    "until its files are written and its checks pass.",
    "",
  ].join("\n"));
  const skills = loadBundledSkills(bundledRoot);
  const instructions = skills.find((skill) => skill.manifest.id === "create-verification-skill")?.instructions ?? "";

  it("ships one reviewed authoring adapter", () => {
    const ids = skills.map((skill) => skill.manifest.id);
    expect(ids).toContain("create-verification-skill");
    expect(ids).not.toContain("maintain-verification-skill");
    expect(instructions).toContain("skill_manage");
    expect(instructions).not.toContain("~/.relay");
    expect(instructions).not.toContain("propose_routine");
  });

  it("requires skill authoring and an explicit creation request", () => {
    for (const text of [
      "/create-verification-skill for my notes app",
      "can you make a verification skill so you can prove changes work",
    ]) {
      expect(selectBundledSkills(text, [], skills)).toEqual([]);
      expect(selectBundledSkills(text, ["skillAuthoring"], skills).map((skill) => skill.manifest.id))
        .toEqual(["create-verification-skill"]);
    }
  });

  it("does not mount for generic verification or maintenance phrasing", () => {
    for (const text of [
      "please verify the numbers in this invoice",
      "maintain the verification skill for atlas",
      "the verification skill is stale",
      "make a control cli",
      "create a feature map for my app",
    ]) {
      expect(selectBundledSkills(text, ["skillAuthoring"], skills)).toEqual([]);
    }
  });
});

describe("repo changes skill", () => {
  const skills = loadBundledSkills(join(dirname(fileURLToPath(import.meta.url)), "..", "skills"));
  const skill = skills.find((candidate) => candidate.manifest.id === "repo-changes");
  if (!skill) throw new Error("repo-changes skill missing");

  it("loads the tracked skill with a valid manifest and frontmatter", () => {
    expect(skill.manifest.version).toBe("1.0.0");
    expect(skill.manifest.defaultEnabled).toBe(true);
    expect(skill.instructions).toMatch(/^---\nname: repo-changes\n/);
    expect(skill.instructions).toContain("relay-git checkout relay/");
    expect(skill.instructions).toContain("relay-git push relay/");
  });

  it("selects repository work and ignores nearby false positives", () => {
    for (const text of [
      "Please update the website events page from this Luma link",
      "Open a pull request for the git repo",
    ]) {
      expect(selectBundledSkills(text, [], skills).map((candidate) => candidate.manifest.id)).toContain("repo-changes");
    }
    for (const text of [
      "Write a poem",
      "Please send the quarterly report",
    ]) {
      expect(selectBundledSkills(text, [], skills).map((candidate) => candidate.manifest.id)).not.toContain("repo-changes");
    }
  });
});
