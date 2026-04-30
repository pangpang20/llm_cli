import * as https from "https";
import { Cookie } from "puppeteer";
import { BaseProvider, ChatMessage, ChatResponse, ProviderInfo } from "./base";
import * as crypto from "crypto";
import chalk from "chalk";
import { debug, info, error } from "../utils/logger";

const QWEN_API = "https://chat.qwen.ai/api/v2/chat/completions";
const QWEN_NEW_CHAT = "https://chat.qwen.ai/api/v2/chats/new";

const QWEN_TOOL_INSTRUCTION = `Environment: Linux x86_64. Use Linux paths starting with the project root.

You MUST use tools for file/shell/browser tasks. Call tools using [TOOL_CALL:<name>(params)].

Tools you MUST use:
  bash(command="...", timeout=30000) — Run shell commands
  read_file(file_path="path") — Read a file
  write_file(file_path="path", content="...") — Write file
  edit_file(file_path="path", old_string="...", new_string="...") — Replace text
  browser_navigate(url="https://...")
  browser_screenshot(path="file.png")
  browser_text(selector="css")
  browser_click(selector="css")
  browser_type(selector="css", text="...")

Examples of CORRECT tool calls:
[TOOL_CALL:bash(command="ls -la", timeout=30000)]
[TOOL_CALL:read_file(file_path="README.md")]

WRONG (do NOT do this):
[TOOL_CALL:toolname(command="...")]
[TOOL_CALL:TOOLNAME(command="...")]
[TOOL_CALL:your_tool(command="...")]

ALWAYS use one of: bash, read_file, write_file, edit_file, browser_navigate, browser_screenshot, browser_text, browser_click, browser_type.
When calling a tool, output ONLY the [TOOL_CALL:...] line.`;

class QwenProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: "qwen",
    name: "Qwen (通义千问)",
    loginUrl: "https://chat.qwen.ai/",
    sessionFile: ".qwen_session.json",
    apiUrl: QWEN_API,
  };

  private chatId: string = "";
  private lastMessageId: string | null = null;
  private lastResponseId: string | null = null;

  protected isLoginComplete(): string {
    return `() => {
      const url = window.location.href;
      if (url.includes("login") || url.includes("signin")) {
        return false;
      }
      const avatar = document.querySelector('[class*="avatar"], [class*="user"], [class*="profile"]');
      return !!avatar;
    }`;
  }

  protected extractAuthCookies(cookies: Cookie[]): Cookie[] {
    return cookies.filter(
      (c) => c.name === "token" ||
             c.name === "session_id" ||
             c.name === "sid" ||
             c.name.startsWith("auth_") ||
             c.name.startsWith("passport_") ||
             c.name === "refresh_token" ||
             c.name === "ctoken" ||
             c.name === "csrf" ||
             (c.domain.includes("aliyun") && (c.httpOnly || c.name.toLowerCase().includes("token")))
    );
  }

  override async login(): Promise<Cookie[]> {
    const existing = this.loadSession();
    if (existing && existing.length > 0) {
      info(`[Qwen] Using cached session, ${existing.length} cookies`);
      this.cookieString = existing.map((c) => `${c.name}=${c.value}`).join("; ");
      console.log(chalk.gray(`Using cached session for ${this.info.name}...`));
      return existing;
    }

    info(`[Qwen] No cached session, starting login flow`);
    console.log(chalk.cyan(`\n[${this.info.name}] Logging in...`));

    const hasDisplay = process.env.DISPLAY !== undefined;
    const isWindows = process.platform === "win32";
    info(`[Qwen] Platform: ${isWindows ? "Windows" : process.platform}, DISPLAY=${process.env.DISPLAY || "unset"}`);

    if (!hasDisplay || isWindows) {
      info(`[Qwen] Using visible browser login mode`);
      console.log(chalk.yellow(isWindows ? "Windows detected. Opening visible browser for login." : "No display detected. Opening visible browser for login."));
      const cookies = await this.loginWithBrowser();
      this.cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      return cookies;
    }

    info(`[Qwen] Using desktop mode with display`);
    console.log("Opening browser for login...");
    const cookies = await super.login();
    this.cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    return cookies;
  }

  async loginWithBrowser(): Promise<Cookie[]> {
    const puppeteer = await import("puppeteer");
    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs");
    const readline = await import("readline");

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-login-"));

    const browser = await puppeteer.launch({
      headless: false,
      userDataDir,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    try {
      const page = await browser.newPage();
      info("[Qwen] Browser launched, new page created");

      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        // @ts-ignore
        window.chrome = { runtime: {} };
        // @ts-ignore
        delete navigator.__proto__.webdriver;
      });

      info(`[Qwen] Navigating to ${this.info.loginUrl}`);
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(this.info.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      info("[Qwen] Page loaded, waiting for user login");
      console.log(chalk.green(`Opened ${this.info.loginUrl} in your browser.`));
      console.log(chalk.gray("Please complete login in the browser window.\n"));

      const authCookieNames = ["token", "session_id", "sid", "refresh_token", "ctoken", "csrf"];
      let done = false;

      const pollInterval = setInterval(async () => {
        if (done) return;

        const cookies = await page.cookies();
        const hasAuthCookies = cookies.some((c) => authCookieNames.includes(c.name));
        info(`[Qwen] Polling: ${cookies.length} cookies, auth found=${hasAuthCookies}`);

        if (hasAuthCookies) {
          clearInterval(pollInterval);
          done = true;
          info("[Qwen] Login detected via auth cookies! Refreshing page to capture final state");
          await page.reload({ waitUntil: "domcontentloaded" }).catch(() => { /* ignore */ });
          await new Promise((r) => setTimeout(r, 2000));
        }
      }, 2000);

      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          if (done) { resolve(); return; }
          clearInterval(pollInterval);
          info("[Qwen] Login polling timed out, asking user to confirm");
          const rl = readline.createInterface({ input: process.stdin });
          rl.question(chalk.yellow("Press Enter if you've completed login: "), () => {
            rl.close();
            done = true;
            resolve();
          });
        }, 300000);
      });

      const doneCheck = new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (done) { clearInterval(check); resolve(); }
        }, 200);
      });

      await Promise.race([doneCheck, timeoutPromise]);

      const allCookies = await page.cookies();
      info(`[Qwen] Total cookies found: ${allCookies.length}`);
      const authCookies = this.extractAuthCookies(allCookies);
      info(`[Qwen] Auth cookies found: ${authCookies.length}, names: ${authCookies.map(c => c.name).join(", ")}`);

      await browser.close();
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
      info("[Qwen] Browser closed, temp directory cleaned");

      if (authCookies.length > 0) {
        this.saveSession(authCookies);
        info(`[Qwen] Login successful! Session saved to ${this.getSessionFilePath()}`);
        console.log(chalk.green("Login successful!\n"));
        return authCookies;
      } else {
        info("[Qwen] Login failed: no auth cookies found");
        throw new Error(
          "Login completed but no auth cookies were found.\n" +
          "Make sure you completed login in the browser window, then try again."
        );
      }
    } catch (err) {
      info(`[Qwen] Login error: ${err instanceof Error ? err.message : String(err)}`);
      try { await browser.close(); } catch { /* ignore */ }
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new Error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private buildHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Cookie: this.cookieString,
      Origin: "https://chat.qwen.ai",
      Referer: "https://chat.qwen.ai/",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      ...extraHeaders,
    };
  }

  /**
   * Create a new chat session on the server and get the chat_id
   */
  private async fetchChatId(model: string): Promise<string> {
    const timestamp = Date.now();
    const body = JSON.stringify({
      title: "新建对话",
      models: [model],
      chat_mode: "normal",
      chat_type: "t2t",
      timestamp,
      project_id: "",
    });

    info(`[Qwen] Creating new chat via POST ${QWEN_NEW_CHAT}`);
    info(`[Qwen] New chat request body: ${body}`);

    return new Promise<string>((resolve, reject) => {
      const parsed = new URL(QWEN_NEW_CHAT);
      const req = https.request(parsed, {
        method: "POST",
        headers: this.buildHeaders(),
        timeout: 30000,
      }, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () => {
          info(`[Qwen] New chat HTTP ${res.statusCode}`);
          info(`[Qwen] New chat response headers: ${JSON.stringify(res.headers, null, 2)}`);
          info(`[Qwen] New chat response body: ${data}`);

          if (res.statusCode !== 200) {
            reject(new Error(`New chat HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
            return;
          }

          try {
            const json = JSON.parse(data);
            info(`[Qwen] New chat parsed response keys: ${Object.keys(json).join(", ")}`);
            if (json.data) {
              info(`[Qwen] New chat data keys: ${Object.keys(json.data).join(", ")}`);
            }
            // Try common field names for chat_id
            const chatId = json.data?.chat_id || json.chat_id || json.data?.id || json.id;
            if (chatId) {
              info(`[Qwen] Got chat_id from new chat response: ${chatId}`);
              resolve(chatId);
            } else {
              info(`[Qwen] Full response: ${JSON.stringify(json)}`);
              reject(new Error(`No chat_id found. Full response: ${data}`));
            }
          } catch (e) {
            reject(new Error(`Failed to parse new chat response: ${data}`));
          }
        });
      });

      req.on("error", (err) => {
        error(`[Qwen] New chat request error: ${err.message}`);
        reject(err);
      });
      req.write(body);
      req.end();
    });
  }

  private buildChatRequest(
    chatId: string,
    parentId: string,
    messages: ChatMessage[],
    model: string,
    systemPrompt?: string,
  ): Record<string, unknown> {
    const timestamp = Math.floor(Date.now() / 1000);

    const userMessages = messages.filter((m) => m.role === "user");
    const lastUserMessage = userMessages[userMessages.length - 1]?.content || "";
    const messageId = crypto.randomUUID();
    this.lastMessageId = messageId;

    const apiMessages: Record<string, unknown>[] = [];

    // Combine system prompt + tool instruction into user message
    // (Qwen web API doesn't accept separate system role messages)
    let messageContent = "";
    if (systemPrompt) {
      messageContent += "<system_prompt>\n" + systemPrompt + "\n</system_prompt>\n\n";
    }
    messageContent += QWEN_TOOL_INSTRUCTION + "\n\n---\n\n" + lastUserMessage;

    apiMessages.push({
      fid: messageId,
      parentId: parentId || null,
      childrenIds: [],
      role: "user",
      content: messageContent,
      user_action: "chat",
      files: [],
      timestamp,
      models: [model],
      chat_type: "t2t",
      feature_config: {
        thinking_enabled: true,
        output_schema: "phase",
        research_mode: "normal",
        auto_thinking: true,
        thinking_mode: "Auto",
        thinking_format: "summary",
        auto_search: true,
      },
      extra: { meta: { subChatType: "t2t" } },
      sub_chat_type: "t2t",
    });

    // Only include parent_id if it's not empty
    if (parentId) {
      (apiMessages[0] as Record<string, unknown>).parentId = parentId;
      (apiMessages[0] as Record<string, unknown>).parent_id = parentId;
    }

    const body: Record<string, unknown> = {
      stream: true,
      version: "2.1",
      incremental_output: true,
      chat_id: chatId,
      chat_mode: "normal",
      model,
      parent_id: parentId || null,
      messages: apiMessages,
      timestamp,
    };

    return body as Record<string, unknown>;
  }

  async chat(messages: ChatMessage[], abortSignal?: AbortSignal): Promise<ChatResponse> {
    const model = process.env.QWEN_MODEL || "qwen3.6-plus";

    // Extract system prompt from messages (first system message)
    const systemPrompt = messages.find((m) => m.role === "system")?.content;

    // Create a new chat session on the server to get a valid chat_id
    if (!this.chatId) {
      info("[Qwen] No chat_id, creating new chat session...");
      try {
        this.chatId = await this.fetchChatId(model);
        info(`[Qwen] Using new chat_id: ${this.chatId}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        error(`[Qwen] Failed to create chat: ${message}`);
        throw new Error(`Failed to initialize chat: ${message}`);
      }
    }
    // For first message in chat, use empty string. For subsequent messages, use server's response_id.
    const parentId = this.lastResponseId || "";

    // Build request body matching the web frontend packet capture format
    const requestBody = this.buildChatRequest(this.chatId, parentId, messages, model, systemPrompt);
    const bodyStr = JSON.stringify(requestBody);

    const url = `${QWEN_API}?chat_id=${encodeURIComponent(this.chatId)}`;
    info(`[Qwen] Chat request: model=${model}, messages=${messages.length}, chatId=${this.chatId}`);
    info(`[Qwen API] POST ${url}`);
    info(`[Qwen API] Request headers: ${JSON.stringify(this.buildHeaders())}`);
    info(`[Qwen API] Request body: ${bodyStr}`);

    let content = "";

    try {
      content = await this.sseFetch(url, bodyStr, abortSignal);
      info(`[Qwen] Chat response: ${content.length} chars`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      error(`[Qwen] Chat error: ${message}`);
      throw new Error(
        `Qwen API failed: ${message}. ` +
        "Try removing .qwen_session.json and logging in again."
      );
    }

    return { content };
  }

  /**
   * Fetch SSE streaming response and accumulate assistant content
   */
  private sseFetch(url: string, body: string, abortSignal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      // Handle already-aborted signal
      if (abortSignal?.aborted) {
        return reject(new Error("Request cancelled"));
      }

      const parsed = new URL(url);
      const req = https.request(parsed, {
        method: "POST",
        headers: this.buildHeaders(),
        timeout: 120000,
        signal: abortSignal,
      }, (res) => {
        if (res.statusCode !== 200) {
          let errData = "";
          res.on("data", (chunk) => (errData += chunk));
          res.on("end", () => {
            error(`[Qwen API] HTTP ${res.statusCode}: ${errData}`);
            reject(new Error(`HTTP ${res.statusCode}: ${errData}`));
          });
          return;
        }

        let accumulated = "";
        let buffer = "";
        let rawReceived = 0;
        let errorDetail = "";
        let currentResponseId: string | null = null;

        res.on("data", (chunk: Buffer) => {
          rawReceived += chunk.length;
          debug(`[Qwen SSE] Received chunk (${chunk.length} bytes): ${chunk.toString().slice(0, 300)}`);
          buffer += chunk.toString();

          // Process complete SSE lines
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            let jsonStr: string;
            if (trimmed.startsWith("data:")) {
              jsonStr = trimmed.slice(5).trim();
            } else {
              jsonStr = trimmed;
            }
            if (!jsonStr) continue;

            try {
              const event = JSON.parse(jsonStr) as Record<string, unknown>;
              debug(`[Qwen SSE] Parsed event keys: ${Object.keys(event).join(", ")}`);

              // Handle {success: false} error in SSE stream
              if (event["success"] === false) {
                const detail = (event["data"] || {}) as Record<string, unknown>;
                errorDetail = `${event["request_id"] || ""} | ${detail["code"] || ""}: ${detail["details"] || ""}`;
                error(`[Qwen SSE] Error in SSE stream: ${errorDetail}`);
                continue;
              }

              // Handle response.created event
              if (event["response.created"]) {
                const created = event["response.created"] as Record<string, unknown>;
                currentResponseId = (created.response_id as string) || null;
                info(`[Qwen SSE] Response created: ${currentResponseId}`);
                continue;
              }

              // Handle response.completed event
              if (event["response.completed"]) {
                info(`[Qwen SSE] Response completed`);
                continue;
              }

              // Handle choices array with delta content
              if (event.choices && Array.isArray(event.choices)) {
                for (const choice of event.choices) {
                  const c = choice as Record<string, unknown>;
                  const delta = (c.delta || {}) as Record<string, unknown>;
                  const phase = (delta.phase as string) || "";
                  const status = (delta.status as string) || "";
                  const deltaContent = (delta.content as string) || "";

                  // Accumulate content from "answer" phase
                  if (phase === "answer") {
                    accumulated += deltaContent;
                  }

                  // Log phase transitions
                  if (status === "finished") {
                    info(`[Qwen SSE] Phase "${phase}" finished, content length=${accumulated.length}`);
                  }
                }

                // Update lastResponseId from event-level response_id
                if (event["response_id"]) {
                  currentResponseId = (event["response_id"] as string) || currentResponseId;
                }
              }
            } catch (e) {
              debug(`[Qwen SSE] Failed to parse SSE event: ${jsonStr.slice(0, 200)}`);
            }
          }
        });

        res.on("end", () => {
          // Save server's response_id for next message's parent
          if (currentResponseId) {
            this.lastResponseId = currentResponseId;
            info(`[Qwen SSE] Saved lastResponseId: ${currentResponseId}`);
          }
          info(`[Qwen SSE] Stream ended: raw=${rawReceived} bytes, content=${accumulated.length} chars, errorDetail="${errorDetail}"`);
          if (errorDetail && accumulated.length === 0) {
            reject(new Error(`SSE stream error: ${errorDetail}`));
          } else {
            resolve(accumulated);
          }
        });

        res.on("error", (err) => {
          error(`[Qwen SSE] Stream error: ${err.message}`);
          reject(err);
        });
      });

      req.on("error", (err) => {
        error(`[Qwen API] Request error: ${err.message}`);
        reject(err);
      });

      req.write(body);
      req.end();
    });
  }
}

export { QwenProvider };
