import * as fs from "fs";
import * as path from "path";

const MEMORY_FILE = path.join(process.cwd(), ".llm_memory.json");

export interface MemoryEntry {
  id: string;
  type: "success" | "failure" | "preference" | "fact";
  category: string;
  content: string;
  context?: string;
  createdAt: string;
  count: number;
}

export interface MemoryStore {
  entries: MemoryEntry[];
}

export class Memory {
  private store: MemoryStore;

  constructor() {
    this.store = this.load();
  }

  private load(): MemoryStore {
    if (!fs.existsSync(MEMORY_FILE)) {
      return { entries: [] };
    }
    try {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
    } catch {
      return { entries: [] };
    }
  }

  save(): void {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.store, null, 2));
  }

  add(entry: Omit<MemoryEntry, "id" | "createdAt" | "count">): void {
    const existing = this.store.entries.find(
      (e) => e.type === entry.type && e.category === entry.category && e.content === entry.content
    );
    if (existing) {
      existing.count++;
      existing.createdAt = new Date().toISOString();
    } else {
      this.store.entries.push({
        ...entry,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
        count: 1,
      });
    }
    // Keep max 500 entries (oldest removed)
    if (this.store.entries.length > 500) {
      this.store.entries = this.store.entries.slice(-500);
    }
    this.save();
  }

  search(query: string, type?: MemoryEntry["type"]): MemoryEntry[] {
    const lower = query.toLowerCase();
    return this.store.entries
      .filter((e) => {
        const matchesType = !type || e.type === type;
        const matchesQuery =
          e.content.toLowerCase().includes(lower) ||
          e.category.toLowerCase().includes(lower) ||
          (e.context && e.context.toLowerCase().includes(lower));
        return matchesType && matchesQuery;
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }

  getRecent(type?: MemoryEntry["type"], limit = 20): MemoryEntry[] {
    return this.store.entries
      .filter((e) => !type || e.type === type)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  getTopFailures(limit = 5): MemoryEntry[] {
    return this.store.entries
      .filter((e) => e.type === "failure")
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  getTopSuccesses(limit = 5): MemoryEntry[] {
    return this.store.entries
      .filter((e) => e.type === "success")
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  getPreferences(): MemoryEntry[] {
    return this.store.entries.filter((e) => e.type === "preference");
  }

  clear(): void {
    this.store = { entries: [] };
    this.save();
  }
}
