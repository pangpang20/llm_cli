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
  browserAssertTool,
  browserWaitTool,
  browserEvalTool,
  cleanupBrowser,
} from "./browser";
import {
  gitStatusTool,
  gitDiffTool,
  gitCommitTool,
  gitPushTool,
} from "./git";

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
  browserAssertTool,
  browserWaitTool,
  browserEvalTool,
  gitStatusTool,
  gitDiffTool,
  gitCommitTool,
  gitPushTool,
];

export {
  readFileTool,
  writeFileTool,
  editFileTool,
  bashTool,
  browserNavigateTool,
  browserScreenshotTool,
  browserTextTool,
  browserClickTool,
  browserTypeTool,
  browserAssertTool,
  browserWaitTool,
  browserEvalTool,
  gitStatusTool,
  gitDiffTool,
  gitCommitTool,
  gitPushTool,
  cleanupBrowser,
};

export type { Tool, ToolCall } from "./types";
