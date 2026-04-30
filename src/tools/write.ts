import * as fs from "fs";
import * as path from "path";
import { Tool } from "./types";

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Write content to a file. Creates parent directories if needed.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute or relative path to the file",
      },
      content: {
        type: "string",
        description: "Content to write to the file",
      },
    },
    required: ["file_path", "content"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = String(args.file_path);
    const content = String(args.content);
    const resolved = path.resolve(filePath);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolved, content, "utf-8");
    return `Successfully wrote to ${resolved}`;
  },
};
