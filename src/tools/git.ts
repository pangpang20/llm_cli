import { exec } from "child_process";
import { Tool } from "./types";

function runGit(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 30000, maxBuffer: 1024 * 1024 * 2 }, (error, stdout, stderr) => {
      const parts: string[] = [];
      if (stdout) parts.push(stdout.trim());
      if (stderr) parts.push(stderr.trim());
      if (error) parts.push(`error: ${error.message}`);
      resolve(parts.join("\n") || "(no output)");
    });
  });
}

export const gitStatusTool: Tool = {
  name: "git_status",
  description: "Show the current git status (modified, staged, untracked files).",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute(): Promise<string> {
    return runGit("git status");
  },
};

export const gitDiffTool: Tool = {
  name: "git_diff",
  description: "Show file changes (diff).",
  parameters: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description: "Specific file to diff (optional, shows all changes if omitted)",
      },
      staged: {
        type: "boolean",
        description: "Show staged changes instead of unstaged (default: false)",
      },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const staged = args.staged === true;
    const file = args.file ? String(args.file) : "";
    const cmd = `git diff${staged ? " --staged" : ""}${file ? ` ${file}` : ""}`;
    const result = await runGit(cmd);
    return result || "(no changes)";
  },
};

export const gitCommitTool: Tool = {
  name: "git_commit",
  description: "Stage files and create a commit.",
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "Commit message",
      },
      files: {
        type: "string",
        description: "Space-separated file paths to stage (optional, stages all changes if omitted)",
      },
    },
    required: ["message"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const message = String(args.message).replace(/"/g, '\\"');
    const files = args.files ? String(args.files) : "";

    const stageCmd = files ? `git add ${files}` : "git add -A";
    const stageResult = await runGit(stageCmd);
    if (stageResult.includes("error:")) return `Stage failed: ${stageResult}`;

    return runGit(`git commit -m "${message}"`);
  },
};

export const gitPushTool: Tool = {
  name: "git_push",
  description: "Push commits to remote repository (GitHub/GitLab).",
  parameters: {
    type: "object",
    properties: {
      remote: {
        type: "string",
        description: "Remote name (default: origin)",
      },
      branch: {
        type: "string",
        description: "Branch name (default: current branch)",
      },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const remote = args.remote ? String(args.remote) : "origin";
    const branch = args.branch ? String(args.branch) : "";
    const cmd = branch ? `git push ${remote} ${branch}` : `git push ${remote}`;
    return runGit(cmd);
  },
};
