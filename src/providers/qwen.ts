import * as https from "https";
import { Cookie } from "puppeteer";
import { BaseProvider, ChatMessage, ChatResponse, ProviderInfo } from "./base";
import * as readline from "readline";
import chalk from "chalk";

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
      console.log(chalk.yellow(isWindows ? "Windows detected. Opening system browser." : "No display detected. Using headless mode."));
      return this.loginWithBrowser();
    }

    console.log("Opening browser for login...");
    return super.login();
  }

  /**
   * Login by opening system browser and waiting for user to complete login
   */
  async loginWithBrowser(): Promise<Cookie[]> {
    const puppeteer = await import("puppeteer");
    const { renderBase64Image } = await import("../utils/renderImage");

    // Try to open system browser first
    const browserOpened = await this.openInBrowser(this.info.loginUrl);
    if (browserOpened) {
      console.log(chalk.green(`Opened ${this.info.loginUrl} in your browser.`));
      console.log(chalk.gray("Please complete login in the browser window.\n"));
    }

    // Also launch headless browser to capture cookies
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(this.info.loginUrl, { waitUntil: "networkidle0", timeout: 60000 });

      // Wait a bit for page to load
      await new Promise(r => setTimeout(r, 2000));

      // Take screenshot for fallback
      const screenshot = await page.screenshot({ encoding: "base64" });

      if (!browserOpened) {
        console.log(chalk.yellow("\nFailed to open system browser. Showing QR code instead:\n"));
        await renderBase64Image(screenshot);
      } else {
        console.log(chalk.cyan(`Or scan the QR code below if needed:\n`));
        await renderBase64Image(screenshot);
      }

      // Wait for user to complete login
      const answer = await new Promise<string>((resolve) => {
        const rl = readline.createInterface({ input: process.stdin });
        rl.question("Press Enter after logging in: ", (ans) => {
          rl.close();
          resolve(ans);
        });
      });

      await new Promise((r) => setTimeout(r, 3000));

      const cookies = await page.cookies();
      const authCookies = this.extractAuthCookies(cookies);

      await browser.close();

      if (authCookies.length > 0) {
        this.saveSession(authCookies);
        console.log(chalk.green("Login successful!\n"));
        return authCookies;
      } else {
        throw new Error("Login completed but no auth cookies found.");
      }
    } catch (err) {
      try { await browser.close(); } catch { /* ignore */ }
      throw new Error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Cookie: this.cookieString,
      Origin: "https://tongyi.aliyun.com",
      Referer: "https://tongyi.aliyun.com/",
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

  async chat(messages: ChatMessage[]): Promise<ChatResponse> {
    const conversationText = messages
      .filter((m) => m.role !== "system")
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n\n");

    const body = JSON.stringify({ prompt: conversationText, sessionId: this.sessionId });

    let response: Record<string, unknown>;
    try {
      response = await this.apiFetch(QWEN_API, body);
    } catch (err) {
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
