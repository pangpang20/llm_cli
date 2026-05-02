import { Cookie, Page, Browser } from "puppeteer";
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

  private browser: Browser | null = null;
  private page: Page | null = null;
  private botId: string = "";

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
    info(`[Doubao] Starting login flow`);
    console.log(chalk.cyan(`\n[${this.info.name}] Logging in...`));

    const hasDisplay = process.env.DISPLAY !== undefined;
    const isWindows = process.platform === "win32";

    if (!hasDisplay || isWindows) {
      info(`[Doubao] Using visible browser login mode`);
      console.log(chalk.yellow(isWindows ? "Windows detected. Opening visible browser for login." : "No display detected. Opening visible browser for login."));
    } else {
      info(`[Doubao] Using desktop mode with display`);
      console.log("Opening browser for login...");
    }

    const cookies = await this.loginWithBrowser();
    this.cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    return cookies;
  }

  private async loginWithBrowser(): Promise<Cookie[]> {
    const puppeteer = await import("puppeteer");
    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs");
    const readline = await import("readline");

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-"));

    const { findChromePath } = await import("../utils/chrome");
    const executablePath = findChromePath();
    this.browser = await puppeteer.launch({
      headless: false,
      executablePath,
      userDataDir,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
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

      const allCookies = await this.page.cookies();
      info(`[Doubao] Total cookies found: ${allCookies.length}`);
      const authCookies = this.extractAuthCookies(allCookies);
      info(`[Doubao] Auth cookies found: ${authCookies.length}, names: ${authCookies.map(c => c.name).join(", ")}`);

      if (authCookies.length === 0) {
        throw new Error("Login completed but no auth cookies were found. Please try again.");
      }

      // Navigate to chat page
      info("[Doubao] Navigating to chat page");
      console.log(chalk.cyan("\nLogin successful! Navigating to chat page..."));
      await this.page.goto("https://www.doubao.com/chat/", { waitUntil: "domcontentloaded", timeout: 30000 });
      await new Promise((r) => setTimeout(r, 3000));

      // Intercept the first chat request to extract bot_id and API URL
      console.log(chalk.cyan("Please send a test message in the browser (e.g. 'hello')."));
      console.log(chalk.gray("Waiting for you to send a message... (up to 5 minutes)\n"));

      await this.page.setRequestInterception(true);
      const apiCapturePromise = new Promise<{ url: string; headers: Record<string, string> }>((resolve) => {
        this.page!.on("request", (req) => {
          const url = req.url();
          const method = req.method();
          const postData = req.postData() || "";
          if (method === "POST" && postData.length > 10 &&
              (url.includes("chat/completion") || url.includes("chat/completions"))) {
            info(`[Doubao] CAPTURED API: ${url}`);
            try {
              const bodyObj = JSON.parse(postData);
              this.botId = bodyObj?.client_meta?.bot_id || "";
              info(`[Doubao] Extracted bot_id: ${this.botId}`);
            } catch {}
            resolve({ url, headers: req.headers() as Record<string, string> });
          }
          req.continue();
        });
        // Timeout after 5 minutes
        setTimeout(() => resolve({ url: "", headers: {} }), 300000);
      });

      const captured = await apiCapturePromise;

      if (captured.url) {
        // Save session with cookies and API info
        const sessionData = {
          cookies: authCookies,
          savedAt: new Date().toISOString(),
          apiUrl: captured.url,
          botId: this.botId,
        };
        fs.writeFileSync(this.getSessionFilePath(), JSON.stringify(sessionData, null, 2));
        info(`[Doubao] Saved session with API info`);
        console.log(chalk.green("\nAPI captured! Browser will stay open (minimized) for chat.\n"));
      } else {
        this.saveSession(authCookies);
        console.log(chalk.yellow("\nTimeout: no API captured. Saving cookies only.\n"));
      }

      // Disable request interception - no longer needed
      await this.page.setRequestInterception(false);

      // Minimize browser window so user doesn't notice it
      try {
        const session = await this.page.target().createCDPSession();
        const { windowId } = await session.send("Browser.getWindowForTarget") as { windowId: number };
        await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
        info("[Doubao] Browser window minimized");
      } catch (e) {
        info(`[Doubao] Could not minimize browser: ${e instanceof Error ? e.message : String(e)}`);
      }

      return authCookies;
    } catch (err) {
      info(`[Doubao] Login error: ${err instanceof Error ? err.message : String(err)}`);
      try { await this.browser?.close(); } catch {}
      this.browser = null;
      this.page = null;
      throw new Error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async chat(messages: ChatMessage[], abortSignal?: AbortSignal): Promise<ChatResponse> {
    if (!this.page) {
      throw new Error("Browser not available. Please login first.");
    }

    const userMessages = messages.filter((m) => m.role !== "system");
    const lastUserMessage = userMessages[userMessages.length - 1]?.content || "";

    info(`[Doubao] Chat: ${lastUserMessage.slice(0, 100)}`);

    // Use page.evaluate to make the API request from the browser context
    // This ensures msToken, a_bogus, and all anti-bot tokens are generated correctly
    const result = await this.page.evaluate(async (message: string) => {
      const url = window.location.href;
      // Build the API URL - use the same origin
      const apiUrl = "/chat/completion";

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
              text_block: { text: message, icon_url: "", icon_url_dark: "", summary: "" },
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
          fp: "",
          conversation_init_option: '{"need_ack_conversation":true}',
          commerce_credit_config_enable: "0",
          sub_conv_firstmet_type: "1",
        },
      });

      try {
        const res = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });

        if (!res.ok) {
          return { error: `HTTP ${res.status}: ${res.statusText}` };
        }

        const reader = res.body?.getReader();
        if (!reader) {
          return { error: "No response body" };
        }

        const decoder = new TextDecoder();
        let accumulated = "";
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith("event:")) continue;
            if (!trimmed.startsWith("data:")) continue;

            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr || jsonStr === "[DONE]") continue;

            try {
              const event = JSON.parse(jsonStr) as Record<string, unknown>;

              // Check for errors
              if (event.error_code !== undefined) {
                return { error: `Error ${event.error_code}: ${event.error_msg}` };
              }

              // Try different content formats
              const choices = event.choices as Array<Record<string, unknown>> | undefined;
              if (choices && choices.length > 0) {
                const delta = choices[0].delta as Record<string, unknown> | undefined;
                const content = delta?.content as string | undefined;
                if (content) accumulated += content;
              }

              const text = event.text as string | undefined;
              if (text) accumulated += text;

              const message = event.message as Record<string, unknown> | undefined;
              if (message?.content) accumulated += String(message.content);
            } catch {
              // Ignore parse errors
            }
          }
        }

        return { content: accumulated || "(empty response)" };
      } catch (err) {
        return { error: String(err) };
      }
    }, lastUserMessage);

    if (result.error) {
      error(`[Doubao] Chat error: ${result.error}`);
      throw new Error(`Doubao API failed: ${result.error}`);
    }

    const content = result.content || "(empty response)";
    info(`[Doubao] Chat response: ${content.length} chars`);
    return { content };
  }
}

export { DoubaoProvider };
