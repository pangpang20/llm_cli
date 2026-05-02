import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

export function findChromePath(): string | undefined {
  const platform = process.platform;

  if (platform === "win32") {
    const candidates = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean) as string[];

    for (const base of candidates) {
      const p = path.join(base, "Google", "Chrome", "Application", "chrome.exe");
      if (fs.existsSync(p)) return p;
    }
  } else if (platform === "darwin") {
    const p = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (fs.existsSync(p)) return p;
  } else {
    for (const cmd of ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"]) {
      try {
        const p = execSync(`which ${cmd}`, { encoding: "utf8" }).trim();
        if (p && fs.existsSync(p)) return p;
      } catch { /* not found */ }
    }
  }

  return undefined;
}
