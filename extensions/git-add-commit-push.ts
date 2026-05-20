import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 1024 * 1024 * 10,
  });
  return `${stdout}${stderr}`.trim();
}

async function hasChanges(cwd: string): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd,
    maxBuffer: 1024 * 1024 * 10,
  });
  return stdout.trim().length > 0;
}

async function ensureGitRepo(cwd: string) {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new Error(`Not inside a git repository: ${cwd}`);
  }
}

async function addCommitPush(cwd: string, message?: string) {
  await ensureGitRepo(cwd);

  await git(cwd, ["add", "."]);

  if (!(await hasChanges(cwd))) {
    return `No changes to commit in ${cwd}`;
  }

  const commitMessage = message?.trim() || `Update ${new Date().toISOString()}`;
  await git(cwd, ["commit", "-m", commitMessage]);
  const pushOutput = await git(cwd, ["push"]);

  return `Committed and pushed from ${cwd}\n\nCommit message: ${commitMessage}${pushOutput ? `\n\n${pushOutput}` : ""}`;
}

async function runFromContext(ctx: ExtensionCommandContext | ExtensionContext, message?: string) {
  const result = await addCommitPush(ctx.cwd, message);
  ctx.ui.notify(result.split("\n")[0], "info");
  return result;
}

export default function gitAddCommitPush(pi: ExtensionAPI) {
  pi.registerCommand("gpush", {
    description: "Run git add ., git commit, and git push from the current working directory. Usage: /gpush [commit message]",
    handler: async (args, ctx) => {
      try {
        await runFromContext(ctx, args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Git push failed: ${message}`, "error");
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "gpush",
    label: "Git Push",
    description: "Run git add ., git commit, and git push from Pi's current working directory.",
    promptSnippet: "Commit and push all current git repository changes from the working directory",
    promptGuidelines: [
      "Use gpush only when the user explicitly asks to commit and push current repository changes.",
    ],
    parameters: Type.Object({
      message: Type.Optional(Type.String({ description: "Commit message. If omitted, a timestamped default is used." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const text = await runFromContext(ctx, params.message);
        return {
          content: [{ type: "text", text }],
          details: { cwd: ctx.cwd, message: params.message },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Git push failed: ${message}` }],
          details: { cwd: ctx.cwd, error: message },
          isError: true,
        };
      }
    },
  });
}
