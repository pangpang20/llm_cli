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

export class Hooks {
  private config: HooksConfig;

  constructor() {
    this.config = this.load();
  }

  private load(): HooksConfig {
    if (!fs.existsSync(HOOKS_FILE)) return { ...DEFAULT_HOOKS };
    try {
      return JSON.parse(fs.readFileSync(HOOKS_FILE, "utf-8"));
    } catch {
      return { ...DEFAULT_HOOKS };
    }
  }

  save(): void {
    fs.writeFileSync(HOOKS_FILE, JSON.stringify(this.config, null, 2));
  }

  addHook(event: keyof HooksConfig, name: string, command: string): void {
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
        await new Promise<void>((resolve) => {
          const { exec } = require("child_process");
          exec(hook.command, { timeout: 10000 }, () => resolve());
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
