import * as readline from "readline";
import chalk from "chalk";
import { DashScopeProvider } from "./provider/dashscope";
import { ChatManager } from "./chat";
import { allTools, cleanupBrowser } from "./tools";
import { Tool } from "./tools/types";

const SYSTEM_PROMPT = `You are a helpful AI assistant running in a terminal. You can help users with coding tasks, file operations, shell commands, and browsing the web.

You have access to the following tools:

1. read_file: Read the contents of a file
   - file_path (string): Path to the file

2. write_file: Write content to a file (creates parent directories if needed)
   - file_path (string): Path to the file
   - content (string): Content to write

3. edit_file: Edit a file by replacing exact text
   - file_path (string): Path to the file
   - old_string (string): Exact text to find and replace
   - new_string (string): New text to replace with

4. bash: Execute a shell command
   - command (string): The shell command to execute
   - timeout (number, optional): Timeout in ms (default: 30000)

5. browser_navigate: Navigate to a URL in headless browser
   - url (string): URL to navigate to

6. browser_screenshot: Take a screenshot
   - path (string, optional): File path to save screenshot (default: screenshot.png)
   - selector (string, optional): CSS selector of element to screenshot

7. browser_text: Extract text from the current page
   - selector (string, optional): CSS selector to extract text from

8. browser_click: Click an element
   - selector (string): CSS selector of element to click

9. browser_type: Type text into an input field
   - selector (string): CSS selector of the input element
   - text (string): Text to type

Guidelines:
- Always use tools to accomplish tasks. Don't just describe what to do — actually do it.
- When reading files, use read_file. When creating/modifying files, use write_file or edit_file.
- For shell operations, use bash. For web browsing, use browser_* tools.
- Use tools one at a time. Wait for the result before using the next tool.
- Be concise in your responses. Show diffs or results clearly.`;

function createUI() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    prompt: (query: string = "> "): Promise<string> =>
      new Promise((resolve) => rl.question(query, resolve)),
    close: () => rl.close(),
  };
}

function printToolCall(name: string, args: Record<string, unknown>) {
  const cmd = args.command ? String(args.command).slice(0, 100) : "";
  const label = name === "bash" ? chalk.yellow(`  bash: ${cmd}`) : chalk.blue(`  ${name}`);
  console.log(label);
}

function printToolResult(result: string) {
  const preview = result.slice(0, 300);
  console.log(chalk.green(`  -> ${preview}${result.length > 300 ? "..." : ""}`));
  console.log();
}

function getToolByName(name: string): Tool | undefined {
  return allTools.find((t) => t.name === name);
}

async function main() {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    console.error(chalk.red("Error: DASHSCOPE_API_KEY environment variable not set."));
    console.error("Please set it with: export DASHSCOPE_API_KEY=your-api-key");
    process.exit(1);
  }

  const provider = new DashScopeProvider({
    apiKey,
    model: process.env.LLM_MODEL || "qwen-plus",
    baseURL: process.env.LLM_BASE_URL || undefined,
  });

  const chat = new ChatManager(SYSTEM_PROMPT);
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
      chat.reset();
      console.log(chalk.gray("Conversation cleared.\n"));
      continue;
    }
    if (trimmed === "/help") {
      console.log(chalk.cyan("Commands:"));
      console.log("  /clear   - Clear conversation history");
      console.log("  /quit    - Exit");
      console.log("  /help    - Show this help");
      console.log("\nJust type your message to start chatting.\n");
      continue;
    }

    // Add user message
    chat.addUserMessage(trimmed);

    // Loop for tool calls
    let hasToolCall = true;
    while (hasToolCall) {
      try {
        const response = await provider.chat(chat.getHistory(), allTools);
        const choice = response.choices[0];
        const message = choice.message;

        if (message?.tool_calls && message.tool_calls.length > 0) {
          // Show thinking indicator
          console.log(chalk.gray("  thinking..."));

          // Add assistant message with tool calls
          chat.addAssistantMessage(message.content || "", message.tool_calls as any);

          // Execute each tool call
          for (const tc of message.tool_calls) {
            const tcFn = tc.type === "function" ? tc.function : (tc as any).function;
            const toolName = tcFn.name;
            let toolArgs: Record<string, unknown>;
            try {
              toolArgs = JSON.parse(tcFn.arguments);
            } catch {
              toolArgs = {};
            }

            printToolCall(toolName, toolArgs);

            const tool = getToolByName(toolName);
            if (!tool) {
              chat.addToolResult(tc.id, `Error: Unknown tool "${toolName}"`, toolName);
              continue;
            }

            try {
              const result = await tool.execute(toolArgs);
              chat.addToolResult(tc.id, result, toolName);
              printToolResult(result);
            } catch (err: any) {
              const errorResult = `Error: ${err.message}`;
              chat.addToolResult(tc.id, errorResult, toolName);
              printToolResult(errorResult);
            }
          }
          // Continue the loop - LLM will decide next action
          hasToolCall = true;
        } else {
          // No tool calls - just text response
          const content = message?.content || "(empty response)";
          console.log(chalk.white(content) + "\n");
          chat.addAssistantMessage(content);
          hasToolCall = false;
        }
      } catch (err: any) {
        console.error(chalk.red(`Error: ${err.message}`));
        hasToolCall = false;
      }
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
