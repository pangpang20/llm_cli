import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const isWindows = process.platform === "win32";
const LOG_DIR = isWindows
  ? "C:/llmcli/logs"
  : "/var/log/llmcli";

let logFileHandle: fs.WriteStream | null = null;

/**
 * Initialize log file for current session
 */
export function initLogger(): void {
  try {
    // Ensure log directory exists
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logFileName = `llmcli-${timestamp}.log`;
    const logFilePath = path.join(LOG_DIR, logFileName);

    logFileHandle = fs.createWriteStream(logFilePath, { flags: "a" });

    // Also create a 'latest' symlink
    const latestLink = path.join(LOG_DIR, "latest.log");
    try {
      if (fs.existsSync(latestLink) || fs.lstatSync(latestLink).isSymbolicLink()) {
        fs.unlinkSync(latestLink);
      }
      fs.symlinkSync(logFilePath, latestLink, "file");
    } catch {
      // Ignore symlink errors
    }

    console.log(`[Logger] Writing to: ${logFilePath}`);
  } catch (err) {
    console.error(`[Logger] Failed to initialize: ${err}`);
  }
}

/**
 * Write a log message
 */
export function log(level: "INFO" | "WARN" | "ERROR" | "DEBUG", message: string): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] ${message}\n`;

  // Write to file
  if (logFileHandle) {
    logFileHandle.write(logLine);
  }

  // Also output to console for DEBUG level or errors
  if (level === "ERROR" || level === "DEBUG" || process.env.LLMCLI_DEBUG === "1") {
    console.log(logLine.trim());
  }
}

export function info(message: string): void {
  log("INFO", message);
}

export function warn(message: string): void {
  log("WARN", message);
}

export function error(message: string): void {
  log("ERROR", message);
}

export function debug(message: string): void {
  log("DEBUG", message);
}

/**
 * Close the log file
 */
export function closeLogger(): void {
  if (logFileHandle) {
    logFileHandle.end();
    logFileHandle = null;
  }
}
