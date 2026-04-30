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

  override async login(): Promise<Cookie[]> {
    info("[Doubao] Starting login...");
    const cookies = await super.login();
    this.cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    info(`[Doubao] Login successful, ${cookies.length} cookies`);
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
