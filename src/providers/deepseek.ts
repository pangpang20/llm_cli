import * as https from "https";
import { Cookie } from "puppeteer";
import { BaseProvider, ChatMessage, ChatResponse, ProviderInfo } from "./base";
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
    info("[DeepSeek] Starting login...");
    const cookies = await super.login();
    this.cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    info(`[DeepSeek] Login successful, ${cookies.length} cookies`);
    return cookies;
  }

  async chat(messages: ChatMessage[]): Promise<ChatResponse> {
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
