import * as https from "https";
import { Cookie } from "puppeteer";

// Qwen web chat internal API endpoint
const CHAT_API_URL = "https://chat.qwen.ai/api/chat";

export interface QwenMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface QwenChatResponse {
  content: string;
  sessionId?: string;
}

export interface ProviderConfig {
  cookies: Cookie[];
}

export class QwenWebProvider {
  private cookieString: string;
  private sessionId: string | null = null;

  constructor(config: ProviderConfig) {
    this.cookieString = config.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Cookie: this.cookieString,
      Origin: "https://chat.qwen.ai",
      Referer: "https://chat.qwen.ai/",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };
  }

  private async fetch(url: string, options: { method: string; headers: Record<string, string>; body?: string }): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const req = https.request(
        parsedUrl,
        {
          method: options.method,
          headers: {
            ...this.buildHeaders(),
            ...options.headers,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data) as Record<string, unknown>);
            } catch {
              reject(new Error(`Failed to parse response: ${data.slice(0, 500)}`));
            }
          });
        }
      );
      req.on("error", reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  private formatConversation(messages: QwenMessage[]): string {
    return messages
      .filter((m) => m.role !== "system")
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n\n");
  }

  private extractContent(response: Record<string, unknown>): string {
    // Qwen web API response structure may vary; try known fields
    if (typeof response.content === "string") return response.content;
    if (typeof response.message === "string") return response.message;
    if (typeof response.text === "string") return response.text;
    if (typeof response.data === "object" && response.data !== null) {
      const data = response.data as Record<string, unknown>;
      if (typeof data.content === "string") return data.content;
    }
    return JSON.stringify(response);
  }

  async chat(messages: QwenMessage[]): Promise<QwenChatResponse> {
    const conversationText = this.formatConversation(messages);

    const body = JSON.stringify({
      prompt: conversationText,
      sessionId: this.sessionId,
    });

    let response: Record<string, unknown>;
    try {
      response = await this.fetch(CHAT_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch (err) {
      throw new Error(
        `Qwen web API request failed: ${err instanceof Error ? err.message : String(err)}. ` +
        "Your session may have expired. Try removing .qwen_session.json and logging in again."
      );
    }

    if (typeof response.sessionId === "string") {
      this.sessionId = response.sessionId;
    }

    return {
      content: this.extractContent(response),
      sessionId: this.sessionId ?? undefined,
    };
  }
}
