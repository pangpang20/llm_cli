import { execFile } from "child_process";
import { Tool } from "./types";

const DANGEROUS_COMMANDS = ["rm -rf /", "mkfs", "dd if=", ":(){:|:&};:", "curl ", "wget ", "nc ", "ncat "];

function isDangerous(cmd: string): string | null {
  const lower = cmd.toLowerCase().trim();
  for (const dangerous of DANGEROUS_COMMANDS) {
    if (lower.startsWith(dangerous)) {
      return `Command blocked by safety filter: "${dangerous}"`;
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

    const blocked = isDangerous(command);
    if (blocked) return `Error: ${blocked}`;

    return new Promise((resolve) => {
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
