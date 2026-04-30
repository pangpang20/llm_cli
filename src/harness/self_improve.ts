import * as fs from "fs";
import * as path from "path";
import { Memory } from "./memory";

const RULES_FILE = path.join(process.cwd(), ".llm_rules.json");

export interface Rule {
  id: string;
  description: string;
  triggeredBy: string;
  createdAt: string;
  hits: number;
}

export interface SelfImproveConfig {
  rules: Rule[];
  autoLearn: boolean;
  maxRules: number;
}

const DEFAULT_CONFIG: SelfImproveConfig = {
  rules: [],
  autoLearn: true,
  maxRules: 50,
};

export class SelfImprove {
  private config: SelfImproveConfig;
  private memory: Memory;

  constructor(memory: Memory) {
    this.memory = memory;
    this.config = this.load();
  }

  private load(): SelfImproveConfig {
    if (!fs.existsSync(RULES_FILE)) return { ...DEFAULT_CONFIG };
    try {
      return JSON.parse(fs.readFileSync(RULES_FILE, "utf-8"));
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  save(): void {
    fs.writeFileSync(RULES_FILE, JSON.stringify(this.config, null, 2));
  }

  /**
   * Record a tool call result for learning
   */
  recordToolResult(toolName: string, args: Record<string, unknown>, result: string, success: boolean): void {
    if (!this.config.autoLearn) return;

    if (success) {
      this.memory.add({
        type: "success",
        category: `tool:${toolName}`,
        content: `${toolName}(${JSON.stringify(args)}) succeeded`,
        context: result.slice(0, 200),
      });
    } else {
      this.memory.add({
        type: "failure",
        category: `tool:${toolName}`,
        content: `${toolName}(${JSON.stringify(args)}) failed: ${result.slice(0, 200)}`,
      });
      this.autoAddRule(toolName, result);
    }
  }

  /**
   * Automatically create a rule from a failure pattern
   */
  private autoAddRule(toolName: string, error: string): void {
    const ruleText = `When ${toolName} fails with "${error.slice(0, 100)}", try alternative approach`;
    const exists = this.config.rules.some((r) => r.description.includes(ruleText.slice(0, 50)));
    if (exists) return;

    this.config.rules.push({
      id: `rule-${Date.now()}`,
      description: ruleText,
      triggeredBy: toolName,
      createdAt: new Date().toISOString(),
      hits: 1,
    });

    // Enforce max rules
    if (this.config.rules.length > this.config.maxRules) {
      this.config.rules = this.config.rules
        .sort((a, b) => b.hits - a.hits)
        .slice(0, this.config.maxRules);
    }

    this.save();
  }

  /**
   * Build context string for system prompt injection
   * Includes learned rules and top patterns
   */
  buildLearnedContext(): string {
    const parts: string[] = [];

    // Active rules
    if (this.config.rules.length > 0) {
      parts.push("Learned rules from experience:");
      this.config.rules
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 10)
        .forEach((r) => parts.push(`- ${r.description}`));
    }

    // Top failures to avoid
    const failures = this.memory.getTopFailures(3);
    if (failures.length > 0) {
      parts.push("Past failures to avoid:");
      failures.forEach((f) => parts.push(`- ${f.content} (occurred ${f.count} times)`));
    }

    // User preferences
    const prefs = this.memory.getPreferences();
    if (prefs.length > 0) {
      parts.push("User preferences:");
      prefs.forEach((p) => parts.push(`- ${p.content}`));
    }

    return parts.join("\n");
  }

  addRule(description: string, triggeredBy: string): void {
    this.config.rules.push({
      id: `rule-${Date.now()}`,
      description,
      triggeredBy,
      createdAt: new Date().toISOString(),
      hits: 1,
    });
    this.save();
  }

  clearRules(): void {
    this.config.rules = [];
    this.save();
  }

  getConfig(): SelfImproveConfig {
    return this.config;
  }
}
