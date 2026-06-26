// Verifies the skills catalog: SKILL.md frontmatter parsing, the compact prompt block,
// and graceful degradation to empty when the skills dir is missing. Pure/local.
// Run: npx tsx test/skills-catalog-test.ts
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

const TMP = "/tmp/jarvis-skills-test";
process.env.JARVIS_SKILLS_DIR = TMP;

// Build a tiny fake skills tree before importing the module (it reads the env at import).
await rm(TMP, { recursive: true, force: true });
await mkdir(join(TMP, "alpha"), { recursive: true });
await mkdir(join(TMP, "beta"), { recursive: true });
await mkdir(join(TMP, "nofrontmatter"), { recursive: true });
// A persona skill (the convention is a "/trigger" in the description) — must be excluded.
await mkdir(join(TMP, "caveman"), { recursive: true });
// A meta skill excluded by name.
await mkdir(join(TMP, "find-skills"), { recursive: true });
await writeFile(join(TMP, "alpha", "SKILL.md"), `---\nname: alpha\ndescription: "Use when you need alpha things"\n---\n# body`);
await writeFile(join(TMP, "beta", "SKILL.md"), `---\nname: beta\ndescription: Use when beta is relevant\n---\n# body`);
await writeFile(join(TMP, "nofrontmatter", "SKILL.md"), `# just a heading, no frontmatter`);
await writeFile(join(TMP, "caveman", "SKILL.md"), `---\nname: caveman\ndescription: Compress all output. Drop articles and filler. Use when user types /caveman, says "caveman mode", or asks to be brief.\n---\n# body`);
await writeFile(join(TMP, "find-skills", "SKILL.md"), `---\nname: find-skills\ndescription: Helps users discover and install agent skills when they ask how to do X.\n---\n# body`);

const cat = await import("../src/skills-catalog.js");

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}  ${detail}`);
  if (!cond) failures++;
}

const skills = await cat.loadSkills();
check("parses only task skills (alpha, beta)", skills.length === 2, `count:${skills.length} names:${skills.map((s) => s.name).join(",")}`);
check("skips dirs without frontmatter", !skills.some((s) => s.name === "nofrontmatter"));
check("excludes persona skill (caveman, '/trigger')", !skills.some((s) => s.name === "caveman"));
check("excludes meta skill by name (find-skills)", !skills.some((s) => s.name === "find-skills"));
check("strips quotes from description", skills.find((s) => s.name === "alpha")?.useWhen === "Use when you need alpha things");
check("sorted by name", skills[0]?.name === "alpha" && skills[1]?.name === "beta");

const text = cat.catalogText(skills);
check("catalog text lists skills", text.includes("- alpha:") && text.includes("- beta:"));
check("catalog has a header", text.includes("## Skills you can use"));
check("empty skills → empty catalog", cat.catalogText([]) === "");

const names = await cat.getSkillNames();
check("getSkillNames returns curated names", names.join(",") === "alpha,beta", names.join(","));
check("loadSkills returns an array", Array.isArray(skills));

await rm(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
