import * as fs from "fs";
import * as path from "path";
import { Tool } from "./types";

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
