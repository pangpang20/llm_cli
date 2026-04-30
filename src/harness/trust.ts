import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";

const TRUST_DIR = path.join(os.homedir(), ".llm_cli");
const TRUST_FILE = path.join(TRUST_DIR, "trusted_dirs.json");

export interface TrustStore {
  dirs: string[];
}

function loadStore(): TrustStore {
  if (!fs.existsSync(TRUST_FILE)) return { dirs: [] };
  try {
    return JSON.parse(fs.readFileSync(TRUST_FILE, "utf-8"));
  } catch {
    return { dirs: [] };
  }
}

function saveStore(store: TrustStore): void {
  fs.mkdirSync(TRUST_DIR, { recursive: true });
  fs.writeFileSync(TRUST_FILE, JSON.stringify(store, null, 2));
}

export function isTrusted(dir: string): boolean {
  const store = loadStore();
  const resolved = path.resolve(dir);
  // Exact match or subdirectory of a trusted dir
  if (store.dirs.includes(resolved)) return true;
  return store.dirs.some((d) => resolved.startsWith(d + path.sep));
}

function addTrusted(dir: string): void {
  const store = loadStore();
  const resolved = path.resolve(dir);
  if (!store.dirs.includes(resolved)) {
    store.dirs.push(resolved);
    saveStore(store);
  }
}

function prompt(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(query, (answer) => { rl.close(); resolve(answer); }));
}

export async function checkTrust(): Promise<void> {
  const cwd = process.cwd();
  if (isTrusted(cwd)) return;

  console.log(
    `\n` +
    `\x1b[33m⚠ Security Warning\x1b[0m\n` +
    `\x1b[33m─────────────────────────────────────────────────────\x1b[0m\n` +
    `This is the first time running in this directory:\n` +
    `  \x1b[36m${cwd}\x1b[0m\n\n` +
    `The AI agent in this tool can read files, execute commands, and\n` +
    `modify files in the current directory and its subdirectories.\n\n` +
    `Make sure you trust the contents of this directory before proceeding.\n` +
    `\x1b[33m─────────────────────────────────────────────────────\x1b[0m\n`
  );

  const answer = await prompt("Do you trust the files in this directory? (y/N) ");
  if (answer.trim().toLowerCase() !== "y") {
    console.log("\x1b[31mAborted. Directory not trusted.\x1b[0m\n");
    process.exit(0);
  }

  addTrusted(cwd);
  console.log("\x1b[32m✓ Directory trusted. You won't be asked again.\x1b[0m\n");
}
