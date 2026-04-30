import OpenAI from "openai";
import { Tool } from "../tools/types";

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
    messages: OpenAI.ChatCompletionMessageParam[],
    tools: Tool[]
  ): Promise<OpenAI.ChatCompletion> {
    return this.client.chat.completions.create({
      model: this.model,
      messages,
      tools: this.toOpenAITools(tools),
      tool_choice: "auto",
      stream: false,
      max_tokens: 4096,
    });
  }
}
