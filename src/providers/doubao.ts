import * as https from "https";
import { Cookie } from "puppeteer";
import { BaseProvider, ChatMessage, ChatResponse, ProviderInfo } from "./base";
import chalk from "chalk";
import { info } from "../utils/logger";

const DOUBAO_API = "https://www.doubao.com/api/chat/v2";

class DoubaoProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: "doubao",
    name: "Doubao (豆包)",
    loginUrl: "https://www.doubao.com/",
    sessionFile: ".doubao_session.json",
    apiUrl: DOUBAO_API,
  };

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
      (c) => c.name === "token" ||
             c.name === "session_id" ||
             c.name === "sid" ||
             c.name.startsWith("passport_") ||
             c.name === "refresh_token" ||
             (c.domain.includes("doubao") && (c.httpOnly || c.name.toLowerCase().includes("token")))
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
      info("[Doubao] Browser launched, new page created");

      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
      });

      info(`[Doubao] Navigating to ${this.info.loginUrl}`);
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(this.info.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      info("[Doubao] Page loaded, waiting for user login");
      console.log(chalk.green(`Opened ${this.info.loginUrl} in your browser.`));
      console.log(chalk.gray("Please complete login in the browser window.\n"));

      const authCookieNames = ["token", "session_id", "sid", "refresh_token", "passport_"];
      let done = false;

      const pollInterval = setInterval(async () => {
        if (done) return;
        const cookies = await page.cookies();
        const hasAuthCookies = cookies.some((c) => authCookieNames.some(n => c.name.startsWith(n) || c.name === n));
        info(`[Doubao] Polling: ${cookies.length} cookies, auth found=${hasAuthCookies}`);
        if (hasAuthCookies) {
          clearInterval(pollInterval);
          done = true;
          info("[Doubao] Login detected via auth cookies! Refreshing page");
          await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
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

      const allCookies = await page.cookies();
      info(`[Doubao] Total cookies found: ${allCookies.length}`);
      const authCookies = this.extractAuthCookies(allCookies);
      info(`[Doubao] Auth cookies found: ${authCookies.length}, names: ${authCookies.map(c => c.name).join(", ")}`);

      await browser.close();
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}

      if (authCookies.length > 0) {
        this.saveSession(authCookies);
        info(`[Doubao] Login successful! Session saved`);
        console.log(chalk.green("Login successful!\n"));
        return authCookies;
      } else {
        throw new Error("Login completed but no auth cookies were found. Please try again.");
      }
    } catch (err) {
      info(`[Doubao] Login error: ${err instanceof Error ? err.message : String(err)}`);
      try { await browser.close(); } catch {}
      throw new Error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Cookie: this.cookieString,
      Origin: "https://www.doubao.com",
      Referer: "https://www.doubao.com/",
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
          console.log(chalk.gray(`  [Doubao API] Status: ${res.statusCode}`));
          console.log(chalk.gray(`  [Doubao API] Response length: ${data.length}`));
          if (data.length === 0) {
            console.log(chalk.red(`  [Doubao API] Empty response`));
            reject(new Error("Empty response from API"));
            return;
          }
          console.log(chalk.gray(`  [Doubao API] Response: ${data.slice(0, 500)}`));
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            console.log(chalk.red(`  [Doubao API] Failed to parse JSON`));
            reject(new Error(`Failed to parse: ${data.slice(0, 500)}`));
          }
        });
      });
      req.on("error", (err) => {
        console.log(chalk.red(`  [Doubao API] Request error: ${err.message}`));
        reject(err);
      });
      console.log(chalk.gray(`  [Doubao API] POST ${url}`));
      console.log(chalk.gray(`  [Doubao API] Body: ${body.slice(0, 200)}`));
      console.log(chalk.gray(`  [Doubao API] Cookies: ${this.cookieString.slice(0, 100)}...`));
      req.write(body);
      req.end();
    });
  }

  async chat(messages: ChatMessage[], _signal?: AbortSignal): Promise<ChatResponse> {
    const conversationText = messages
      .filter((m) => m.role !== "system")
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n\n");

    const body = JSON.stringify({ prompt: conversationText, sessionId: this.sessionId });

    let response: Record<string, unknown>;
    try {
      response = await this.apiFetch(DOUBAO_API, body);
      console.log(chalk.gray(`  [Doubao API] Parsed response: ${JSON.stringify(response).slice(0, 500)}`));
    } catch (err) {
      console.log(chalk.red(`  [Doubao API] Error: ${err instanceof Error ? err.message : String(err)}`));
      console.log(chalk.red(`  [Doubao API] Session file: ${this.getSessionFilePath()}`));
      throw new Error(
        `Doubao API failed: ${err instanceof Error ? err.message : String(err)}. ` +
        "Try removing .doubao_session.json and logging in again."
      );
    }

    if (typeof response.sessionId === "string") this.sessionId = response.sessionId;

    const content = typeof response.content === "string" ? response.content
      : typeof response.message === "string" ? response.message
      : typeof response.text === "string" ? response.text
      : typeof response.data === "object" && response.data !== null
        ? typeof (response.data as Record<string, unknown>).content === "string"
          ? (response.data as Record<string, unknown>).content as string
          : JSON.stringify(response)
      : JSON.stringify(response);

    return { content };
  }
}

export { DoubaoProvider };
