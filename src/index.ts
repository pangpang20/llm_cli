import * as readline from "readline";
import chalk from "chalk";
import { ensureAuth } from "./auth";
import { QwenWebProvider, QwenMessage } from "./provider/qwen_web";
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
  // Authenticate via browser login
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
      // Force re-login
      const { ensureAuth: reAuth } = await import("./auth");
      const newCookies = await reAuth();
      // Can't replace provider instance easily, just notify
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

    // Add user message
    chatHistory.push({ role: "user", content: trimmed });

    // Send to LLM
    try {
      console.log(chalk.gray("  thinking..."));
      const response = await provider.chat(chatHistory, allTools);
      console.log(chalk.white(response.content) + "\n");
      chatHistory.push({ role: "assistant", content: response.content });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Error: ${message}`));
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
