import * as https from "https";
import * as crypto from "crypto";
import { Cookie } from "puppeteer";
import { BaseProvider, ChatMessage, ChatResponse, ProviderInfo } from "./base";
import chalk from "chalk";
import { info, error } from "../utils/logger";

const KIMI_CHAT = "https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat";

class KimiProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: "kimi",
    name: "Kimi (月之暗面)",
    loginUrl: "https://www.kimi.com/",
    sessionFile: ".kimi_session.json",
    apiUrl: KIMI_CHAT,
  };

  private chatSessionId: string | null = null;

  protected isLoginComplete(): string {
    return `() => {
      const url = window.location.href;
      if (url === "https://www.kimi.com/" || url.startsWith("https://www.kimi.com/chat/")) {
        const loginEl = document.querySelector('[class*="login"], [class*="Login"], [class*="auth"]');
        return !loginEl;
      }
      return false;
    }`;
  }

  protected extractAuthCookies(cookies: Cookie[]): Cookie[] {
    return cookies.filter(
      (c) => c.name === "kimi-auth" ||
             c.name.startsWith("__snaker__") ||
             c.name.startsWith("Hm_") ||
             c.name === "HMACCOUNT" ||
             c.name.includes("gdxidpyhxdE") ||
             (c.domain.includes("kimi") && (c.httpOnly || c.name.toLowerCase().includes("auth")))
    );
  }

  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Cookie: this.cookieString,
      Origin: "https://www.kimi.com",
      Referer: "https://www.kimi.com/",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };
  }

  override async login(): Promise<Cookie[]> {
    const existing = this.loadSession();
    if (existing && existing.length > 0) {
      info(`[Kimi] Using cached session, ${existing.length} cookies`);
      this.cookieString = existing.map((c) => `${c.name}=${c.value}`).join("; ");
      console.log(chalk.gray(`Using cached session for ${this.info.name}...`));
      return existing;
    }

    info(`[Kimi] No cached session, starting login flow`);
    console.log(chalk.cyan(`\n[${this.info.name}] Logging in...`));

    const hasDisplay = process.env.DISPLAY !== undefined;
    const isWindows = process.platform === "win32";

    if (!hasDisplay || isWindows) {
      info(`[Kimi] Using visible browser login mode`);
      console.log(chalk.yellow(isWindows ? "Windows detected. Opening visible browser for login." : "No display detected. Opening visible browser for login."));
      const cookies = await this.loginWithBrowser();
      this.cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      return cookies;
    }

    info(`[Kimi] Using desktop mode with display`);
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

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-login-"));

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
      info("[Kimi] Browser launched, new page created");

      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
      });

      info(`[Kimi] Navigating to ${this.info.loginUrl}`);
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(this.info.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      info("[Kimi] Page loaded, waiting for user login");
      console.log(chalk.green(`Opened ${this.info.loginUrl} in your browser.`));
      console.log(chalk.gray("Please complete login in the browser window.\n"));

      const authCookieNames = ["kimi-auth", "__snaker__id", "HMACCOUNT"];
      let done = false;

      const pollInterval = setInterval(async () => {
        if (done) return;
        const cookies = await page.cookies();
        const hasAuthCookies = cookies.some((c) => authCookieNames.includes(c.name));
        info(`[Kimi] Polling: ${cookies.length} cookies, auth found=${hasAuthCookies}`);
        if (hasAuthCookies) {
          clearInterval(pollInterval);
          done = true;
          info("[Kimi] Login detected via auth cookies! Refreshing page");
          await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
          await new Promise((r) => setTimeout(r, 2000));
        }
      }, 2000);

      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          if (done) { resolve(); return; }
          clearInterval(pollInterval);
          info("[Kimi] Login polling timed out");
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
      info(`[Kimi] Total cookies found: ${allCookies.length}`);
      const authCookies = this.extractAuthCookies(allCookies);
      info(`[Kimi] Auth cookies found: ${authCookies.length}, names: ${authCookies.map(c => c.name).join(", ")}`);

      await browser.close();
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}

      if (authCookies.length > 0) {
        this.saveSession(authCookies);
        info(`[Kimi] Login successful! Session saved`);
        console.log(chalk.green("Login successful!\n"));
        return authCookies;
      } else {
        throw new Error("Login completed but no auth cookies were found. Please try again.");
      }
    } catch (err) {
      info(`[Kimi] Login error: ${err instanceof Error ? err.message : String(err)}`);
      try { await browser.close(); } catch {}
      throw new Error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async chat(messages: ChatMessage[], abortSignal?: AbortSignal): Promise<ChatResponse> {
    if (!this.chatSessionId) {
      this.chatSessionId = crypto.randomUUID();
      info(`[Kimi] Created new chat session: ${this.chatSessionId}`);
    }

    const userMessages = messages.filter((m) => m.role !== "system");
    const lastUserMessage = userMessages[userMessages.length - 1]?.content || "";

    const body = JSON.stringify({
      scenario: "SCENARIO_K2D5",
      tools: [{ type: "TOOL_TYPE_SEARCH", search: {} }],
      message: {
        role: "user",
        blocks: [{
          message_id: "",
          text: { content: lastUserMessage },
        }],
      },
    });

    let content = "";
    try {
      content = await this.sseFetch(KIMI_CHAT, body, abortSignal);
      info(`[Kimi] Chat response: ${content.length} chars`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "Request cancelled") throw err;
      error(`[Kimi] Chat error: ${message}`);
      throw new Error(
        `Kimi API failed: ${message}. ` +
        "Try removing .kimi_session.json and logging in again."
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
            error(`[Kimi API] HTTP ${res.statusCode}: ${errData}`);
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
              const text = event.text as string | undefined;
              if (text) accumulated += text;
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

export { KimiProvider };
