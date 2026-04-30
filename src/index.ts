import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import chalk from "chalk";
import { getProvider, listProviders } from "./providers";
import { BaseProvider, ChatMessage } from "./providers/base";
import { cleanupBrowser } from "./tools";
import { Harness } from "./harness";
import { checkTrust, isTrusted } from "./harness/trust";
import { initLogger, info, error, debug, closeLogger } from "./utils/logger";
import {
  readFileTool, writeFileTool, editFileTool, bashTool,
  browserNavigateTool, browserScreenshotTool, browserTextTool,
  browserClickTool, browserTypeTool,
} from "./tools";

const BASE_SYSTEM_PROMPT = `You are a helpful AI assistant running in a terminal. You can help users with coding tasks, file operations, shell commands, and browsing the web.

CRITICAL: You have access to LOCAL TOOLS. You MUST use them for any file operations, shell commands, or browser actions. NEVER say you cannot access the local filesystem.

When you need to use a tool, respond with ONLY the tool call in this EXACT format (no other text):

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
- Be concise. Show results clearly.

IMPORTANT EXAMPLES:
- User asks to list files: [TOOL_CALL:bash(command="ls -la")]
- User asks to read a file: [TOOL_CALL:read_file(file_path="README.md")]
- User asks to run a command: [TOOL_CALL:bash(command="echo hello")]
- User asks to edit a file: [TOOL_CALL:edit_file(file_path="test.py", old_string="old", new_string="new")]

中文提示：当用户要求执行文件操作、命令行操作或浏览器操作时，你必须使用工具调用格式 [TOOL_CALL:...] 来响应。不要说"我无法访问你的系统"之类的话，你有工具可以使用。`;

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

/**
 * Recursively read all files in a directory, ignoring node_modules/.git/etc.
 */
function readDirectoryRecursive(dir: string, basePath = ""): { relativePath: string; content: string; langHint: string }[] {
  const files: { relativePath: string; content: string; langHint: string }[] = [];
  const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", "dist", "build", "__pycache__", ".DS_Store"]);

  let entries: string[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") || e.name === ".env")
      .map((e) => e.name);
  } catch {
    return [];
  }

  for (const entry of entries.sort()) {
    const fullPath = path.join(dir, entry);
    const relativePath = basePath ? `${basePath}/${entry}` : entry;

    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        files.push(...readDirectoryRecursive(fullPath, relativePath));
      } else if (stat.isFile()) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const ext = path.extname(entry).slice(1).toLowerCase();
          files.push({ relativePath, content, langHint: ext || "text" });
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // skip inaccessible entries
    }
  }
  return files;
}

/**
 * Parse @file references in user input and replace them with file content.
 * Supports: @path/to/file, @path/to/directory
 */
async function expandFileAttachments(input: string): Promise<string> {
  const fileRegex = /@(\S+)/g;
  const matches = [...input.matchAll(fileRegex)];
  if (matches.length === 0) return input;

  let result = input;
  const fileContents: string[] = [];

  for (const match of matches) {
    const filePath = match[1];
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);

    try {
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        // Directory: read all files recursively
        const dirFiles = readDirectoryRecursive(fullPath, filePath);
        if (dirFiles.length === 0) {
          fileContents.push(`--- Directory: ${filePath} (empty or no readable files) ---`);
        } else {
          for (const f of dirFiles) {
            fileContents.push(`--- File: ${f.relativePath} ---\n\`\`\`${f.langHint}\n${f.content}\n\`\`\`\n--- End of ${f.relativePath} ---`);
          }
        }
        result = result.replace(match[0], `[Directory: ${filePath} (${dirFiles.length} files)]`);
      } else {
        // Single file
        const content = fs.readFileSync(fullPath, "utf-8");
        const ext = path.extname(filePath).slice(1).toLowerCase();
        const langHint = ext || "text";
        fileContents.push(`--- File: ${filePath} ---\n\`\`\`${langHint}\n${content}\n\`\`\`\n--- End of ${filePath} ---`);
        result = result.replace(match[0], `[File: ${filePath}]`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      fileContents.push(`--- ${filePath} (ERROR: ${errMsg}) ---`);
      result = result.replace(match[0], `[${filePath} - NOT FOUND]`);
    }
  }

  if (fileContents.length > 0) {
    return `${result}\n\n--- Attached File Content ---\n${fileContents.join("\n")}\n--- End of Attachments ---`;
  }
  return result;
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

async function selectProvider(ui?: ReturnType<typeof createUI>): Promise<BaseProvider> {
  const providers = listProviders();
  info(`Available providers: ${providers.map(p => p.name).join(", ")}`);
  const envId = process.env.LLM_PROVIDER;

  if (envId) {
    try { return getProvider(envId); } catch {
      info(`Unknown provider "${envId}" from env, showing menu`);
      console.log(chalk.yellow(`Unknown provider "${envId}" from LLM_PROVIDER, showing menu.\n`));
    }
  }

  console.log(chalk.cyan("Select AI Provider:"));
  console.log(chalk.gray("─".repeat(40)));
  providers.forEach((p, i) => {
    const marker = i === 0 ? chalk.green(" (default)") : "";
    console.log(`  ${chalk.white(String(i + 1))}. ${p.name}${marker}`);
  });
  console.log(chalk.gray("─".repeat(40)));

  const answer = ui
    ? await ui.prompt(chalk.yellow("Provider (1-4) [1]: "))
    : await new Promise<string>((resolve, reject) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        let settled = false;
        rl.question(chalk.yellow("Provider (1-4) [1]: "), (a) => {
          if (!settled) { settled = true; rl.close(); resolve(a); }
        });
        rl.once("close", () => { if (!settled) reject(new Error("EOF")); });
      });

  const num = parseInt(answer.trim(), 10);
  if (isNaN(num) || num < 1 || num > providers.length) {
    info(`Invalid input "${answer}", using default: ${providers[0].name}`);
    console.log(chalk.gray(`Using default: ${providers[0].name}\n`));
    return getProvider(providers[0].id);
  }
  const selected = providers[num - 1];
  info(`User selected: ${selected.name} (${selected.id})`);
  console.log(chalk.gray(`Selected: ${selected.name}\n`));
  return getProvider(selected.id);
}

function formatSessionExpiry(provider: BaseProvider): string {
  const filePath = provider.getSessionFilePath();
  if (!fs.existsSync(filePath)) return "No session file";
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const savedAt = new Date(data.savedAt).getTime();
    const elapsed = Date.now() - savedAt;
    const maxAge = 12 * 60 * 60 * 1000;
    const remaining = maxAge - elapsed;
    if (remaining <= 0) return "Expired";
    const hours = Math.floor(remaining / (60 * 60 * 1000));
    const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
    return `Active (expires ${hours}h${minutes}m)`;
  } catch {
    return "Corrupted";
  }
}

async function main() {
  // Initialize logger
  initLogger();
  info("=== LLM CLI Started ===");

  // Trust check
  await checkTrust();
  info("Trust check passed");

  // Select provider
  info("Waiting for user to select provider...");
  let provider: BaseProvider = await selectProvider();
  info(`Provider selected: ${provider.info.name} (${provider.info.id})`);

  // Login with retry on failure
  while (true) {
    try {
      info(`[${provider.info.name}] Starting login...`);
      await provider.login();
      info(`[${provider.info.name}] Login successful`);
      break; // Login succeeded
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      error(`[${provider.info.name}] Login failed: ${message}`);
      console.error(chalk.red(`\nLogin failed: ${message}\n`));

      const ui = createUI();
      const choice = await ui.prompt(
        chalk.yellow("Choose an option: [1] Retry login, [2] Switch provider, [3] Exit [1/2/3]: ")
      ).then(c => c.trim());
      ui.close();
      info(`User chose option: ${choice}`);

      if (choice === "3") {
        info("User chose to exit after login failure");
        closeLogger();
        process.exit(1);
      } else if (choice === "2") {
        info("User chose to switch provider");
        provider = await selectProvider();
        info(`New provider selected: ${provider.info.name}`);
        // Fall through to retry with new provider
      }
      // choice === "1" or anything else: retry with current provider
    }
  }

  // Init harness
  const harness = new Harness();
  await harness.onStart();

  // Build system prompt with learned context
  const systemPrompt = harness.buildSystemPrompt(BASE_SYSTEM_PROMPT);

  const chatHistory: ChatMessage[] = [{ role: "system", content: systemPrompt }];
  const ui = createUI();

  console.log(chalk.cyan(`=== LLM CLI Agent (${provider.info.name}) ===`));
  console.log(chalk.gray("Author: chenyunliang <676814828@qq.com>"));
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
      console.log(chalk.gray("Switching provider...\n"));
      const newProvider = await selectProvider(ui);
      await newProvider.login();
      console.log(chalk.green(`Switched to ${newProvider.info.name}.\n`));
      console.log(chalk.gray("Note: Restart the session (/quit then llmcli) to use the new provider.\n"));
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
    if (trimmed === "/status") {
      const info = provider.info;
      const sessionStatus = formatSessionExpiry(provider);
      const dirTrusted = isTrusted(process.cwd());
      const counts = harness.memory.getCounts();
      const totalRules = harness.selfImprove.getConfig().rules.length;
      const hooksConfig = harness.hooks.getConfig();
      const totalHooks = hooksConfig.on_start.length + hooksConfig.on_error.length + hooksConfig.on_exit.length;
      const totalMem = counts.success + counts.failure + counts.preference + counts.fact;

      console.log(chalk.cyan("=== System Status ==="));
      console.log(chalk.white(`Provider: ${chalk.bold(info.name)} (${info.id}) | ${info.loginUrl}`));
      console.log(
        sessionStatus.startsWith("Active")
          ? chalk.green(`Session: ${sessionStatus} | saved at ${info.sessionFile}`)
          : chalk.red(`Session: ${sessionStatus} | saved at ${info.sessionFile}`)
      );
      console.log(dirTrusted ? chalk.green("Directory: Trusted") : chalk.yellow("Directory: Not trusted"));
      console.log(chalk.white(`Memory: ${totalMem} entries (${counts.success} success, ${counts.failure} failure, ${counts.preference} preference, ${counts.fact} fact)`));
      console.log(chalk.white(`Rules: ${totalRules} learned`));
      console.log(chalk.white(`Hooks: ${totalHooks} configured`));
      console.log();
      continue;
    }
    if (trimmed === "/config") {
      while (true) {
        console.log(chalk.cyan("=== Configuration ==="));
        console.log(chalk.white("  1. View Hooks"));
        console.log(chalk.white("  2. View Rules"));
        console.log(chalk.white("  3. View Memory (recent)"));
        console.log(chalk.white("  4. Clear Memory"));
        console.log(chalk.white("  5. Clear Rules"));
        console.log(chalk.white("  6. Toggle Auto-Learn"));
        console.log(chalk.gray("  ─────────────────────"));
        console.log(chalk.white("  Q. Back\n"));

        const choice = (await ui.prompt("Choice: ")).trim().toLowerCase();

        if (choice === "q" || choice === "quit" || choice === "back") {
          console.log();
          break;
        }

        switch (choice) {
          case "1": {
            const hooks = harness.hooks.getConfig();
            console.log(chalk.cyan("Hooks:"));
            for (const event of (["on_start", "on_error", "on_exit"] as const)) {
              const items = hooks[event];
              if (items.length === 0) {
                console.log(chalk.gray(`  ${event}: (none)`));
              } else {
                console.log(chalk.yellow(`  ${event}:`));
                for (const h of items) {
                  console.log(`    ${chalk.white(h.name)}: ${chalk.gray(h.command)}`);
                }
              }
            }
            console.log();
            break;
          }
          case "2": {
            const rules = harness.selfImprove.getConfig().rules;
            if (rules.length === 0) {
              console.log(chalk.gray("No learned rules.\n"));
            } else {
              console.log(chalk.cyan(`Learned Rules (${rules.length}):`));
              for (const r of rules) {
                console.log(chalk.white(`  ${r.description}`) + chalk.gray(` [by: ${r.triggeredBy}, hits: ${r.hits}]`));
              }
              console.log();
            }
            break;
          }
          case "3": {
            const recent = harness.memory.getRecent("fact", 10);
            if (recent.length === 0) {
              console.log(chalk.gray("No recent memory entries.\n"));
            } else {
              console.log(chalk.cyan("Recent Entries:"));
              for (const e of recent) {
                const icon = e.type === "success" ? chalk.green("✓") : e.type === "failure" ? chalk.red("✗") : chalk.blue("•");
                console.log(`${icon} ${chalk.white(e.content.slice(0, 100))}`);
              }
              console.log();
            }
            break;
          }
          case "4": {
            const confirm = await ui.prompt(chalk.yellow("Clear all memory? (y/N) "));
            if (confirm.trim().toLowerCase() === "y") {
              harness.memory.clear();
              console.log(chalk.green("Memory cleared.\n"));
            } else {
              console.log(chalk.gray("Cancelled.\n"));
            }
            break;
          }
          case "5": {
            const confirm = await ui.prompt(chalk.yellow("Clear all rules? (y/N) "));
            if (confirm.trim().toLowerCase() === "y") {
              harness.selfImprove.clearRules();
              console.log(chalk.green("Rules cleared.\n"));
            } else {
              console.log(chalk.gray("Cancelled.\n"));
            }
            break;
          }
          case "6": {
            const config = harness.selfImprove.getConfig();
            config.autoLearn = !config.autoLearn;
            harness.selfImprove.save();
            console.log(chalk.green(`Auto-Learn ${config.autoLearn ? "enabled" : "disabled"}.\n`));
            break;
          }
          default:
            console.log(chalk.yellow("Invalid choice. Try again.\n"));
        }
      }
      continue;
    }
    if (trimmed === "/help") {
      console.log(chalk.cyan("Commands:"));
      console.log("  /clear      - Clear conversation history");
      console.log("  /config     - View and manage configuration");
      console.log("  /login      - Re-authenticate with browser");
      console.log("  /memory     - Show learned memories");
      console.log("  /provider   - Switch AI provider");
      console.log("  /status     - Show system status");
      console.log("  /quit       - Exit");
      console.log("  /help       - Show this help");
      console.log("\nJust type your message to start chatting.");
      console.log("Use @path/to/file to attach file content to your message.\n");
      continue;
    }

    // Expand @file references with actual file content
    const expandedInput = await expandFileAttachments(trimmed);
    chatHistory.push({ role: "user", content: expandedInput });

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
  info("=== LLM CLI Exited ===");
  closeLogger();
  console.log(chalk.gray("Goodbye!"));
}

main().catch((err) => {
  console.error(err);
  error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  closeLogger();
  process.exit(1);
});
