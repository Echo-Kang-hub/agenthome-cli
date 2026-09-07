import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function makeCatalogFixture(root: string): Promise<void> {
  await mkdir(path.join(root, "packs"), { recursive: true });
  await mkdir(path.join(root, "skills", "demo", "alpha"), { recursive: true });
  await mkdir(path.join(root, "skills", "demo", "beta"), { recursive: true });
  await writeFile(path.join(root, "skills", "demo", "alpha", "SKILL.md"), "---\nname: alpha\n---\n");
  await writeFile(path.join(root, "skills", "demo", "beta", "SKILL.md"), "---\nname: beta\n---\n");
  await writeFile(path.join(root, "packs", "common.json"), `${JSON.stringify({ schemaVersion: 1, id: "common", name: "Common", sources: [{ source: "demo", skills: ["alpha"] }] }, null, 2)}\n`);
  await writeFile(path.join(root, "sources.lock.json"), `${JSON.stringify({ schemaVersion: 1, sources: [{ id: "demo", name: "Demo", repository: "https://github.com/example/demo.git", skillRoot: "skills", revision: "a".repeat(40) }] }, null, 2)}\n`);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "one"], { cwd: root });
}
