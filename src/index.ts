import * as readline from "readline";
import chalk from "chalk";
import { getProvider, listProviders } from "./providers";
import { BaseProvider, ChatMessage } from "./providers/base";
import { cleanupBrowser } from "./tools";
import { Harness } from "./harness";
import {
  readFileTool, writeFileTool, editFileTool, bashTool,
  browserNavigateTool, browserScreenshotTool, browserTextTool,
  browserClickTool, browserTypeTool,
} from "./tools";

const BASE_SYSTEM_PROMPT = `You are a helpful AI assistant running in a terminal. You can help users with coding tasks, file operations, shell commands, and browsing the web.

When the user asks you to perform file operations, shell commands, or browser actions, respond with ONLY a tool call in this exact format:

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

const TOOL_REGISTRY: Record<string, { execute: (args: Record<string, unknown>) => Promise<string> }> = {
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

function parseToolCall(text: string): { name: string; args: Record<string, unknown> } | null {
  const match = text.match(/\[TOOL_CALL:([a-zA-Z_]\w*)\((.*)\)\]/s);
  if (!match) return null;
  const name = match[1];
  const argsStr = match[2];
  const args: Record<string, unknown> = {};
  if (argsStr.trim()) {
    // Parse key="value" pairs, handling escaped quotes
    for (const [, key, value] of argsStr.matchAll(/(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"/g)) {
      // Unescape the value
      args[key] = value.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
    }
  }
  return { name, args };
}

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = TOOL_REGISTRY[name];
  if (!tool) return `Error: Unknown tool "${name}"`;
  try {
    return await tool.execute(args);
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function createUI() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("error", (err) => { console.error(chalk.red(`Readline error: ${err.message}`)); rl.close(); });
  return {
    prompt: (query: string = "> "): Promise<string> =>
      new Promise((resolve, reject) => {
        rl.question(query, (answer) => resolve(answer));
        rl.once("close", () => reject(new Error("EOF")));
      }),
    close: () => rl.close(),
  };
}

async function main() {
  // Select provider
  const providerId = process.env.LLM_PROVIDER || "qwen";
  const provider: BaseProvider = getProvider(providerId);

  // Login
  await provider.login();

  // Init harness
  const harness = new Harness();
  await harness.onStart();

  // Build system prompt with learned context
  const systemPrompt = harness.buildSystemPrompt(BASE_SYSTEM_PROMPT);

  const chatHistory: ChatMessage[] = [{ role: "system", content: systemPrompt }];
  const ui = createUI();

  console.log(chalk.cyan(`=== LLM CLI Agent (${provider.info.name}) ===`));
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

    if (trimmed === "/quit" || trimmed === "/exit") break;
    if (trimmed === "/clear") {
      chatHistory.length = 0;
      chatHistory.push({ role: "system", content: systemPrompt });
      console.log(chalk.gray("Conversation cleared.\n"));
      continue;
    }
    if (trimmed === "/login") {
      await provider.login();
      console.log(chalk.green("Session refreshed.\n"));
      continue;
    }
    if (trimmed === "/provider") {
      const available = listProviders().map((p) => `  ${p.id}: ${p.name}`).join("\n");
      console.log(chalk.cyan(`Available providers:\n${available}\n`));
      console.log(chalk.gray(`Switch with: LLM_PROVIDER=<id> npm start\n`));
      continue;
    }
    if (trimmed === "/memory") {
      const topSuccess = harness.memory.getTopSuccesses(3);
      const topFail = harness.memory.getTopFailures(3);
      const prefs = harness.memory.getPreferences();
      if (topSuccess.length > 0) console.log(chalk.green("Top successes:"));
      topSuccess.forEach((e) => console.log(`  ✓ ${e.content} (x${e.count})`));
      if (topFail.length > 0) console.log(chalk.red("Top failures:"));
      topFail.forEach((e) => console.log(`  ✗ ${e.content} (x${e.count})`));
      if (prefs.length > 0) console.log(chalk.blue("Preferences:"));
      prefs.forEach((e) => console.log(`  • ${e.content}`));
      console.log();
      continue;
    }
    if (trimmed === "/help") {
      console.log(chalk.cyan("Commands:"));
      console.log("  /clear      - Clear conversation history");
      console.log("  /login      - Re-authenticate with browser");
      console.log("  /provider   - List available AI providers");
      console.log("  /memory     - Show learned memories");
      console.log("  /quit       - Exit");
      console.log("  /help       - Show this help");
      console.log("\nJust type your message to start chatting.\n");
      continue;
    }

    chatHistory.push({ role: "user", content: trimmed });

    let maxToolRounds = 10;
    while (maxToolRounds > 0) {
      try {
        console.log(chalk.gray("  thinking..."));
        const response = await provider.chat(chatHistory);
        const content = response.content.trim();

        const toolCall = parseToolCall(content);
        if (toolCall) {
          console.log(chalk.blue(`  [tool: ${toolCall.name}]`));
          const result = await executeTool(toolCall.name, toolCall.args);
          const preview = result.slice(0, 200);
          console.log(chalk.green(`  -> ${preview}${result.length > 200 ? "..." : ""}\n`));

          harness.selfImprove.recordToolResult(toolCall.name, toolCall.args, result, !result.startsWith("Error:"));

          chatHistory.push({ role: "assistant", content });
          chatHistory.push({ role: "user", content: `Tool result: ${result}\n\nContinue with the result.` });
          maxToolRounds--;
        } else {
          console.log(chalk.white(content) + "\n");
          chatHistory.push({ role: "assistant", content });
          break;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        await harness.onError(message);
        break;
      }
    }

    if (maxToolRounds === 0) {
      console.log(chalk.yellow("  Tool call limit reached. Stopping.\n"));
    }
  }

  await harness.onExit();
  ui.close();
  await cleanupBrowser();
  console.log(chalk.gray("Goodbye!"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
