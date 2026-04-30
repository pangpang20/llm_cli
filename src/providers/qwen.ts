import * as https from "https";
import { Cookie } from "puppeteer";
import { BaseProvider, ChatMessage, ChatResponse, ProviderInfo } from "./base";
import chalk from "chalk";
import { debug, info, error } from "../utils/logger";

const QWEN_API = "https://chat.qwen.ai/api/chat";

class QwenProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: "qwen",
    name: "Qwen (通义千问)",
    loginUrl: "https://chat.qwen.ai/",
    sessionFile: ".qwen_session.json",
    apiUrl: QWEN_API,
  };

  protected isLoginComplete(): string {
    return `() => {
      const url = window.location.href;
      // Check if user is logged in (not on login page)
      if (url.includes("login") || url.includes("signin")) {
        return false;
      }
      // Check for user avatar or profile element
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
      console.log(chalk.gray(`Using cached session for ${this.info.name}...`));
      return existing;
    }

    console.log(chalk.cyan(`\n[${this.info.name}] Logging in...`));

    const hasDisplay = process.env.DISPLAY !== undefined;
    const isWindows = process.platform === "win32";

    if (!hasDisplay || isWindows) {
      console.log(chalk.yellow(isWindows ? "Windows detected. Opening visible browser for login." : "No display detected. Opening visible browser for login."));
      return this.loginWithBrowser();
    }

    console.log("Opening browser for login...");
    return super.login();
  }

  /**
   * Login by opening a visible browser and waiting for user to complete login
   * Uses a single browser instance so cookies are properly captured
   */
  async loginWithBrowser(): Promise<Cookie[]> {
    const puppeteer = await import("puppeteer");
    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs");

    // Create a temporary user data directory so the browser behaves like a normal instance
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-login-"));

    // Launch a visible browser (non-headless) so the user can interact with the login page
    const browser = await puppeteer.launch({
      headless: false,
      userDataDir,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(this.info.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      console.log(chalk.green(`Opened ${this.info.loginUrl} in your browser.`));
      console.log(chalk.gray("Please complete login in the browser window.\n"));

      // Wait for login to complete with a 5-minute timeout
      const loginComplete = await page.waitForFunction(
        this.isLoginComplete(),
        { timeout: 300000, polling: 1000 }
      ).then(() => true).catch(() => false);

      if (!loginComplete) {
        throw new Error(
          "Login timed out after 5 minutes. Please try again.\n" +
          "Press Ctrl+C to cancel, then re-run and select your provider."
        );
      }

      // Give the page a moment to finish any post-login redirects
      await new Promise((r) => setTimeout(r, 3000));

      const cookies = await page.cookies();
      const authCookies = this.extractAuthCookies(cookies);

      await browser.close();
      // Clean up temp directory
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }

      if (authCookies.length > 0) {
        this.saveSession(authCookies);
        console.log(chalk.green("Login successful!\n"));
        return authCookies;
      } else {
        throw new Error(
          "Login appeared to complete but no auth cookies were found.\n" +
          "This may mean the login page changed. Please try again."
        );
      }
    } catch (err) {
      try { await browser.close(); } catch { /* ignore */ }
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new Error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Cookie: this.cookieString,
      Origin: "https://chat.qwen.ai",
      Referer: "https://chat.qwen.ai/",
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
          debug(`[Qwen API] Status: ${res.statusCode}`);
          if (res.statusCode !== 200) {
            error(`[Qwen API] HTTP ${res.statusCode}: ${data.slice(0, 500)}`);
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            return;
          }
          try {
            const json = JSON.parse(data);
            debug(`[Qwen API] Response parsed OK`);
            resolve(json);
          } catch (e) {
            error(`[Qwen API] Failed to parse JSON: ${data.slice(0, 200)}`);
            reject(new Error(`Failed to parse: ${data.slice(0, 500)}`));
          }
        });
      });
      req.on("error", (err) => {
        error(`[Qwen API] Request error: ${err.message}`);
        reject(err);
      });
      debug(`[Qwen API] POST ${url}`);
      debug(`[Qwen API] Body: ${body.slice(0, 200)}...`);
      req.write(body);
      req.end();
    });
  }

  async chat(messages: ChatMessage[]): Promise<ChatResponse> {
    const conversationText = messages
      .filter((m) => m.role !== "system")
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n\n");

    const body = JSON.stringify({ prompt: conversationText, sessionId: this.sessionId });

    let response: Record<string, unknown>;
    try {
      response = await this.apiFetch(QWEN_API, body);
      console.log(chalk.gray(`  [Qwen API] Full response: ${JSON.stringify(response).slice(0, 500)}`));
    } catch (err) {
      console.log(chalk.red(`  [Qwen API] Error details: ${err instanceof Error ? err.message : String(err)}`));
      console.log(chalk.red(`  [Qwen API] Cookies: ${this.cookieString.slice(0, 100)}...`));
      throw new Error(
        `Qwen API failed: ${err instanceof Error ? err.message : String(err)}. ` +
        "Try removing .qwen_session.json and logging in again."
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

export { QwenProvider };
