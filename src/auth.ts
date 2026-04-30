import puppeteer, { Browser, Cookie } from "puppeteer";
import * as fs from "fs";
import * as path from "path";

const COOKIE_FILE = path.join(process.cwd(), ".qwen_session.json");
const LOGIN_URL = "https://chat.qwen.ai/";

export interface SessionData {
  cookies: Cookie[];
  savedAt: string;
}

export async function loadSession(): Promise<Cookie[] | null> {
  if (!fs.existsSync(COOKIE_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8")) as SessionData;
    // Session expires after 12 hours (tokens can expire quickly)
    const savedAt = new Date(data.savedAt);
    const now = new Date();
    if (now.getTime() - savedAt.getTime() > 12 * 60 * 60 * 1000) {
      return null;
    }
    return data.cookies;
  } catch {
    return null;
  }
}

export async function saveSession(cookies: Cookie[]): Promise<void> {
  const session: SessionData = {
    cookies,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(session, null, 2));
}

export async function loginAndGetSession(): Promise<Cookie[]> {
  console.log("\nLaunching browser for login...");
  console.log("A browser window will open. Please scan the QR code or enter your account credentials.\n");

  const noSandbox = process.env.NO_SANDBOX === "1";
  const browser = await puppeteer.launch({
    headless: false,
    args: noSandbox
      ? ["--no-sandbox", "--disable-setuid-sandbox"]
      : [],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    console.log("Opening chat.qwen.ai...");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    console.log("\nWaiting for login (QR code scan or account login)...");
    console.log("Timeout: 5 minutes. The browser window will close automatically after login.\n");

    // Wait for the chat interface to appear (login complete)
    // Strategy: wait for the URL to not contain login/auth, or for chat input to appear
    await page.waitForFunction(
      () => {
        const url = window.location.href;
        // If we're past login, URL should be chat.qwen.ai/ or chat.qwen.ai/c/...
        if (url === "https://chat.qwen.ai/" || url.startsWith("https://chat.qwen.ai/c/")) {
          // Check that we're not seeing a login modal
          const loginModal = document.querySelector('[class*="login"], [class*="auth"], [class*="LoginModal"]');
          if (!loginModal) return true;
        }
        return false;
      },
      { timeout: 300000, polling: 500 }
    );

    // Give it a moment for all cookies to be set
    await new Promise((r) => setTimeout(r, 3000));

    // Get all cookies
    const cookies = await page.cookies();

    // Verify we have meaningful auth cookies
    const authCookies = cookies.filter(
      (c) => c.name.toLowerCase().includes("token") ||
             c.name.toLowerCase().includes("session") ||
             c.name.toLowerCase().includes("sid") ||
             c.name.toLowerCase().includes("auth")
    );

    if (authCookies.length === 0) {
      console.warn("Warning: No typical auth cookies found. Proceeding anyway.");
    }

    await browser.close();
    console.log("\nLogin successful! Browser closed.");
    return cookies;
  } catch (err) {
    try {
      await browser.close();
    } catch {
      // ignore
    }
    throw new Error(`Login failed or timed out: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function ensureAuth(): Promise<Cookie[]> {
  const existing = await loadSession();
  if (existing && existing.length > 0) {
    return existing;
  }

  const cookies = await loginAndGetSession();
  await saveSession(cookies);
  return cookies;
}
