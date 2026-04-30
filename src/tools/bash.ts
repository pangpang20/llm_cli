import { exec } from "child_process";
import { Tool } from "./types";

// Minimal safety filter for destructive commands
// This is a defense-in-depth measure, not a security boundary.
// The tool runs in the user's trusted environment; the LLM acts on their behalf.
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-[rfRvf]+\s+)*\/\s*$/,        // rm -rf /
  /\bmkfs\b/,                              // format filesystem
  /\bdd\s+if=\//,                          // dd from device
  /:\s*\{\s*:\s*\|/,                       // fork bomb
];

function isDestructive(cmd: string): string | null {
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(cmd)) {
      return `Command blocked: matches destructive pattern "${pattern.source}"`;
    }
  }
  return null;
}

export const bashTool: Tool = {
  name: "bash",
  description: "Execute a shell command and return its output.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default: 30000)",
      },
    },
    required: ["command"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command);
    const timeout = Number(args.timeout) || 30000;

    const blocked = isDestructive(command);
    if (blocked) return `Error: ${blocked}`;

    return new Promise((resolve) => {
      exec(command, { timeout }, (error, stdout, stderr) => {
        const parts: string[] = [];
        if (stdout) parts.push(`stdout:\n${stdout}`);
        if (stderr) parts.push(`stderr:\n${stderr}`);
        if (error) {
          const code = error.code ?? "unknown";
          parts.push(`error: ${error.message} (exit code: ${code})`);
        }
        if (parts.length === 0) {
          resolve("(command succeeded with no output)");
        } else {
          resolve(parts.join("\n"));
        }
      });
    });
  },
};
