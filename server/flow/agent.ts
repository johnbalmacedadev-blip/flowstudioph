import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import type { Project } from "../../shared/types.js";
import { DATA_DIR, ensureDir } from "../paths.js";
import { chunkScript, merge, parseBreakdown, projectBrief, RULES, SHAPE, timingRule, type Breakdown } from "../storyboard.js";
import { getFlowPage } from "./browser.js";
import { openProject, resetComposer } from "./driver.js";

type Report = (progress: string) => void;

const REPLY_TIMEOUT_MS = 6 * 60_000;

/**
 * Storyboard with Google Flow's own agent (Gemini), in the signed-in Flow account: no API key and no bill.
 * Only text is asked for; Flow's agent asks before generating media, and the app never confirms.
 */
export async function breakdownWithFlowAgent(p: Project, report: Report): Promise<Breakdown> {
  const parts = chunkScript(p.script);
  const page = await getFlowPage();
  report("Opening the Flow project…");
  await openProject(page, p);

  const results: Breakdown[] = [];
  try {
    for (const [i, part] of parts.entries()) {
      const what = parts.length > 1 ? `part ${i + 1} of ${parts.length}` : "the storyboard";
      results.push(await askForBreakdown(page, buildPrompt(p, part, i, parts.length, results), what, report));
    }
  } finally {
    await setAgent(page, false);
  }
  const b = merge(results);
  report(`Got ${b.characters.length} characters and ${b.scenes.length} scenes.`);
  return b;
}

const MAX_ATTEMPTS = 4;

/**
 * Flow's AI sometimes refuses a harmless script ("might violate our policies"), and sometimes wraps or
 * drops the JSON. Both are usually fine on a second try, so ask up to four times before giving up.
 */
async function askForBreakdown(page: Page, prompt: string, what: string, report: Report): Promise<Breakdown> {
  let refused = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    report(attempt === 1 ? `Flow's AI is writing ${what}…` : `Flow's AI is writing ${what} (try ${attempt} of ${MAX_ATTEMPTS})…`);
    const reply = await ask(page, prompt, { freshChat: true });
    if (/violate our policies|try a different prompt/i.test(reply)) {
      refused = true;
      continue;
    }
    // Passing Flow errors ("Something went wrong", "Failed to render response"): just ask again.
    if (/something went wrong|failed to render/i.test(reply) && !reply.includes("{")) continue;
    try {
      return parseBreakdown(reply);
    } catch {
      keepUnreadable(reply);
      // Ask for the JSON alone once, in the same chat, before starting over.
      const again = await ask(page, "Reply again with ONLY that JSON object, nothing else.");
      try {
        return parseBreakdown(again);
      } catch {
        keepUnreadable(again);
        // next attempt
      }
    }
  }
  throw new Error(
    refused
      ? "Google Flow's AI declined this script (it said the request might go against its policies). Try rewording sensitive parts, or switch to Quick split."
      : "Google Flow's AI didn't return a usable storyboard. Try again, or switch to Quick split.",
  );
}

/** Keep replies the parser couldn't read in data/logs, to see what Flow's AI sent. */
function keepUnreadable(reply: string) {
  const dir = ensureDir(path.join(DATA_DIR, "logs"));
  fs.writeFileSync(path.join(dir, `flow-ai-reply-${Date.now()}.txt`), reply);
}

function buildPrompt(p: Project, part: string, index: number, total: number, done: Breakdown[]) {
  const refs = p.references.map((r) => `"${r.label}" (${r.kind})`).join(", ");
  const known = done.flatMap((d) => d.characters.map((c) => `${c.name}: ${c.visual_prompt}`));
  const lastScene = done.at(-1)?.scenes.at(-1);
  return [
    "This is a new, separate request: ignore any earlier messages in this chat.",
    "Do NOT generate, edit or animate any images or videos, and don't ask to. Reply with text only.",
    "You are a storyboard artist writing prompts for this Flow project.",
    RULES,
    timingRule(p),
    `Aspect ratio: ${p.settings.aspectRatio}.`,
    projectBrief(p),
    p.settings.style ? `Requested visual style: ${p.settings.style}` : "",
    refs ? `Reference images in this project (use these exact labels in reference_labels): ${refs}.` : "",
    total > 1 ? `This is part ${index + 1} of ${total} of a longer source; write only this part's scenes.` : "",
    known.length ? `Characters already defined (reuse these names and descriptions exactly):\n${known.join("\n")}` : "",
    lastScene ? `The previous part ended with this scene: ${lastScene.title} at ${lastScene.location}: ${lastScene.action}` : "",
    `Reply with ONLY one JSON object in exactly this shape, with no other text before or after it:\n${SHAPE}`,
    `Source:\n<<<\n${part}\n>>>`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Send one message to Flow's agent and return its reply once it has finished writing. */
async function ask(page: Page, text: string, { freshChat = false } = {}): Promise<string> {
  await dismissOverlays(page);
  await setAgent(page, true);
  if (freshChat) {
    // A new chat for each storyboard, so an earlier one can't leak into it.
    await page.locator('[aria-label="Start new session"]').first().click({ timeout: 10_000 });
    await page.waitForTimeout(800);
  }
  const rows = page.locator("flow-agent-panel .messages-list > .message-row.agent-row");
  const before = await rows.count();

  const box = page.locator('[contenteditable="true"][aria-label="What do you want to create?"]').last();
  await box.click();
  await page.keyboard.insertText(text);
  await page.locator('[aria-label="Start generation"]').last().click();

  // Done when a new reply exists, Flow has stopped (no Stop button) and the text has stopped changing.
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  let last = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    if ((await rows.count()) <= before) continue;
    const reply = await rows.last().innerText().catch(() => "");
    const busy = await page.locator('[aria-label="Stop"]').last().isVisible().catch(() => false);
    if (reply !== last) {
      last = reply;
      stableSince = Date.now();
    } else if (!busy && reply && Date.now() - stableSince > 3000) {
      return reply.replace(/\n(thumb_up|thumb_down|content_copy|flag)\s*/g, "\n");
    }
  }
  throw new Error("Flow's agent didn't finish replying in time. Try again, or use Quick split.");
}

/** Flow's composer has an Agent switch; storyboards use it, renders don't. */
async function setAgent(page: Page, on: boolean) {
  if (!on) return resetComposer(page); // closes the chat panel and switches the agent off
  // With the chat panel open the agent is already on (and the Agent switch isn't shown).
  const panel = page.locator("flow-agent-panel");
  if (await panel.isVisible().catch(() => false)) return;
  const agent = page.getByRole("button", { name: "Agent", exact: true }).last();
  if ((await agent.getAttribute("aria-pressed").catch(() => null)) !== "true") await agent.click();
  await page.waitForTimeout(600);
  // Replies only appear in the chat panel, and Flow doesn't always open it by itself: Expand does.
  if (!(await panel.isVisible().catch(() => false))) {
    await page.locator('[aria-label="Expand"]').last().click({ timeout: 10_000 });
    await panel.waitFor({ timeout: 10_000 });
  }
}

async function dismissOverlays(page: Page) {
  for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
  for (let i = 0; i < 3 && (await page.locator(".cdk-overlay-backdrop").count()); i++) {
    await page.locator(".cdk-overlay-backdrop").last().click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
  }
}
