import * as https from "https";
import * as fs from "fs";
import { Cookie } from "puppeteer";
import { BaseProvider, ChatMessage, ChatResponse, ProviderInfo } from "./base";
import chalk from "chalk";
import { info, error } from "../utils/logger";

class DoubaoProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: "doubao",
    name: "Doubao (豆包)",
    loginUrl: "https://www.doubao.com/",
    sessionFile: ".doubao_session.json",
    apiUrl: "https://www.doubao.com/chat/completion",
  };

  private capturedApiUrl: string | null = null;
  private capturedApiHeaders: Record<string, string> | null = null;

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
             c.name === "passport_csrf_token" ||
             (c.domain.includes("doubao") || c.domain.includes("byte"))
    );
  }

  override async login(): Promise<Cookie[]> {
    const existing = this.loadSession();
    if (existing && existing.length > 0) {
      info(`[Doubao] Using cached session, ${existing.length} cookies`);
      this.cookieString = existing.map((c) => `${c.name}=${c.value}`).join("; ");

      // Try to load captured API info from session file
      try {
        const sessionData = JSON.parse(fs.readFileSync(this.getSessionFilePath(), "utf-8"));
        if (sessionData.apiUrl) {
          this.capturedApiUrl = sessionData.apiUrl;
          this.capturedApiHeaders = sessionData.apiHeaders || null;
          info(`[Doubao] Loaded captured API: ${sessionData.apiUrl}`);
        }
      } catch {}

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
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
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

      // Navigate to chat page and intercept the real API request
      info("[Doubao] Navigating to chat page for API capture");
      console.log(chalk.cyan("\nLogin successful! Navigating to chat page..."));
      await page.goto("https://www.doubao.com/chat/", { waitUntil: "domcontentloaded", timeout: 30000 });
      await new Promise((r) => setTimeout(r, 3000));

      console.log(chalk.cyan("Please send a test message in the browser (e.g. 'hello')."));
      console.log(chalk.gray("Waiting for you to send a message... (up to 5 minutes)\n"));

      let capturedApi: { url: string; headers: Record<string, string>; body: string } | null = null;

      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const url = req.url();
        const method = req.method();
        const postData = req.postData() || "";
        // Only capture POST requests to chat/completion endpoints with JSON body
        if (method === "POST" && postData.length > 10 &&
            (url.includes("chat/completion") || url.includes("chat/completions"))) {
          const headers = req.headers();
          info(`[Doubao] CAPTURED API: ${url}`);
          info(`[Doubao] CAPTURED method: ${method}`);
          info(`[Doubao] CAPTURED headers: ${JSON.stringify(headers)}`);
          info(`[Doubao] CAPTURED body: ${postData.slice(0, 1000)}`);
          capturedApi = { url, headers: headers as Record<string, string>, body: postData };
        }
        req.continue();
      });

      // Wait until API request is captured (up to 5 minutes)
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (capturedApi) { clearInterval(check); resolve(); }
        }, 500);
        setTimeout(() => { clearInterval(check); resolve(); }, 300000);
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const capturedResult = capturedApi as any;
      if (capturedResult) {
        info(`[Doubao] Successfully captured API request!`);
        const apiUrl: string = capturedResult.url;
        const apiHeaders: Record<string, string> = capturedResult.headers;
        const sessionData = {
          cookies: authCookies,
          savedAt: new Date().toISOString(),
          apiUrl,
          apiHeaders,
        };
        fs.writeFileSync(this.getSessionFilePath(), JSON.stringify(sessionData, null, 2));
        info(`[Doubao] Saved API info: ${apiUrl}`);
        console.log(chalk.green("\nAPI request captured and saved! Closing browser...\n"));
      } else {
        info(`[Doubao] No API request captured (timeout), saving cookies only`);
        this.saveSession(authCookies);
        console.log(chalk.yellow("\nTimeout: no API request captured. Saving cookies only.\n"));
      }

      await browser.close();

      if (authCookies.length > 0) {
        if (!capturedResult) this.saveSession(authCookies);
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

    info(`[Doubao] Chat: ${lastUserMessage.slice(0, 100)}`);

    const body = JSON.stringify({
      client_meta: {
        local_conversation_id: `local_${Date.now()}`,
        conversation_id: "",
        bot_id: "",
        last_section_id: "",
        last_message_index: null,
      },
      messages: [{
        local_message_id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        content_block: [{
          block_type: 10000,
          content: {
            text_block: { text: lastUserMessage, icon_url: "", icon_url_dark: "", summary: "" },
            pc_event_block: "",
          },
          block_id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          parent_id: "",
          meta_info: [],
          append_fields: [],
        }],
        message_status: 0,
      }],
      option: {
        send_message_scene: "",
        create_time_ms: Date.now(),
        collect_id: "",
        is_audio: false,
        answer_with_suggest: false,
        tts_switch: false,
        need_deep_think: 0,
        click_clear_context: false,
        from_suggest: false,
        is_regen: false,
        is_replace: false,
        disable_sse_cache: false,
        select_text_action: "",
        resend_for_regen: false,
        scene_type: 0,
        unique_key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        start_seq: 0,
        need_create_conversation: true,
        conversation_init_option: { need_ack_conversation: true },
        regen_query_id: [],
        edit_query_id: [],
        regen_instruction: "",
        no_replace_for_regen: false,
        message_from: 0,
        shared_app_name: "",
        shared_app_id: "",
        sse_recv_event_options: { support_chunk_delta: true },
        is_ai_playground: false,
        recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(Date.now() / 1000), append_sse_event_scene: 0 },
      },
      ext: {
        use_deep_think: "0",
        fp: this.cookieString.match(/s_v_web_id=([^;]+)/)?.[1] || "",
        conversation_init_option: '{"need_ack_conversation":true}',
        commerce_credit_config_enable: "0",
        sub_conv_firstmet_type: "1",
      },
    });

    info(`[Doubao] Request body length: ${body.length}`);

    let apiUrl: string;
    let headers: Record<string, string>;

    if (this.capturedApiUrl) {
      // Use captured API URL and headers from login interception
      apiUrl = this.capturedApiUrl;
      headers = this.capturedApiHeaders || this.buildHeaders();
      info(`[Doubao] Using captured API: ${apiUrl.slice(0, 150)}`);
    } else {
      // Fallback: build URL with query parameters
      const fp = this.cookieString.match(/s_v_web_id=([^;]+)/)?.[1] || "";
      const msToken = this.cookieString.match(/msToken=([^;]+)/)?.[1] || "";
      const deviceId = String(Math.floor(Math.random() * 9000000000000000000) + 1000000000000000000);
      const params = new URLSearchParams({
        aid: "1128",
        device_id: deviceId,
        device_platform: "web",
        fp,
        msToken,
        a_bogus: "",
      });
      apiUrl = `${this.info.apiUrl}?${params.toString()}`;
      headers = this.buildHeaders();
      info(`[Doubao] Using fallback API: ${apiUrl.slice(0, 150)}`);
    }

    let content = "";
    try {
      content = await this.sseFetch(apiUrl, body, abortSignal, headers);
      info(`[Doubao] Chat response: ${content.length} chars`);
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

  private sseFetch(url: string, body: string, abortSignal?: AbortSignal, headers?: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      if (abortSignal?.aborted) {
        return reject(new Error("Request cancelled"));
      }

      const parsed = new URL(url);
      const req = https.request(parsed, {
        method: "POST",
        headers: headers || this.buildHeaders(),
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
        let rawChunks: string[] = [];

        res.on("data", (chunk: Buffer) => {
          const raw = chunk.toString();
          rawChunks.push(raw);
          info(`[Doubao SSE] Raw chunk (${raw.length} bytes): ${raw.slice(0, 500)}`);
          buffer += raw;
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Parse SSE events
            if (trimmed.startsWith("event:")) {
              info(`[Doubao SSE] Event: ${trimmed.slice(6).trim()}`);
              continue;
            }

            if (!trimmed.startsWith("data:")) continue;

            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr || jsonStr === "[DONE]") continue;

            try {
              const event = JSON.parse(jsonStr) as Record<string, unknown>;

              // Log STREAM_ERROR details
              if (event.error_code !== undefined) {
                error(`[Doubao SSE] STREAM_ERROR: code=${event.error_code}, msg=${event.error_msg}, extra=${JSON.stringify(event.extra)}`);
              }

              info(`[Doubao SSE] Event data: ${jsonStr.slice(0, 300)}`);

              // Try different response formats
              const choices = event.choices as Array<Record<string, unknown>> | undefined;
              if (choices && choices.length > 0) {
                const delta = choices[0].delta as Record<string, unknown> | undefined;
                const content = delta?.content as string | undefined;
                if (content) accumulated += content;
              }

              // Also try direct text field
              const text = event.text as string | undefined;
              if (text) accumulated += text;

              // Try message content
              const message = event.message as Record<string, unknown> | undefined;
              if (message?.content) accumulated += String(message.content);

            } catch (e) {
              info(`[Doubao SSE] Parse error: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        });

        res.on("end", () => {
          const totalRaw = rawChunks.join("");
          info(`[Doubao SSE] Stream ended, raw total: ${totalRaw.length} bytes, accumulated: ${accumulated.length} chars`);
          if (totalRaw.length > 0 && accumulated.length === 0) {
            info(`[Doubao SSE] Raw content (first 1000): ${totalRaw.slice(0, 1000)}`);
          }
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
