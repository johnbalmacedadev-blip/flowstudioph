import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright-core";
import type { FlowStatus } from "../../shared/types.js";
import { CHROME_PROFILE_DIR, ensureDir } from "../paths.js";

export const FLOW_URL = "https://flow.google.com/?hl=en";
const CDP_PORT = Number(process.env.FSPH_CDP_PORT ?? 9335);

// Off-screen, well past any real monitor. Chrome keeps rendering it because of the flags below.
const HIDDEN = { left: -12000, top: -12000, width: 1600, height: 1000 };
const SHOWN = { left: 80, top: 60, width: 1400, height: 900 };

let browser: Browser | null = null;
let windowVisible = false;
/** True while the window is up only so you can sign in; it hides itself once you're signed in. */
let shownForSignIn = false;

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
 * Chrome is started as a normal browser (own profile, debugging port) and we attach to it:
 * Google refuses sign-in inside browsers launched by automation tools. Its window starts off-screen,
 * and background throttling is switched off so Flow keeps working while you can't see it.
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
        `--window-position=${HIDDEN.left},${HIDDEN.top}`,
        `--window-size=${HIDDEN.width},${HIDDEN.height}`,
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        "--disable-features=CalculateNativeWinOcclusion",
        FLOW_URL,
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    windowVisible = false;
    for (let i = 0; i < 40 && !(await cdpAlive()); i++) await new Promise((r) => setTimeout(r, 250));
    if (!(await cdpAlive())) throw new Error("Chrome started but did not open its debugging port.");
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  browser.on("disconnected", () => {
    browser = null;
    windowVisible = false;
    shownForSignIn = false;
  });
  return browser;
}

const isFlowUrl = (u: string) => u.includes("labs.google/fx") || u.includes("flow.google");

/** The tab we drive: an existing Flow tab, or a new one. */
export async function getFlowPage(): Promise<Page> {
  const b = await getBrowser();
  const ctx = b.contexts()[0];
  const pages = ctx.pages();
  const page =
    pages.find((p) => isFlowUrl(p.url()) || p.url().includes("accounts.google")) ?? pages[0] ?? (await ctx.newPage());
  if (!isFlowUrl(page.url()) && !page.url().includes("accounts.google")) {
    await page.goto(FLOW_URL, { waitUntil: "domcontentloaded" });
  }
  return page;
}

/** Move the Flow window on or off screen without closing it. */
export async function setWindowVisible(visible: boolean) {
  const page = await getFlowPage();
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: visible ? SHOWN : HIDDEN });
  } finally {
    await cdp.detach().catch(() => {});
  }
  if (visible) await page.bringToFront();
  windowVisible = visible;
  if (!visible) shownForSignIn = false;
}

type SignIn = "signed-in" | "signed-out" | "loading";

/** Signed in, Flow shows your Google Account button; signed out, its public /about page or Google's sign-in. */
async function signInState(page: Page): Promise<SignIn> {
  const url = page.url();
  if (url.includes("accounts.google") || new URL(url).pathname.startsWith("/about")) return "signed-out";
  if (await page.locator('[aria-label^="Google Account:"]').first().isVisible().catch(() => false)) return "signed-in";
  if (await page.locator('a[href*="accounts.google.com/ServiceLogin"]').first().isVisible().catch(() => false)) {
    return "signed-out";
  }
  return "loading";
}

/** The signed-in Google account, from Flow's profile button ("Google Account: Name (email)…"). */
export async function flowAccount(page: Page): Promise<{ name: string; email: string } | undefined> {
  const label = await page.locator('[aria-label^="Google Account:"]').first().getAttribute("aria-label", { timeout: 2_000 }).catch(() => null);
  const m = label && /Google Account:\s*(.*?)\s*\(([^)\s]+@[^)\s]+)\)/s.exec(label);
  return m ? { name: m[1].trim(), email: m[2].toLowerCase() } : undefined;
}

/**
 * Use another Google account: shows the Flow window on Google's account chooser, where you pick an account
 * or sign in to a new one yourself. Once Flow is back and signed in, the window hides again.
 */
export async function switchFlowAccount(): Promise<FlowStatus> {
  const page = await getFlowPage();
  await setWindowVisible(true);
  shownForSignIn = true;
  await page.goto("https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fflow.google.com%2F%3Fhl%3Den", {
    waitUntil: "domcontentloaded",
  });
  return flowStatus();
}

export async function flowStatus(): Promise<FlowStatus> {
  const off = { browserOpen: false, signedIn: false, windowVisible: false, url: "" };
  if (!(await cdpAlive())) return { ...off, message: "Google Flow isn't connected. Click Connect Google Flow." };
  try {
    const page = await getFlowPage();
    const state = await signInState(page);
    if (state === "signed-in" && shownForSignIn) await setWindowVisible(false);
    const message =
      state === "signed-in"
        ? "Connected to Google Flow."
        : state === "loading"
          ? "Loading Google Flow…"
          : "Sign in to Google in the Flow window that just opened.";
    const account = state === "signed-in" ? await flowAccount(page) : undefined;
    return { browserOpen: true, signedIn: state === "signed-in", windowVisible, url: page.url(), message, account };
  } catch (e) {
    return { ...off, browserOpen: true, message: (e as Error).message };
  }
}

/** Start or reconnect to Flow. The window stays hidden unless you need to sign in. */
export async function connectFlow(): Promise<FlowStatus> {
  const page = await getFlowPage();
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  let state: SignIn = "loading";
  for (let i = 0; i < 20 && state === "loading"; i++) {
    state = await signInState(page);
    if (state === "loading") await page.waitForTimeout(500);
  }
  if (state === "signed-out") {
    await setWindowVisible(true);
    shownForSignIn = true;
  } else if (windowVisible && !shownForSignIn) {
    // Leave it where it is if you opened it yourself.
  } else {
    await setWindowVisible(false);
  }
  return flowStatus();
}
