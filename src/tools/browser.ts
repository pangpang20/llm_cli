import puppeteer, { Browser, Page } from "puppeteer";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Tool } from "./types";
import { findChromePath } from "../utils/chrome";

const PROJECT_ROOT = process.cwd();
const ALLOWED_PROTOCOLS = ["http:", "https:"];
const BLOCKED_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "::1"];
const INTERNAL_PREFIXES = ["10.", "192.168.", "172.16.", "172.17.", "172.18.", "172.19.", "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.", "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.", "169.254."];

function validateUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
      return `Error: Protocol not allowed: ${parsed.protocol}`;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTS.includes(hostname)) {
      return `Error: Access to ${hostname} is blocked`;
    }
    for (const prefix of INTERNAL_PREFIXES) {
      if (hostname.startsWith(prefix)) {
        return `Error: Access to internal address ${hostname} is blocked`;
      }
    }
  } catch {
    return `Error: Invalid URL: ${url}`;
  }
  return null;
}

function validateScreenshotPath(filepath: string): string | null {
  const resolved = path.resolve(filepath);
  const tmpDir = os.tmpdir();
  if (resolved.startsWith(tmpDir + path.sep)) return null;
  if (resolved === PROJECT_ROOT || resolved.startsWith(PROJECT_ROOT + path.sep)) return null;
  return `Error: Screenshot path must be within project directory or temp dir: ${resolved}`;
}

let browser: Browser | null = null;
let page: Page | null = null;
let initAttempts = 0;
const MAX_INIT_ATTEMPTS = 3;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    if (initAttempts >= MAX_INIT_ATTEMPTS) {
      throw new Error("Browser initialization failed after max retries");
    }
    initAttempts++;
    const noSandbox = process.env.NO_SANDBOX === "1" || process.getuid?.() === 0;
    const executablePath = findChromePath();
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: noSandbox
        ? ["--no-sandbox", "--disable-setuid-sandbox"]
        : [],
    });
  }
  return browser;
}

async function getPage(): Promise<Page> {
  const b = await getBrowser();
  if (!page) {
    page = await b.newPage();
    await page.setViewport({ width: 1280, height: 800 });
  }
  return page;
}

export const browserNavigateTool: Tool = {
  name: "browser_navigate",
  description: "Navigate to a URL in the headless browser.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL to navigate to",
      },
    },
    required: ["url"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const url = String(args.url);
    const validationError = validateUrl(url);
    if (validationError) return validationError;

    const p = await getPage();
    const response = await p.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    const title = await p.title();
    return `Navigated to ${url}\nTitle: ${title}\nStatus: ${response?.status()}`;
  },
};

export const browserScreenshotTool: Tool = {
  name: "browser_screenshot",
  description: "Take a screenshot of the current page or a specific element.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path to save the screenshot (default: screenshot.png)",
      },
      selector: {
        type: "string",
        description: "CSS selector of a specific element to screenshot",
      },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const p = await getPage();
    const screenshotPath = String(args.path || "screenshot.png");
    const resolved = path.resolve(screenshotPath);

    const pathError = validateScreenshotPath(resolved);
    if (pathError) return pathError;

    let buffer: Uint8Array;
    if (args.selector) {
      try {
        const el = await p.$(String(args.selector));
        if (!el) return `Error: Element not found: ${args.selector}`;
        buffer = await el.screenshot();
      } catch {
        // Element not visible or not an HTMLElement, fallback to full page
        buffer = await p.screenshot();
      }
    } else {
      buffer = await p.screenshot();
    }
    fs.writeFileSync(resolved, Buffer.from(buffer));
    return `Screenshot saved to ${resolved}`;
  },
};

export const browserTextTool: Tool = {
  name: "browser_text",
  description: "Extract text content from the current page.",
  parameters: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector to extract text from (optional, extracts all page text if not provided)",
      },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const p = await getPage();
    let text: string;
    if (args.selector) {
      text = await p.$eval(String(args.selector), (el) => el.textContent || "").catch(() => "Element not found");
    } else {
      text = await p.evaluate(() => {
        const body = document.body;
        return body ? body.innerText : "";
      }).catch(() => "Failed to extract text");
    }
    return text.slice(0, 10000);
  },
};

export const browserClickTool: Tool = {
  name: "browser_click",
  description: "Click an element on the current page.",
  parameters: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector of the element to click",
      },
    },
    required: ["selector"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const p = await getPage();
    const selector = String(args.selector);
    const el = await p.$(selector);
    if (!el) return `Error: Element not found: ${selector}`;
    await el.click();
    await new Promise((r) => setTimeout(r, 500));
    return `Clicked: ${selector}`;
  },
};

export const browserTypeTool: Tool = {
  name: "browser_type",
  description: "Type text into an input field on the current page.",
  parameters: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector of the input element",
      },
      text: {
        type: "string",
        description: "Text to type",
      },
    },
    required: ["selector", "text"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const p = await getPage();
    const selector = String(args.selector);
    const el = await p.$(selector);
    if (!el) return `Error: Element not found: ${selector}`;
    await el.click({ clickCount: 3 });
    await el.type(String(args.text));
    return `Typed into: ${selector}`;
  },
};

export async function cleanupBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
    initAttempts = 0;
  }
}
