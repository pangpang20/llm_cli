import * as fs from "fs";
import * as path from "path";
import { Tool } from "./types";

const SAFE_DIRS = ["/tmp", "/dev/null"];

function resolveAndValidate(filePath: string): string {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(process.cwd())) {
    const isSafeDir = SAFE_DIRS.some((d) => resolved.startsWith(d));
    if (!isSafeDir) {
      return `__ERROR__:Path traversal blocked: ${resolved} is outside the project directory`;
    }
  }
  return resolved;
}

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file. Supports text files and images.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute or relative path to the file",
      },
    },
    required: ["file_path"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = String(args.file_path);
    const resolved = resolveAndValidate(filePath);
    if (resolved.startsWith("__ERROR__:")) return resolved.replace("__ERROR__:", "Error: ");
    if (!fs.existsSync(resolved)) {
      return `Error: File not found: ${resolved}`;
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolved);
      return entries.join("\n");
    }
    const content = fs.readFileSync(resolved, "utf-8");
    return content;
  },
};
