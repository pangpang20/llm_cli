import * as https from "https";
import { Cookie } from "puppeteer";
import { BaseProvider, ChatMessage, ChatResponse, ProviderInfo } from "./base";
import chalk from "chalk";
import { info } from "../utils/logger";

const DEEPSEEK_API = "https://chat.deepseek.com/api/chat";

class DeepSeekProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: "deepseek",
    name: "DeepSeek",
    loginUrl: "https://chat.deepseek.com/",
    sessionFile: ".deepseek_session.json",
    apiUrl: DEEPSEEK_API,
  };

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
      (c) => c.name === "token" ||
             c.name === "session_id" ||
             c.name === "sid" ||
             c.name.startsWith("auth_") ||
             c.name === "refresh_token" ||
             (c.domain.includes("deepseek") && (c.httpOnly || c.name.toLowerCase().includes("token")))
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

  private async apiFetch(url: string, body: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = https.request(parsed, { method: "POST", headers: this.buildHeaders() }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch {
            reject(new Error(`Failed to parse: ${data.slice(0, 500)}`));
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
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(this.info.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      info("[DeepSeek] Page loaded, waiting for user login");
      console.log(chalk.green(`Opened ${this.info.loginUrl} in your browser.`));
      console.log(chalk.gray("Please complete login in the browser window.\n"));

      const authCookieNames = ["token", "session_id", "sid", "refresh_token", "auth_"];
      let done = false;

      const pollInterval = setInterval(async () => {
        if (done) return;
        const cookies = await page.cookies();
        const hasAuthCookies = cookies.some((c) => authCookieNames.some(n => c.name.startsWith(n) || c.name === n));
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

  async chat(messages: ChatMessage[], _signal?: AbortSignal): Promise<ChatResponse> {
    const conversationText = messages
      .filter((m) => m.role !== "system")
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n\n");

    const body = JSON.stringify({ prompt: conversationText, sessionId: this.sessionId });

    let response: Record<string, unknown>;
    try {
      response = await this.apiFetch(DEEPSEEK_API, body);
    } catch (err) {
      throw new Error(
        `DeepSeek API failed: ${err instanceof Error ? err.message : String(err)}. ` +
        "Try removing .deepseek_session.json and logging in again."
      );
    }

    if (typeof response.sessionId === "string") this.sessionId = response.sessionId;

    const content = typeof response.content === "string" ? response.content
      : typeof response.message === "string" ? response.message
      : typeof response.text === "string" ? response.text
      : JSON.stringify(response);

    return { content };
  }
}

export { DeepSeekProvider };
