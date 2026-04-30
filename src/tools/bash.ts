import { execFile } from "child_process";
import { Tool } from "./types";

// Block patterns for destructive commands
// These catch common destructive patterns but cannot prevent all shell injection.
// The tool runs in the user's trusted environment; the LLM acts on their behalf.
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)*(\/|\/\*|\.\.?\/)/,  // rm -rf /, rm -rf /*, rm -rf ./
  /\bmkfs\b/,                                                     // format filesystem
  /\bdd\s+(if=|of=)/,                                            // dd read/write
  /:\s*\{\s*:\s*\|/,                                             // fork bomb
  /\bchmod\s+[0-7]*777\s/,                                      // chmod 777
  /\bchattr\s+(-|\+)i\b/,                                       // immutable attribute
];

function isDestructive(cmd: string): string | null {
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(cmd)) {
      return `Command blocked: matches destructive pattern`;
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

    return new Promise((resolve, reject) => {
      execFile("/bin/sh", ["-c", command], { timeout }, (error, stdout, stderr) => {
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
