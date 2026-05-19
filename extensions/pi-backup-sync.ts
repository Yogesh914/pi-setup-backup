import { mkdir, readdir, rm, stat, copyFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const RESOURCE_DIRS = ["extensions", "skills", "prompts", "themes"] as const;

function expandPath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return resolve(input);
}

async function runGit(repo: string, args: string[]) {
  const { stdout, stderr } = await execFileAsync("git", args, { cwd: repo, maxBuffer: 1024 * 1024 * 10 });
  return `${stdout}${stderr}`.trim();
}

async function emptyDir(dir: string) {
  await mkdir(dir, { recursive: true });
  for (const entry of await readdir(dir)) {
    await rm(join(dir, entry), { recursive: true, force: true });
  }
}

async function copyDirContents(source: string, target: string) {
  await mkdir(target, { recursive: true });
  if (!existsSync(source)) return;

  for (const entry of await readdir(source)) {
    const sourcePath = join(source, entry);
    const targetPath = join(target, entry);
    const info = await stat(sourcePath);

    if (info.isDirectory()) {
      await copyDirContents(sourcePath, targetPath);
    } else if (info.isFile()) {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    }
  }
}

async function ensureGitkeepIfEmpty(dir: string) {
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir);
  if (entries.length === 0) await writeFile(join(dir, ".gitkeep"), "", "utf8");
}

async function ensurePackageJson(repo: string) {
  const pkgPath = join(repo, "package.json");
  if (existsSync(pkgPath)) return;

  const name = basename(repo).replace(/[^a-zA-Z0-9._-]/g, "-").toLowerCase() || "pi-setup-backup";
  await writeFile(pkgPath, `${JSON.stringify({
    name,
    version: "1.0.0",
    private: true,
    keywords: ["pi-package"],
    description: "Backup package for my Pi extensions, skills, prompts, and themes.",
    pi: {
      extensions: ["./extensions"],
      skills: ["./skills"],
      prompts: ["./prompts"],
      themes: ["./themes"],
    },
    peerDependencies: {
      "@earendil-works/pi-coding-agent": "*",
      typebox: "*",
    },
  }, null, 2)}\n`, "utf8");
}

async function syncCurrentSetupToRepo(repo: string) {
  const agentDir = getAgentDir();

  for (const dirName of RESOURCE_DIRS) {
    const target = join(repo, dirName);
    await emptyDir(target);
    await copyDirContents(join(agentDir, dirName), target);
    await ensureGitkeepIfEmpty(target);
  }

  await ensurePackageJson(repo);
}

async function getPorcelain(repo: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: repo, maxBuffer: 1024 * 1024 * 10 });
  return stdout.trim();
}

async function runBackup(repoArg: string, ctx: ExtensionCommandContext) {
  const repo = expandPath(repoArg || process.env.PI_BACKUP_REPO || "~/pi-setup-backup");

  if (!existsSync(join(repo, ".git"))) {
    throw new Error(`Not a git repository: ${repo}`);
  }

  ctx.ui.notify(`Pi backup: pulling ${repo}`, "info");
  await runGit(repo, ["pull", "--rebase"]);

  ctx.ui.notify("Pi backup: syncing current extensions/skills/prompts/themes", "info");
  await syncCurrentSetupToRepo(repo);

  await runGit(repo, ["add", "extensions", "skills", "prompts", "themes", "package.json", "README.md"]);

  const changes = await getPorcelain(repo);
  if (!changes) {
    ctx.ui.notify("Pi backup: no changes to commit", "info");
    return `No changes. Repo already up to date: ${repo}`;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await runGit(repo, ["commit", "-m", `Backup Pi setup ${timestamp}`]);

  ctx.ui.notify("Pi backup: pushing", "info");
  await runGit(repo, ["push"]);

  return `Backed up Pi setup to ${repo}`;
}

export default function piBackupSync(pi: ExtensionAPI) {
  pi.registerCommand("pi-backup", {
    description: "Pull a Pi backup repo, sync current extensions/skills/prompts/themes, commit, and push. Usage: /pi-backup [repo-path]",
    handler: async (args, ctx) => {
      try {
        const result = await runBackup(args.trim(), ctx);
        ctx.ui.notify(result, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Pi backup failed: ${message}`, "error");
        throw error;
      }
    },
  });
}
