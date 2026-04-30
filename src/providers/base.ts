import puppeteer, { Browser, Cookie } from "puppeteer";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import chalk from "chalk";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  content: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  loginUrl: string;
  sessionFile: string;
  apiUrl: string;
}

export abstract class BaseProvider {
  abstract readonly info: ProviderInfo;
  protected sessionId: string | null = null;
  protected cookieString: string = "";

  getSessionFilePath(): string {
    return path.join(process.cwd(), this.info.sessionFile);
  }

  loadSession(): Cookie[] | null {
    const file = this.getSessionFilePath();
    if (!fs.existsSync(file)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      const savedAt = new Date(data.savedAt);
      const now = new Date();
      if (now.getTime() - savedAt.getTime() > 12 * 60 * 60 * 1000) return null;
      return data.cookies;
    } catch {
      return null;
    }
  }

  saveSession(cookies: Cookie[]): void {
    fs.writeFileSync(
      this.getSessionFilePath(),
      JSON.stringify({ cookies, savedAt: new Date().toISOString() }, null, 2)
    );
  }

  protected async launchBrowser(): Promise<Browser> {
    const noSandbox = process.env.NO_SANDBOX === "1";
    const hasDisplay = process.env.DISPLAY !== undefined;

    return puppeteer.launch({
      headless: !hasDisplay,
      args: noSandbox
        ? ["--no-sandbox", "--disable-setuid-sandbox"]
        : [],
    });
  }

  /**
   * Check if login is complete by examining the page
   * Each provider must implement its own detection logic
   */
  protected abstract isLoginComplete(): string;

  /**
   * Extract authentication cookies from the current page
   */
  protected abstract extractAuthCookies(cookies: Cookie[]): Cookie[];

  /**
   * Send a chat message to the API and return the response
   */
  abstract chat(messages: ChatMessage[]): Promise<ChatResponse>;

  async login(): Promise<Cookie[]> {
    const existing = this.loadSession();
    if (existing && existing.length > 0) {
      console.log(chalk.gray(`Using cached session for ${this.info.name}...`));
      return existing;
    }

    console.log(chalk.cyan(`\n[${this.info.name}] Logging in...`));

    const hasDisplay = process.env.DISPLAY !== undefined;
    if (!hasDisplay) {
      console.log(chalk.yellow("No display detected. Using screenshot mode for login."));
      return this.loginWithScreenshot();
    }

    console.log("Opening browser for login...");
    const browser = await this.launchBrowser();

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(this.info.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      console.log(`Please login at ${this.info.loginUrl}`);
      console.log("Timeout: 5 minutes.\n");

      await page.waitForFunction(this.isLoginComplete(), { timeout: 300000, polling: 500 });
      await new Promise((r) => setTimeout(r, 3000));

      const cookies = await page.cookies();
      const authCookies = this.extractAuthCookies(cookies);

      await browser.close();
      this.saveSession(authCookies);
      console.log(chalk.green("Login successful!\n"));
      return authCookies;
    } catch (err) {
      try { await browser.close(); } catch { /* ignore */ }
      throw new Error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Headless login: take screenshots and show them in terminal
   * User scans QR code from terminal or enters credentials
   */
  async loginWithScreenshot(): Promise<Cookie[]> {
    const browser = await this.launchBrowser();

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(this.info.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      // Take screenshot of login page
      const screenshot = await page.screenshot({ encoding: "base64" });
      console.log(chalk.yellow("\nLogin page screenshot (base64):"));
      console.log(screenshot.slice(0, 200) + "...");
      console.log(chalk.yellow("Save this base64 string, decode it on your machine to see the QR code/login form."));
      console.log(chalk.yellow("After scanning/entering credentials, press Enter to continue...\n"));

      const rl = readline.createInterface({ input: process.stdin });
      await new Promise<void>((resolve) => {
        rl.question("Press Enter after you've logged in: ", () => {
          rl.close();
          resolve();
        });
      });

      await new Promise((r) => setTimeout(r, 3000));

      const cookies = await page.cookies();
      const authCookies = this.extractAuthCookies(cookies);

      if (authCookies.length === 0) {
        throw new Error("No auth cookies found. Login may not have completed.");
      }

      await browser.close();
      this.saveSession(authCookies);
      console.log(chalk.green("Login successful!\n"));
      return authCookies;
    } catch (err) {
      try { await browser.close(); } catch { /* ignore */ }
      throw new Error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
