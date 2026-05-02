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

export const browserAssertTool: Tool = {
  name: "browser_assert",
  description: "Assert a condition on the current page. Returns PASS or FAIL.",
  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        description: "Assertion type: element_exists, element_not_exists, text_contains, text_equals, url_contains, url_equals, value_contains, value_equals",
      },
      selector: {
        type: "string",
        description: "CSS selector (required for element/text/value assertions)",
      },
      attribute: {
        type: "string",
        description: "Attribute name (required for value_contains/value_equals)",
      },
      expected: {
        type: "string",
        description: "Expected value to compare against",
      },
    },
    required: ["type"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const p = await getPage();
    const type = String(args.type);
    const selector = args.selector ? String(args.selector) : "";
    const attribute = args.attribute ? String(args.attribute) : "";
    const expected = args.expected ? String(args.expected) : "";

    try {
      switch (type) {
        case "element_exists": {
          const el = await p.$(selector);
          return el ? "PASS: Element exists" : `FAIL: Element not found: ${selector}`;
        }
        case "element_not_exists": {
          const el = await p.$(selector);
          return el ? `FAIL: Element found: ${selector}` : "PASS: Element not exists";
        }
        case "text_contains": {
          const text = await p.$eval(selector, (el) => el.textContent || "").catch(() => "");
          return text.includes(expected) ? `PASS: Text contains "${expected}"` : `FAIL: Text "${text}" does not contain "${expected}"`;
        }
        case "text_equals": {
          const text = await p.$eval(selector, (el) => (el.textContent || "").trim()).catch(() => "");
          return text === expected ? `PASS: Text equals "${expected}"` : `FAIL: Text "${text}" does not equal "${expected}"`;
        }
        case "url_contains": {
          const url = p.url();
          return url.includes(expected) ? `PASS: URL contains "${expected}"` : `FAIL: URL "${url}" does not contain "${expected}"`;
        }
        case "url_equals": {
          const url = p.url();
          return url === expected ? `PASS: URL equals "${expected}"` : `FAIL: URL "${url}" does not equal "${expected}"`;
        }
        case "value_contains": {
          const val = await p.$eval(selector, (el, attr) => (el as HTMLElement).getAttribute(attr) || "", attribute).catch(() => "");
          return val.includes(expected) ? `PASS: ${attribute} contains "${expected}"` : `FAIL: ${attribute}="${val}" does not contain "${expected}"`;
        }
        case "value_equals": {
          const val = await p.$eval(selector, (el, attr) => (el as HTMLElement).getAttribute(attr) || "", attribute).catch(() => "");
          return val === expected ? `PASS: ${attribute} equals "${expected}"` : `FAIL: ${attribute}="${val}" does not equal "${expected}"`;
        }
        default:
          return `Error: Unknown assertion type: ${type}`;
      }
    } catch (err) {
      return `FAIL: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const browserWaitTool: Tool = {
  name: "browser_wait",
  description: "Wait for a condition on the page before continuing.",
  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        description: "Wait type: element_visible, element_hidden, text_visible, url_contains",
      },
      selector: {
        type: "string",
        description: "CSS selector (required for element_visible/element_hidden/text_visible)",
      },
      expected: {
        type: "string",
        description: "Expected text or URL fragment (required for text_visible/url_contains)",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default: 10000)",
      },
    },
    required: ["type"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const p = await getPage();
    const type = String(args.type);
    const selector = args.selector ? String(args.selector) : "";
    const expected = args.expected ? String(args.expected) : "";
    const timeout = Number(args.timeout) || 10000;

    try {
      switch (type) {
        case "element_visible": {
          await p.waitForSelector(selector, { visible: true, timeout });
          return `PASS: Element visible: ${selector}`;
        }
        case "element_hidden": {
          await p.waitForSelector(selector, { hidden: true, timeout });
          return `PASS: Element hidden: ${selector}`;
        }
        case "text_visible": {
          await p.waitForFunction(
            (sel, txt) => {
              const el = document.querySelector(sel);
              return el ? (el.textContent || "").includes(txt) : false;
            },
            { timeout },
            selector,
            expected
          );
          return `PASS: Text "${expected}" visible in ${selector}`;
        }
        case "url_contains": {
          await p.waitForFunction(
            (txt) => window.location.href.includes(txt),
            { timeout },
            expected
          );
          return `PASS: URL contains "${expected}"`;
        }
        default:
          return `Error: Unknown wait type: ${type}`;
      }
    } catch {
      return `FAIL: Timeout waiting for ${type} (${timeout}ms)`;
    }
  },
};

export const browserEvalTool: Tool = {
  name: "browser_eval",
  description: "Execute JavaScript in the page context and return the result.",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "JavaScript expression to evaluate in the page context",
      },
    },
    required: ["expression"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const p = await getPage();
    const expression = String(args.expression);
    try {
      const result = await p.evaluate((expr) => {
        try {
          const val = eval(expr);
          return typeof val === "object" ? JSON.stringify(val) : String(val);
        } catch (e) {
          return `Error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }, expression);
      return `Result: ${result}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
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
