import * as readline from "readline";
import chalk from "chalk";
import { ensureAuth } from "./auth";
import { QwenWebProvider, QwenMessage } from "./provider/qwen_web";
import { cleanupBrowser } from "./tools";

const SYSTEM_PROMPT = `You are a helpful AI assistant running in a terminal. You can help users with coding tasks, file operations, shell commands, and browsing the web.

When the user asks you to perform file operations, shell commands, or browser actions, use the following tool call format in your response:

[TOOL_CALL:tool_name(arg1="value1", arg2="value2")]

Available tools:
- read_file(file_path="path") — Read file contents
- write_file(file_path="path", content="content") — Create or overwrite a file
- edit_file(file_path="path", old_string="old", new_string="new") — Replace exact text in a file
- bash(command="cmd", timeout=30000) — Execute a shell command
- browser_navigate(url="url") — Open a URL in headless browser
- browser_screenshot(path="file.png") — Take a screenshot
- browser_text(selector="css") — Extract text from page
- browser_click(selector="css") — Click an element
- browser_type(selector="css", text="text") — Type into an input

Guidelines:
- When you need to use a tool, respond with ONLY the tool call first. The system will execute it and send back the result.
- After receiving a tool result, use it to continue helping the user.
- If multiple tools are needed, use them one at a time in sequence.
- Be concise. Show results clearly.`;

function createUI() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on("error", (err) => {
    console.error(chalk.red(`Readline error: ${err.message}`));
    rl.close();
  });

  return {
    prompt: (query: string = "> "): Promise<string> =>
      new Promise((resolve, reject) => {
        rl.question(query, (answer) => {
          resolve(answer);
        });
        rl.once("close", () => {
          reject(new Error("EOF"));
        });
      }),
    close: () => rl.close(),
  };
}

// Parse tool call from LLM response: [TOOL_CALL:name(arg="val")]
function parseToolCall(text: string): { name: string; args: Record<string, unknown> } | null {
  const match = text.match(/\[TOOL_CALL:(\w+)\(([^)]*)\)\]/);
  if (!match) return null;

  const name = match[1];
  const argsStr = match[2];
  const args: Record<string, unknown> = {};

  if (argsStr.trim()) {
    const pairs = argsStr.matchAll(/(\w+)="([^"]*)"/g);
    for (const [, key, value] of pairs) {
      args[key] = value;
    }
  }

  return { name, args };
}

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  console.log(chalk.blue(`  [tool: ${name}]`));

  const { readFileTool, writeFileTool, editFileTool, bashTool,
    browserNavigateTool, browserScreenshotTool, browserTextTool,
    browserClickTool, browserTypeTool
  } = await import("./tools");

  const tools: Record<string, { execute: (args: Record<string, unknown>) => Promise<string> }> = {
    read_file: readFileTool,
    write_file: writeFileTool,
    edit_file: editFileTool,
    bash: bashTool,
    browser_navigate: browserNavigateTool,
    browser_screenshot: browserScreenshotTool,
    browser_text: browserTextTool,
    browser_click: browserClickTool,
    browser_type: browserTypeTool,
  };

  const tool = tools[name];
  if (!tool) return `Error: Unknown tool "${name}"`;

  try {
    return await tool.execute(args);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }
}

async function main() {
  const cookies = await ensureAuth();
  const provider = new QwenWebProvider({ cookies });

  const chatHistory: QwenMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  const ui = createUI();

  console.log(chalk.cyan("=== LLM CLI Agent ==="));
  console.log(chalk.gray("Type /help for commands. Ctrl+C to exit.\n"));

  while (true) {
    let input: string;
    try {
      input = await ui.prompt(chalk.green("> "));
    } catch {
      break;
    }

    const trimmed = input.trim();
    if (!trimmed) continue;

    // Handle commands
    if (trimmed === "/quit" || trimmed === "/exit") break;
    if (trimmed === "/clear") {
      chatHistory.length = 0;
      chatHistory.push({ role: "system", content: SYSTEM_PROMPT });
      console.log(chalk.gray("Conversation cleared.\n"));
      continue;
    }
    if (trimmed === "/login") {
      await ensureAuth();
      console.log(chalk.green("Session refreshed. New authentication saved.\n"));
      continue;
    }
    if (trimmed === "/help") {
      console.log(chalk.cyan("Commands:"));
      console.log("  /clear   - Clear conversation history");
      console.log("  /login   - Re-authenticate with browser");
      console.log("  /quit    - Exit");
      console.log("  /help    - Show this help");
      console.log("\nJust type your message to start chatting.\n");
      continue;
    }

    chatHistory.push({ role: "user", content: trimmed });

    let maxToolRounds = 10; // Prevent infinite tool call loops
    while (maxToolRounds > 0) {
      try {
        console.log(chalk.gray("  thinking..."));
        const response = await provider.chat(chatHistory);
        const content = response.content.trim();

        // Check for tool call
        const toolCall = parseToolCall(content);
        if (toolCall) {
          console.log(chalk.blue(`  [tool: ${toolCall.name}]`));
          const result = await executeTool(toolCall.name, toolCall.args);
          console.log(chalk.green(`  -> ${result.slice(0, 200)}${result.length > 200 ? "..." : ""}\n`));

          chatHistory.push({ role: "assistant", content });
          chatHistory.push({ role: "user", content: `Tool result: ${result}\n\nContinue with the result.` });
          maxToolRounds--;
        } else {
          // Regular text response
          console.log(chalk.white(content) + "\n");
          chatHistory.push({ role: "assistant", content });
          break;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        break;
      }
    }

    if (maxToolRounds === 0) {
      console.log(chalk.yellow("  Tool call limit reached. Stopping.\n"));
    }
  }

  ui.close();
  await cleanupBrowser();
  console.log(chalk.gray("Goodbye!"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
