import OpenAI from "openai";
import { Tool } from "../tools/types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface ProviderConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
}

export class DashScopeProvider {
  private client: OpenAI;
  private model: string;

  constructor(config: ProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });
    this.model = config.model || "qwen-plus";
  }

  toOpenAITools(tools: Tool[]) {
    return tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  async chat(
    messages: ChatMessage[],
    tools: Tool[]
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    return this.client.chat.completions.create({
      model: this.model,
      messages: messages as any,
      tools: this.toOpenAITools(tools),
      tool_choice: "auto",
      stream: false,
      max_tokens: 4096,
    });
  }

  async *streamChat(
    messages: ChatMessage[],
    tools: Tool[]
  ): AsyncGenerator<string> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages as any,
      tools: this.toOpenAITools(tools),
      tool_choice: "auto",
      stream: true,
      max_tokens: 4096,
    });
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        yield delta.content;
      }
    }
  }
}
