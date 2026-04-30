import * as fs from "fs";
import * as path from "path";

const HOOKS_FILE = path.join(process.cwd(), ".llm_hooks.json");

export interface Hook {
  name: string;
  command: string;
  enabled: boolean;
}

export interface HooksConfig {
  on_start: Hook[];
  on_error: Hook[];
  on_exit: Hook[];
}

const DEFAULT_HOOKS: HooksConfig = {
  on_start: [],
  on_error: [],
  on_exit: [],
};

// Only allow a safe subset of commands - no shell interpretation
const ALLOWED_COMMANDS = ["echo", "ls", "cat", "date", "pwd", "whoami", "uptime", "hostname", "df", "free"];

function isCommandSafe(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  // Block shell metacharacters that could enable injection
  if (/[;|&$`><(){}!\\]/.test(trimmed)) return false;
  // Check if the base command is in the allowed list
  const baseCmd = trimmed.split(/\s/)[0];
  return ALLOWED_COMMANDS.includes(baseCmd);
}

export class Hooks {
  private config: HooksConfig;

  constructor() {
    this.config = this.load();
  }

  private load(): HooksConfig {
    if (!fs.existsSync(HOOKS_FILE)) return { ...DEFAULT_HOOKS };
    try {
      const parsed = JSON.parse(fs.readFileSync(HOOKS_FILE, "utf-8")) as HooksConfig;
      // Validate structure and filter unsafe commands
      for (const event of ["on_start", "on_error", "on_exit"] as const) {
        parsed[event] = (parsed[event] || []).filter((h) => isCommandSafe(h.command));
      }
      return parsed;
    } catch {
      return { ...DEFAULT_HOOKS };
    }
  }

  save(): void {
    fs.writeFileSync(HOOKS_FILE, JSON.stringify(this.config, null, 2));
  }

  addHook(event: keyof HooksConfig, name: string, command: string): void {
    if (!isCommandSafe(command)) {
      throw new Error(`Command blocked for safety: ${command}`);
    }
    this.config[event].push({ name, command, enabled: true });
    this.save();
  }

  removeHook(event: keyof HooksConfig, name: string): void {
    this.config[event] = this.config[event].filter((h) => h.name !== name);
    this.save();
  }

  async executeHooks(event: keyof HooksConfig): Promise<void> {
    const hooks = this.config[event].filter((h) => h.enabled);
    for (const hook of hooks) {
      try {
        const { execFile } = require("child_process");
        const parts = hook.command.split(/\s+/);
        await new Promise<void>((resolve, reject) => {
          execFile(parts[0], parts.slice(1), { timeout: 10000 }, (err: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        });
      } catch {
        // Don't let hook failure break the app
      }
    }
  }

  getConfig(): HooksConfig {
    return this.config;
  }
}
