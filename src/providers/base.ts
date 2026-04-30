import puppeteer, { Browser, Cookie } from "puppeteer";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as os from "os";
import chalk from "chalk";
import { info } from "../utils/logger";

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

  /**
   * Open URL in system browser (Windows/macOS/Linux)
   */
  protected async openInBrowser(url: string): Promise<boolean> {
    try {
      const platform = os.platform();
      const { exec } = await import("child_process");
      let cmd: string;
      let options: { shell?: string } = {};

      if (platform === "win32") {
        // Use cmd.exe /c start with an empty title string so Windows opens the default browser
        cmd = `cmd.exe /c start "" "${url}"`;
        options.shell = "cmd.exe";
      } else if (platform === "darwin") {
        cmd = `open "${url}"`;
      } else {
        cmd = `xdg-open "${url}"`;
      }

      return new Promise((resolve) => {
        exec(cmd, options, (err) => {
          if (err) {
            console.log(chalk.gray(`Failed to open browser: ${err.message}`));
            resolve(false);
          } else {
            resolve(true);
          }
        });
      });
    } catch {
      return false;
    }
  }

  getSessionFilePath(): string {
    return path.join(process.cwd(), this.info.sessionFile);
  }

  loadSession(): Cookie[] | null {
    return null;
  }

  saveSession(cookies: Cookie[]): void {
    fs.writeFileSync(
      this.getSessionFilePath(),
      JSON.stringify({ cookies, savedAt: new Date().toISOString() }, null, 2)
    );
  }

  protected async launchBrowser(): Promise<Browser> {
    // Auto-enable no-sandbox when running as root (Chromium refuses to run as root without it)
    const noSandbox = process.env.NO_SANDBOX === "1" || process.getuid?.() === 0;
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
  abstract chat(messages: ChatMessage[], signal?: AbortSignal): Promise<ChatResponse>;

  async login(): Promise<Cookie[]> {
    const existing = this.loadSession();
    if (existing && existing.length > 0) {
      info(`[${this.info.name}] Using cached session, ${existing.length} cookies`);
      console.log(chalk.gray(`Using cached session for ${this.info.name}...`));
      return existing;
    }

    info(`[${this.info.name}] No cached session, starting login`);
    console.log(chalk.cyan(`\n[${this.info.name}] Logging in...`));

    const hasDisplay = process.env.DISPLAY !== undefined;
    info(`[${this.info.name}] Platform display=${hasDisplay}, using ${hasDisplay ? "visible" : "screenshot"} mode`);
    if (!hasDisplay) {
      console.log(chalk.yellow("No display detected. Using screenshot mode for login."));
      return this.loginWithScreenshot();
    }

    console.log("Opening browser for login...");
    const browser = await this.launchBrowser();

    try {
      const page = await browser.newPage();
      info(`[${this.info.name}] Browser launched`);

      await page.setViewport({ width: 1280, height: 800 });
      info(`[${this.info.name}] Navigating to ${this.info.loginUrl}`);
      await page.goto(this.info.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      console.log(`Please login at ${this.info.loginUrl}`);
      console.log("Timeout: 5 minutes.\n");

      info(`[${this.info.name}] Waiting for user to complete login...`);
      const rl = readline.createInterface({ input: process.stdin });
      await new Promise<void>((resolve) => {
        rl.question("Press Enter after you've logged in: ", () => {
          rl.close();
          resolve();
        });
      });

      // Refresh to capture final login state
      info(`[${this.info.name}] Reloading page to capture cookies`);
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => { /* ignore */ });
      await new Promise((r) => setTimeout(r, 3000));

      const cookies = await page.cookies();
      info(`[${this.info.name}] Total cookies: ${cookies.length}`);
      const authCookies = this.extractAuthCookies(cookies);
      info(`[${this.info.name}] Auth cookies: ${authCookies.length}, names: ${authCookies.map(c => c.name).join(", ")}`);

      await browser.close();

      if (authCookies.length > 0) {
        this.saveSession(authCookies);
        info(`[${this.info.name}] Login successful!`);
        console.log(chalk.green("Login successful!\n"));
        return authCookies;
      } else {
        info(`[${this.info.name}] No auth cookies found after login`);
        throw new Error("Login completed but no auth cookies were found. Please try again.");
      }
    } catch (err) {
      info(`[${this.info.name}] Login error: ${err instanceof Error ? err.message : String(err)}`);
      try { await browser.close(); } catch { /* ignore */ }
      throw new Error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Headless login: show URL and wait for user to complete login in their own browser
   */
  async loginWithScreenshot(): Promise<Cookie[]> {
    info(`[${this.info.name}] Starting headless login via URL`);
    const browser = await this.launchBrowser();

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      info(`[${this.info.name}] Navigating to ${this.info.loginUrl}`);
      await page.goto(this.info.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      // Show the login URL for users to open in their browser
      console.log(chalk.cyan(`\nOpen this URL in your browser to log in:`));
      console.log(chalk.white(`  ${this.info.loginUrl}\n`));

      info(`[${this.info.name}] Waiting for user confirmation...`);
      const rl = readline.createInterface({ input: process.stdin });
      await new Promise<void>((resolve) => {
        rl.question("Press Enter after you've logged in: ", () => {
          rl.close();
          resolve();
        });
      });

      // Refresh to capture final login state
      info(`[${this.info.name}] Reloading page to capture cookies`);
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => { /* ignore */ });
      await new Promise((r) => setTimeout(r, 3000));

      const cookies = await page.cookies();
      info(`[${this.info.name}] Total cookies: ${cookies.length}`);
      const authCookies = this.extractAuthCookies(cookies);
      info(`[${this.info.name}] Auth cookies: ${authCookies.length}, names: ${authCookies.map(c => c.name).join(", ")}`);

      if (authCookies.length === 0) {
        info(`[${this.info.name}] No auth cookies found`);
        throw new Error("No auth cookies found. Login may not have completed.");
      }

      await browser.close();
      this.saveSession(authCookies);
      info(`[${this.info.name}] Login successful`);
      console.log(chalk.green("Login successful!\n"));
      return authCookies;
    } catch (err) {
      info(`[${this.info.name}] Login error: ${err instanceof Error ? err.message : String(err)}`);
      try { await browser.close(); } catch { /* ignore */ }
      throw new Error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
