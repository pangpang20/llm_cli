import * as fs from "fs";
import * as path from "path";
import { Tool } from "./types";

const SYSTEM_PATHS = ["/etc", "/usr", "/bin", "/sbin", "/var", "/root", "/boot", "/sys", "/proc"];
const BLOCKED_PATTERNS = [".env", ".key", ".pem", ".secret", "credentials", "id_rsa", "shadow", "passwd"];

function validatePath(resolved: string): string | null {
  for (const sysPath of SYSTEM_PATHS) {
    if (resolved.startsWith(sysPath + "/") || resolved === sysPath) {
      return `Error: Cannot modify system path: ${resolved}`;
    }
  }
  const base = path.basename(resolved).toLowerCase();
  for (const pattern of BLOCKED_PATTERNS) {
    if (base.includes(pattern)) {
      return `Error: Cannot modify restricted file: ${base}`;
    }
  }
  return null;
}

export const editFileTool: Tool = {
  name: "edit_file",
  description: "Edit a file by replacing exact text. The old_string must match exactly.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the file",
      },
      old_string: {
        type: "string",
        description: "Exact text to find and replace",
      },
      new_string: {
        type: "string",
        description: "New text to replace with",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = String(args.file_path);
    const oldStr = String(args.old_string);
    const newStr = String(args.new_string);
    const resolved = path.resolve(filePath);

    const validationError = validatePath(resolved);
    if (validationError) return validationError;

    if (!fs.existsSync(resolved)) {
      return `Error: File not found: ${resolved}`;
    }
    const content = fs.readFileSync(resolved, "utf-8");
    if (!content.includes(oldStr)) {
      return `Error: Text not found in file. Make sure old_string matches exactly.`;
    }
    const updated = content.replace(oldStr, newStr);
    fs.writeFileSync(resolved, updated, "utf-8");
    return `Successfully edited ${resolved}`;
  },
};
