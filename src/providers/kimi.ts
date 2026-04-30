import * as https from "https";
import { Cookie } from "puppeteer";
import { BaseProvider, ChatMessage, ChatResponse, ProviderInfo } from "./base";
import { info } from "../utils/logger";

const KIMI_API = "https://kimi.moonshot.cn/api/chat";

class KimiProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: "kimi",
    name: "Kimi (月之暗面)",
    loginUrl: "https://kimi.moonshot.cn/",
    sessionFile: ".kimi_session.json",
    apiUrl: KIMI_API,
  };

  protected isLoginComplete(): string {
    return `() => {
      const url = window.location.href;
      if (url === "https://kimi.moonshot.cn/" || url.startsWith("https://kimi.moonshot.cn/chat/")) {
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
             (c.domain.includes("moonshot") && (c.httpOnly || c.name.toLowerCase().includes("token")))
    );
  }

  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Cookie: this.cookieString,
      Origin: "https://kimi.moonshot.cn",
      Referer: "https://kimi.moonshot.cn/",
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
    info("[Kimi] Starting login...");
    const cookies = await super.login();
    this.cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    info(`[Kimi] Login successful, ${cookies.length} cookies`);
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
      response = await this.apiFetch(KIMI_API, body);
    } catch (err) {
      throw new Error(
        `Kimi API failed: ${err instanceof Error ? err.message : String(err)}. ` +
        "Try removing .kimi_session.json and logging in again."
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

export { KimiProvider };
