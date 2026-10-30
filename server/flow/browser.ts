import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright-core";
import type { FlowStatus } from "../../shared/types.js";
import { CHROME_PROFILE_DIR, ensureDir } from "../paths.js";

export const FLOW_URL = "https://flow.google.com/?hl=en";
const CDP_PORT = Number(process.env.FSPH_CDP_PORT ?? 9335);

let browser: Browser | null = null;

function findChrome(): string {
  const candidates = [
    process.env.FSPH_CHROME,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
  ].filter(Boolean) as string[];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error("Google Chrome was not found. Install it, or set FSPH_CHROME to chrome.exe's path.");
  return found;
}

async function cdpAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Chrome is started as a normal window (own profile, debugging port) and we attach to it.
 * Google refuses sign-in inside browsers launched by automation tools; a normal Chrome is fine.
 */
export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (!(await cdpAlive())) {
    ensureDir(CHROME_PROFILE_DIR);
    const child = spawn(
      findChrome(),
      [
        `--user-data-dir=${CHROME_PROFILE_DIR}`,
        `--remote-debugging-port=${CDP_PORT}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--start-maximized",
        FLOW_URL,
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    for (let i = 0; i < 40 && !(await cdpAlive()); i++) await new Promise((r) => setTimeout(r, 250));
    if (!(await cdpAlive())) throw new Error("Chrome started but did not open its debugging port.");
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  browser.on("disconnected", () => (browser = null));
  return browser;
}

const isFlowUrl = (u: string) => u.includes("labs.google/fx") || u.includes("flow.google");

/** The tab we drive: an existing Flow tab, or a new one. */
export async function getFlowPage(): Promise<Page> {
  const b = await getBrowser();
  const ctx = b.contexts()[0];
  const pages = ctx.pages();
  const page = pages.find((p) => isFlowUrl(p.url())) ?? pages[0] ?? (await ctx.newPage());
  if (!isFlowUrl(page.url())) await page.goto(FLOW_URL, { waitUntil: "domcontentloaded" });
  return page;
}

export async function flowStatus(): Promise<FlowStatus> {
  if (!(await cdpAlive())) {
    return { browserOpen: false, signedIn: false, url: "", message: "Chrome isn't open. Click Connect Google Flow." };
  }
  try {
    const b = await getBrowser();
    const page = b.contexts()[0]?.pages().find((p) => isFlowUrl(p.url()) || p.url().includes("accounts.google"));
    if (!page) return { browserOpen: true, signedIn: false, url: "", message: "Open Flow in the Flow Studio PH Chrome window." };
    const url = page.url();
    if (url.includes("accounts.google")) {
      return { browserOpen: true, signedIn: false, url, message: "Finish signing in to Google in the Chrome window." };
    }
    const signedIn = await isSignedIn(page);
    return {
      browserOpen: true,
      signedIn,
      url,
      message: signedIn ? "Connected to Google Flow." : "Sign in to Google in the Chrome window.",
    };
  } catch (e) {
    return { browserOpen: true, signedIn: false, url: "", message: (e as Error).message };
  }
}

/** Signed out, Flow sends you to its public /about page, which has a "Sign in" link to Google accounts. */
async function isSignedIn(page: Page) {
  if (new URL(page.url()).pathname.startsWith("/about")) return false;
  const signIn = page.locator('a[href*="accounts.google.com/ServiceLogin"]');
  return !(await signIn.first().isVisible().catch(() => false));
}

export async function openFlow() {
  const page = await getFlowPage();
  await page.bringToFront();
  return flowStatus();
}
