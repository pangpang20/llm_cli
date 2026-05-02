import * as https from "https";
import * as crypto from "crypto";
import { Cookie } from "puppeteer";
import { BaseProvider, ChatMessage, ChatResponse, ProviderInfo } from "./base";
import chalk from "chalk";
import { info, error } from "../utils/logger";

const DEEPSEEK_CREATE_SESSION = "https://chat.deepseek.com/api/v0/chat/create_pow_challenge";
const DEEPSEEK_CHAT = "https://chat.deepseek.com/api/v0/chat/completion";

class DeepSeekProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: "deepseek",
    name: "DeepSeek",
    loginUrl: "https://chat.deepseek.com/",
    sessionFile: ".deepseek_session.json",
    apiUrl: DEEPSEEK_CHAT,
  };

  private chatSessionId: string | null = null;
  private lastMessageId: string | null = null;

  protected isLoginComplete(): string {
    return `() => {
      const url = window.location.href;
      if (url === "https://chat.deepseek.com/" || url.startsWith("https://chat.deepseek.com/chat/")) {
        const loginEl = document.querySelector('[class*="login"], [class*="Login"], [class*="auth"]');
        return !loginEl;
      }
      return false;
    }`;
  }

  protected extractAuthCookies(cookies: Cookie[]): Cookie[] {
    return cookies.filter(
      (c) => c.name === "ds_session_id" ||
             c.name.startsWith("HWWAF") ||
             c.name === "smidV2" ||
             c.name.includes("thumbcache") ||
             c.name === "token" ||
             c.name === "session_id" ||
             c.name.startsWith("auth_") ||
             (c.domain.includes("deepseek") && (c.httpOnly || c.name.toLowerCase().includes("session")))
    );
  }

  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Cookie: this.cookieString,
      Origin: "https://chat.deepseek.com",
      Referer: "https://chat.deepseek.com/",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };
  }

  private async createChatSession(): Promise<string> {
    const sessionId = crypto.randomUUID();
    const body = JSON.stringify({ chat_session_id: sessionId });

    return new Promise((resolve, reject) => {
      const parsed = new URL(DEEPSEEK_CREATE_SESSION);
      const req = https.request(parsed, { method: "POST", headers: this.buildHeaders() }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          info(`[DeepSeek] Create session response: ${res.statusCode} ${data.slice(0, 200)}`);
          if (res.statusCode === 200) {
            resolve(sessionId);
          } else {
            reject(new Error(`Failed to create session: HTTP ${res.statusCode}`));
          }
        });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  override async login(): Promise<Cookie[]> {
    const existing = this.loadSession();
    if (existing && existing.length > 0) {
      info(`[DeepSeek] Using cached session, ${existing.length} cookies`);
      this.cookieString = existing.map((c) => `${c.name}=${c.value}`).join("; ");
      console.log(chalk.gray(`Using cached session for ${this.info.name}...`));
      return existing;
    }

    info(`[DeepSeek] No cached session, starting login flow`);
    console.log(chalk.cyan(`\n[${this.info.name}] Logging in...`));

    const hasDisplay = process.env.DISPLAY !== undefined;
    const isWindows = process.platform === "win32";

    if (!hasDisplay || isWindows) {
      info(`[DeepSeek] Using visible browser login mode`);
      console.log(chalk.yellow(isWindows ? "Windows detected. Opening visible browser for login." : "No display detected. Opening visible browser for login."));
      const cookies = await this.loginWithBrowser();
      this.cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      return cookies;
    }

    info(`[DeepSeek] Using desktop mode with display`);
    console.log("Opening browser for login...");
    const cookies = await super.login();
    this.cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    return cookies;
  }

  private async loginWithBrowser(): Promise<Cookie[]> {
    const puppeteer = await import("puppeteer");
    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs");
    const readline = await import("readline");

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-login-"));

    const { findChromePath } = await import("../utils/chrome");
    const executablePath = findChromePath();
    const browser = await puppeteer.launch({
      headless: false,
      executablePath,
      userDataDir,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    try {
      const page = await browser.newPage();
      info("[DeepSeek] Browser launched, new page created");

      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
      });

      info(`[DeepSeek] Navigating to ${this.info.loginUrl}`);
      await page.setViewport({ width: 1664, height: 800 });
      await page.goto(this.info.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      info("[DeepSeek] Page loaded, waiting for user login");
      console.log(chalk.green(`Opened ${this.info.loginUrl} in your browser.`));
      console.log(chalk.gray("Please complete login in the browser window.\n"));

      const authCookieNames = ["ds_session_id", "HWWAFSESID", "HWWAFSESTIME"];
      let done = false;

      const pollInterval = setInterval(async () => {
        if (done) return;
        const cookies = await page.cookies();
        const hasAuthCookies = cookies.some((c) => authCookieNames.includes(c.name));
        info(`[DeepSeek] Polling: ${cookies.length} cookies, auth found=${hasAuthCookies}`);
        if (hasAuthCookies) {
          clearInterval(pollInterval);
          done = true;
          info("[DeepSeek] Login detected via auth cookies! Refreshing page");
          await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
          await new Promise((r) => setTimeout(r, 2000));
        }
      }, 2000);

      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          if (done) { resolve(); return; }
          clearInterval(pollInterval);
          info("[DeepSeek] Login polling timed out");
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
      info(`[DeepSeek] Total cookies found: ${allCookies.length}`);
      const authCookies = this.extractAuthCookies(allCookies);
      info(`[DeepSeek] Auth cookies found: ${authCookies.length}, names: ${authCookies.map(c => c.name).join(", ")}`);

      await browser.close();
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}

      if (authCookies.length > 0) {
        this.saveSession(authCookies);
        info(`[DeepSeek] Login successful! Session saved`);
        console.log(chalk.green("Login successful!\n"));
        return authCookies;
      } else {
        throw new Error("Login completed but no auth cookies were found. Please try again.");
      }
    } catch (err) {
      info(`[DeepSeek] Login error: ${err instanceof Error ? err.message : String(err)}`);
      try { await browser.close(); } catch {}
      throw new Error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async chat(messages: ChatMessage[], abortSignal?: AbortSignal): Promise<ChatResponse> {
    if (!this.chatSessionId) {
      info("[DeepSeek] No chat session, creating new one...");
      try {
        this.chatSessionId = await this.createChatSession();
        info(`[DeepSeek] Created chat session: ${this.chatSessionId}`);
      } catch (err) {
        error(`[DeepSeek] Failed to create chat session: ${err instanceof Error ? err.message : String(err)}`);
        throw new Error("Failed to create DeepSeek chat session. Please try again.");
      }
    }

    const userMessages = messages.filter((m) => m.role !== "system");
    const lastUserMessage = userMessages[userMessages.length - 1]?.content || "";

    const body = JSON.stringify({
      chat_session_id: this.chatSessionId,
      parent_message_id: this.lastMessageId,
      model_type: "default",
      prompt: lastUserMessage,
      ref_file_ids: [],
      thinking_enabled: false,
      search_enabled: false,
      preempt: false,
    });

    let content = "";
    try {
      content = await this.sseFetch(DEEPSEEK_CHAT, body, abortSignal);
      info(`[DeepSeek] Chat response: ${content.length} chars`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "Request cancelled") throw err;
      error(`[DeepSeek] Chat error: ${message}`);
      throw new Error(
        `DeepSeek API failed: ${message}. ` +
        "Try removing .deepseek_session.json and logging in again."
      );
    }

    return { content };
  }

  private sseFetch(url: string, body: string, abortSignal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
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
            error(`[DeepSeek API] HTTP ${res.statusCode}: ${errData}`);
            reject(new Error(`HTTP ${res.statusCode}: ${errData}`));
          });
          return;
        }

        let accumulated = "";
        let buffer = "";

        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;

            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr || jsonStr === "[DONE]") continue;

            try {
              const event = JSON.parse(jsonStr) as Record<string, unknown>;
              const choices = event.choices as Array<Record<string, unknown>> | undefined;
              if (choices && choices.length > 0) {
                const delta = choices[0].delta as Record<string, unknown> | undefined;
                const content = delta?.content as string | undefined;
                if (content) accumulated += content;
                const msgId = choices[0].message_id as string | undefined;
                if (msgId) this.lastMessageId = msgId;
              }
            } catch {
              // Ignore parse errors
            }
          }
        });

        res.on("end", () => {
          resolve(accumulated || "(empty response)");
        });
      });

      req.on("error", (err) => {
        if (err.name === "AbortError") {
          reject(new Error("Request cancelled"));
        } else {
          reject(err);
        }
      });

      if (abortSignal) {
        abortSignal.addEventListener("abort", () => {
          req.destroy(new Error("Request cancelled"));
        });
      }

      req.write(body);
      req.end();
    });
  }
}

export { DeepSeekProvider };
