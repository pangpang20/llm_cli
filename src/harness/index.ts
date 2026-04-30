import { Memory } from "./memory";
import { SelfImprove } from "./self_improve";
import { Hooks } from "./hooks";

export class Harness {
  readonly memory: Memory;
  readonly selfImprove: SelfImprove;
  readonly hooks: Hooks;

  constructor() {
    this.memory = new Memory();
    this.selfImprove = new SelfImprove(this.memory);
    this.hooks = new Hooks();
  }

  /**
   * Get the full system prompt with learned context injected
   */
  buildSystemPrompt(basePrompt: string): string {
    const learned = this.selfImprove.buildLearnedContext();
    if (!learned) return basePrompt;
    return `${basePrompt}\n\n--- Learned from past interactions ---\n${learned}`;
  }

  async onStart(): Promise<void> {
    await this.hooks.executeHooks("on_start");
  }

  async onExit(): Promise<void> {
    await this.hooks.executeHooks("on_exit");
  }

  async onError(error: string): Promise<void> {
    this.memory.add({
      type: "failure",
      category: "runtime",
      content: error.slice(0, 500),
    });
    await this.hooks.executeHooks("on_error");
  }
}
