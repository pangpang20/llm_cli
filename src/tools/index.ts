import { Tool } from "./types";
import { readFileTool } from "./read";
import { writeFileTool } from "./write";
import { editFileTool } from "./edit";
import { bashTool } from "./bash";
import {
  browserNavigateTool,
  browserScreenshotTool,
  browserTextTool,
  browserClickTool,
  browserTypeTool,
} from "./browser";

export const allTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  bashTool,
  browserNavigateTool,
  browserScreenshotTool,
  browserTextTool,
  browserClickTool,
  browserTypeTool,
];

export { Tool, ToolCall } from "./types";
export { cleanupBrowser } from "./browser";
