import * as https from "https";
import { Cookie } from "puppeteer";
import { BaseProvider, ChatMessage, ChatResponse, ProviderInfo } from "./base";
import chalk from "chalk";
import { info, error } from "../utils/logger";

const DOUBAO_API = "https://www.doubao.com/chat/completion";

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
      (c) => c.name === "sessionid" ||
             c.name === "sid_tt" ||
             c.name === "passport_csrf_token" ||
             c.name === "passport_csrf_token_default" ||
             c.name === "uid_tt" ||
             c.name === "sid_guard" ||
             c.name === "ttwid" ||
             c.name.startsWith("passport_") ||
             (c.domain.includes("doubao") || c.domain.includes("byte") || c.domain.includes("tiktok"))
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
      await page.setViewport({ width: 1664, height: 800 });
      await page.goto(this.info.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      info("[Doubao] Page loaded, waiting for user login");
      console.log(chalk.green(`Opened ${this.info.loginUrl} in your browser.`));
      console.log(chalk.gray("Please complete login in the browser window.\n"));

      // Only detect cookies that exist AFTER login (not CSRF tokens which exist before login)
      const authCookieNames = ["sessionid", "sid_tt", "uid_tt"];
      let done = false;

      const pollInterval = setInterval(async () => {
        if (done) return;
        const cookies = await page.cookies();
        const hasAuthCookies = cookies.some((c) => authCookieNames.includes(c.name));
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
    // Extract CSRF token from cookies
    const csrfMatch = this.cookieString.match(/passport_csrf_token=([^;]+)/);
    const csrfToken = csrfMatch ? csrfMatch[1] : "";

    return {
      "Content-Type": "application/json",
      Cookie: this.cookieString,
      Origin: "https://www.doubao.com",
      Referer: "https://www.doubao.com/",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "X-CSRFToken": csrfToken,
      "x-csrftoken": csrfToken,
    };
  }

  async chat(messages: ChatMessage[], abortSignal?: AbortSignal): Promise<ChatResponse> {
    const userMessages = messages.filter((m) => m.role !== "system");
    const lastUserMessage = userMessages[userMessages.length - 1]?.content || "";

    const body = JSON.stringify({
      messages: [{ role: "user", content: lastUserMessage }],
      stream: true,
    });

    info(`[Doubao] Chat request: ${DOUBAO_API}`);
    info(`[Doubao] Request body: ${body.slice(0, 500)}`);

    let content = "";
    try {
      content = await this.sseFetch(DOUBAO_API, body, abortSignal);
      info(`[Doubao] Chat response: ${content.length} chars, content: ${content.slice(0, 200)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "Request cancelled") throw err;
      error(`[Doubao] Chat error: ${message}`);
      throw new Error(
        `Doubao API failed: ${message}. ` +
        "Try removing .doubao_session.json and logging in again."
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
        info(`[Doubao SSE] Response status: ${res.statusCode}`);
        info(`[Doubao SSE] Response headers: ${JSON.stringify(res.headers)}`);

        if (res.statusCode !== 200) {
          let errData = "";
          res.on("data", (chunk) => (errData += chunk));
          res.on("end", () => {
            error(`[Doubao API] HTTP ${res.statusCode}: ${errData}`);
            reject(new Error(`HTTP ${res.statusCode}: ${errData}`));
          });
          return;
        }

        let accumulated = "";
        let buffer = "";

        res.on("data", (chunk: Buffer) => {
          const chunkStr = chunk.toString();
          info(`[Doubao SSE] Received chunk: ${chunkStr.slice(0, 300)}`);
          buffer += chunkStr;
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            info(`[Doubao SSE] Processing line: ${trimmed.slice(0, 200)}`);

            if (!trimmed.startsWith("data:")) continue;

            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr || jsonStr === "[DONE]") continue;

            try {
              const event = JSON.parse(jsonStr) as Record<string, unknown>;
              info(`[Doubao SSE] Parsed event: ${JSON.stringify(event).slice(0, 300)}`);

              // Try different response formats
              const choices = event.choices as Array<Record<string, unknown>> | undefined;
              if (choices && choices.length > 0) {
                const delta = choices[0].delta as Record<string, unknown> | undefined;
                const content = delta?.content as string | undefined;
                if (content) {
                  accumulated += content;
                  info(`[Doubao SSE] Accumulated content: ${accumulated.length} chars`);
                }
              }

              // Also try direct text field
              const text = event.text as string | undefined;
              if (text) {
                accumulated += text;
                info(`[Doubao SSE] Accumulated text: ${accumulated.length} chars`);
              }
            } catch (e) {
              info(`[Doubao SSE] Parse error: ${e instanceof Error ? e.message : String(e)}`);
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

export { DoubaoProvider };
