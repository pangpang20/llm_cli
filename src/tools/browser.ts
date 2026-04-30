import puppeteer, { Browser, Page } from "puppeteer";
import * as fs from "fs";
import * as path from "path";
import { Tool } from "./types";

let browser: Browser | null = null;
let page: Page | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
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

    let buffer: Uint8Array;
    if (args.selector) {
      const el = await p.$(String(args.selector));
      if (!el) return `Error: Element not found: ${args.selector}`;
      buffer = await el.screenshot();
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
  }
}
