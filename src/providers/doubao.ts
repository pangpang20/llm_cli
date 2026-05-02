import { Browser, Page, Cookie } from "puppeteer";
import { BaseProvider, ChatMessage, ChatResponse, ProviderInfo } from "./base";
import chalk from "chalk";
import { info, error } from "../utils/logger";
import { findChromePath } from "../utils/chrome";

class DoubaoProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: "doubao",
    name: "Doubao (豆包)",
    loginUrl: "https://www.doubao.com/",
    sessionFile: ".doubao_session.json",
    apiUrl: "https://www.doubao.com/chat/completion",
  };

  private browser: Browser | null = null;
  private page: Page | null = null;

  protected isLoginComplete(): string {
    return `() => {
      const url = window.location.href;
      if (url === "https://www.doubao.com/" || url.startsWith("https://www.doubao.com/chat/")) {
        const loginBtn = document.querySelector('[class*="login"], [class*="Login"], a[href*="login"]');
        return !loginBtn;
      }
      return false;
    }`;
  }

  protected extractAuthCookies(cookies: Cookie[]): Cookie[] {
    return cookies.filter(
      (c) => c.name === "sessionid" ||
             c.name === "sid_tt" ||
             c.name === "uid_tt" ||
             c.name === "ttwid" ||
             (c.domain.includes("doubao") || c.domain.includes("byte"))
    );
  }

  override async login(): Promise<Cookie[]> {
    const existing = this.loadSession();
    if (existing && existing.length > 0) {
      info(`[Doubao] Using cached session, ${existing.length} cookies`);
      this.cookieString = existing.map((c) => `${c.name}=${c.value}`).join("; ");
      console.log(chalk.gray(`Using cached session for ${this.info.name}...`));
      return existing;
    }

    info(`[Doubao] No cached session, starting login flow`);
    console.log(chalk.cyan(`\n[${this.info.name}] Logging in...`));

    const hasDisplay = process.env.DISPLAY !== undefined;
    const isWindows = process.platform === "win32";

    if (!hasDisplay || isWindows) {
      info(`[Doubao] Using visible browser login mode`);
      console.log(chalk.yellow(isWindows ? "Windows detected. Opening visible browser for login." : "No display detected. Opening visible browser for login."));
      const cookies = await this.loginWithBrowser();
      this.cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      return cookies;
    }

    info(`[Doubao] Using desktop mode with display`);
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

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-login-"));

    const executablePath = findChromePath();
    this.browser = await puppeteer.launch({
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
      this.page = await this.browser.newPage();
      info("[Doubao] Browser launched, new page created");

      await this.page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
      });

      info(`[Doubao] Navigating to ${this.info.loginUrl}`);
      await this.page.setViewport({ width: 1664, height: 800 });
      await this.page.goto(this.info.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      info("[Doubao] Page loaded, waiting for user login");
      console.log(chalk.green(`Opened ${this.info.loginUrl} in your browser.`));
      console.log(chalk.gray("Please complete login in the browser window.\n"));

      const authCookieNames = ["sessionid", "sid_tt", "uid_tt"];
      let done = false;

      const pollInterval = setInterval(async () => {
        if (done || !this.page) return;
        const cookies = await this.page.cookies();
        const hasAuthCookies = cookies.some((c) => authCookieNames.includes(c.name));
        info(`[Doubao] Polling: ${cookies.length} cookies, auth found=${hasAuthCookies}`);
        if (hasAuthCookies) {
          clearInterval(pollInterval);
          done = true;
          info("[Doubao] Login detected via auth cookies! Refreshing page");
          await this.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
          await new Promise((r) => setTimeout(r, 2000));
        }
      }, 2000);

      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          if (done) { resolve(); return; }
          clearInterval(pollInterval);
          info("[Doubao] Login polling timed out");
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

      if (!this.page) throw new Error("Browser page not available");

      const allCookies = await this.page.cookies();
      info(`[Doubao] Total cookies found: ${allCookies.length}`);
      const authCookies = this.extractAuthCookies(allCookies);
      info(`[Doubao] Auth cookies found: ${authCookies.length}, names: ${authCookies.map(c => c.name).join(", ")}`);

      if (authCookies.length > 0) {
        this.saveSession(authCookies);
        info(`[Doubao] Login successful! Session saved`);
        console.log(chalk.green("Login successful!\n"));
        // Keep browser open for chat
        return authCookies;
      } else {
        await this.browser.close();
        this.browser = null;
        this.page = null;
        throw new Error("Login completed but no auth cookies were found. Please try again.");
      }
    } catch (err) {
      info(`[Doubao] Login error: ${err instanceof Error ? err.message : String(err)}`);
      if (this.browser) {
        try { await this.browser.close(); } catch {}
        this.browser = null;
        this.page = null;
      }
      throw new Error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async ensureBrowser(): Promise<Page> {
    if (this.page && this.browser?.isConnected()) {
      return this.page;
    }

    // Reopen browser with saved cookies
    const puppeteer = await import("puppeteer");
    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs");

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-chat-"));
    const executablePath = findChromePath();

    this.browser = await puppeteer.launch({
      headless: false,
      executablePath,
      userDataDir,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
    });

    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1664, height: 800 });

    // Set cookies
    const session = this.loadSession();
    if (session && session.length > 0) {
      await this.page.setCookie(...session);
    }

    // Navigate to chat page
    await this.page.goto("https://www.doubao.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2000));

    return this.page;
  }

  async chat(messages: ChatMessage[], abortSignal?: AbortSignal): Promise<ChatResponse> {
    const userMessages = messages.filter((m) => m.role !== "system");
    const lastUserMessage = userMessages[userMessages.length - 1]?.content || "";

    info(`[Doubao] Chat: ${lastUserMessage.slice(0, 100)}`);

    try {
      const page = await this.ensureBrowser();

      // Find the input box and type the message
      const inputSelector = 'textarea, [contenteditable="true"], [class*="input"], [class*="editor"]';
      await page.waitForSelector(inputSelector, { timeout: 10000 });

      // Clear existing text and type new message
      const input = await page.$(inputSelector);
      if (!input) throw new Error("Cannot find input box");

      await input.click({ clickCount: 3 });
      await input.type(lastUserMessage, { delay: 10 });

      // Find and click send button
      const sendSelector = 'button[class*="send"], button[class*="submit"], [class*="send-btn"], [class*="submit-btn"]';
      await page.waitForSelector(sendSelector, { timeout: 5000 });
      const sendBtn = await page.$(sendSelector);
      if (sendBtn) {
        await sendBtn.click();
      } else {
        // Try pressing Enter
        await page.keyboard.press("Enter");
      }

      // Wait for response to appear
      info("[Doubao] Waiting for response...");
      await new Promise((r) => setTimeout(r, 3000));

      // Wait for response to complete (no new text for 2 seconds)
      let lastText = "";
      let stableCount = 0;
      const maxWait = 60000;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWait) {
        const currentText = await page.evaluate(() => {
          const msgs = document.querySelectorAll('[class*="message"], [class*="answer"], [class*="response"]');
          const lastMsg = msgs[msgs.length - 1];
          return lastMsg?.textContent || "";
        });

        if (currentText === lastText) {
          stableCount++;
          if (stableCount >= 4) break; // 2 seconds stable
        } else {
          stableCount = 0;
          lastText = currentText;
        }

        if (abortSignal?.aborted) {
          throw new Error("Request cancelled");
        }

        await new Promise((r) => setTimeout(r, 500));
      }

      // Extract the response
      const response = await page.evaluate(() => {
        const msgs = document.querySelectorAll('[class*="message"], [class*="answer"], [class*="response"]');
        const lastMsg = msgs[msgs.length - 1];
        return lastMsg?.textContent || "(empty response)";
      });

      info(`[Doubao] Response: ${response.length} chars`);
      return { content: response };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "Request cancelled") throw err;
      error(`[Doubao] Chat error: ${message}`);
      throw new Error(`Doubao chat failed: ${message}`);
    }
  }
}

export { DoubaoProvider };
