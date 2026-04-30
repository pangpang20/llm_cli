import OpenAI from "openai";

export class ChatManager {
  private messages: OpenAI.ChatCompletionMessageParam[] = [];
  private readonly systemPrompt: string;

  constructor(systemPrompt: string) {
    this.systemPrompt = systemPrompt;
    this.reset();
  }

  reset() {
    this.messages = [
      { role: "system", content: this.systemPrompt },
    ];
  }

  addUserMessage(content: string) {
    this.messages.push({ role: "user", content });
  }

  addAssistantMessage(content: string, toolCalls?: OpenAI.ChatCompletionMessageToolCall[]) {
    const msg: OpenAI.ChatCompletionAssistantMessageParam = { role: "assistant", content };
    if (toolCalls) msg.tool_calls = toolCalls;
    this.messages.push(msg);
  }

  addToolResult(toolCallId: string, content: string, _toolName: string) {
    this.messages.push({
      role: "tool",
      content,
      tool_call_id: toolCallId,
    } as OpenAI.ChatCompletionToolMessageParam);
  }

  getHistory(): OpenAI.ChatCompletionMessageParam[] {
    return [...this.messages];
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }
}
