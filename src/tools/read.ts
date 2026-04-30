import * as fs from "fs";
import * as path from "path";
import { Tool } from "./types";

const PROJECT_ROOT = process.cwd();

function validatePath(resolved: string): string | null {
  if (resolved !== PROJECT_ROOT && !resolved.startsWith(PROJECT_ROOT + path.sep)) {
    return `Error: Path traversal blocked: ${resolved} is outside the project directory`;
  }
  return null;
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
    const resolved = path.resolve(filePath);

    const pathError = validatePath(resolved);
    if (pathError) return pathError;

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
