import { ChatMessage } from "./provider/dashscope";

export class ChatManager {
  private messages: ChatMessage[] = [];
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

  addAssistantMessage(content: string, toolCalls?: ChatMessage["tool_calls"]) {
    const msg: ChatMessage = { role: "assistant", content };
    if (toolCalls) msg.tool_calls = toolCalls;
    this.messages.push(msg);
  }

  addToolResult(toolCallId: string, content: string, toolName: string) {
    this.messages.push({
      role: "assistant" as any,
      content,
      tool_call_id: toolCallId,
      name: toolName,
    });
  }

  getHistory(): ChatMessage[] {
    return [...this.messages];
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }
}
