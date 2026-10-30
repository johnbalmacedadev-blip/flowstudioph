import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import type { Character, Project, Scene } from "../../shared/types.js";
import { ensureDir, refsDir, rendersDir } from "../paths.js";
import { readSettings } from "../settings.js";
import { getProject, updateProject } from "../store.js";
import { getFlowPage } from "./browser.js";

type Report = (progress: string) => void;

const FLOW_HOME = "https://flow.google.com/?hl=en";
const IMAGE_TIMEOUT_MS = 4 * 60_000;
const VIDEO_TIMEOUT_MS = 12 * 60_000;
const MAX_ATTACHMENTS = 3;

interface Attachment {
  /** Unique name Flow shows for the upload, so it can be found again in the asset picker. */
  name: string;
  file: string;
}

interface Request {
  kind: "image" | "video";
  prompt: string;
  aspect: Project["settings"]["aspectRatio"];
  durationSec?: number;
  /** Video only: "frames" uses the first attachment as the start frame, "ingredients" uses them as references. */
  videoMode?: "frames" | "ingredients";
  attachments: Attachment[];
}

// ---------------------------------------------------------------- public API

export async function renderPortrait(p: Project, characterId: string, report: Report) {
  const c = p.characters.find((x) => x.id === characterId);
  if (!c) throw new Error("Character not found");
  const prompt = [
    `Character reference portrait of ${c.visualPrompt || c.name}.`,
    "Full body, facing camera, neutral plain background, even soft lighting, no text.",
    p.styleGuide,
  ].filter(Boolean).join(" ");
  return generate(p, report, `portrait-${c.id}`, {
    kind: "image",
    prompt,
    aspect: "9:16",
    attachments: characterRefs(p, [c], false),
  });
}

export async function renderSceneImage(p: Project, sceneId: string, report: Report) {
  const s = scene(p, sceneId);
  return generate(p, report, `scene-${pad(s.number)}-frame`, {
    kind: "image",
    prompt: s.imagePrompt || s.action,
    aspect: p.settings.aspectRatio,
    attachments: characterRefs(p, cast(p, s), true),
  });
}

export async function renderSceneVideo(p: Project, sceneId: string, report: Report) {
  const s = scene(p, sceneId);
  const frame = s.imageFile && path.join(rendersDir(p.id), s.imageFile);
  const useFrame = Boolean(frame && fs.existsSync(frame));
  return generate(p, report, `scene-${pad(s.number)}-clip`, {
    kind: "video",
    prompt: s.videoPrompt || s.action,
    aspect: p.settings.aspectRatio,
    durationSec: s.durationSec,
    videoMode: useFrame ? "frames" : "ingredients",
    attachments: useFrame
      ? [{ name: `fsph-${s.id}-frame${path.extname(frame!)}`, file: frame! }]
      : characterRefs(p, cast(p, s), true),
  });
}

// ---------------------------------------------------------------- helpers

const pad = (n: number) => String(n).padStart(2, "0");

function scene(p: Project, id: string) {
  const s = p.scenes.find((x) => x.id === id);
  if (!s) throw new Error("Scene not found");
  return s;
}

function cast(p: Project, s: Scene) {
  return p.characters.filter((c) => s.characterIds.includes(c.id));
}

/** A character's rendered portrait if there is one, else their reference images; at most 3 in total. */
function characterRefs(p: Project, chars: Character[], preferPortrait: boolean): Attachment[] {
  const out: Attachment[] = [];
  for (const c of chars) {
    const portrait = c.portraitFile && path.join(rendersDir(p.id), c.portraitFile);
    if (preferPortrait && portrait && fs.existsSync(portrait)) {
      out.push({ name: `fsph-${c.id}-portrait${path.extname(portrait)}`, file: portrait });
      continue;
    }
    for (const r of p.references.filter((x) => c.referenceIds.includes(x.id))) {
      out.push({ name: `fsph-${r.id}${path.extname(r.file)}`, file: path.join(refsDir(p.id), r.file) });
    }
  }
  return out.filter((a) => fs.existsSync(a.file)).slice(0, MAX_ATTACHMENTS);
}

// ---------------------------------------------------------------- the Flow page

async function generate(p: Project, report: Report, baseName: string, req: Request) {
  const page = await getFlowPage();
  await page.bringToFront();
  report("Opening the Flow project…");
  await openProject(page, p);
  await resetComposer(page);

  for (const [i, a] of req.attachments.entries()) {
    report(`Attaching reference ${i + 1} of ${req.attachments.length}…`);
    await attach(page, a);
  }

  report("Setting up the generation…");
  const credits = await configure(page, req);
  const cap = readSettings().maxCreditsPerClip;
  if (credits > cap) {
    await resetComposer(page);
    throw new Error(`Flow quoted ${credits} credits, over your limit of ${cap}. Raise it in Settings to allow this.`);
  }

  await typePrompt(page, req.prompt);
  const before = await mediaSources(page);
  await page.locator('[aria-label="Start generation"]').last().click();
  report(credits ? `Generating in Flow (${credits} credits)…` : "Generating in Flow (free)…");

  const src = await waitForResult(page, before, req.kind, report);
  report("Downloading…");
  const { bytes, ext } = await download(page, src, req.kind);
  const file = `${baseName}-${Date.now().toString(36)}${ext}`;
  fs.writeFileSync(path.join(ensureDir(rendersDir(p.id)), file), bytes);
  return file;
}

/** Each app project gets its own Flow project, created on first use and remembered. */
async function openProject(page: Page, p: Project) {
  const saved = getProject(p.id).flowProjectUrl;
  if (saved) {
    if (!page.url().startsWith(saved)) await page.goto(`${saved}?hl=en`, { waitUntil: "domcontentloaded" });
  } else {
    await page.goto(FLOW_HOME, { waitUntil: "domcontentloaded" });
    await page.getByText("New project", { exact: true }).first().click({ timeout: 30_000 });
    await page.waitForURL(/\/project\//, { timeout: 30_000 });
    const title = page.locator('input[aria-label="Editable text"]').first();
    await title.waitFor({ timeout: 30_000 });
    await title.fill(`Flow Studio PH · ${p.name}`.slice(0, 80));
    await title.press("Enter");
    const url = page.url().split("?")[0];
    updateProject(p.id, (x) => (x.flowProjectUrl = url));
  }
  await composer(page).waitFor({ timeout: 60_000 });
}

const composer = (page: Page) => page.locator('[contenteditable="true"][aria-label="What do you want to create?"]').last();

async function resetComposer(page: Page) {
  await page.keyboard.press("Escape");
  const clear = page.locator('[aria-label="Clear prompt"]').last();
  if (await clear.isVisible().catch(() => false)) await clear.click();
  // Direct mode, not Flow's chat agent: the app sets every option itself.
  const agent = page.getByRole("button", { name: "Agent", exact: true }).last();
  if ((await agent.getAttribute("aria-pressed").catch(() => null)) === "true") await agent.click();
  await page.waitForTimeout(500);
}

async function openPicker(page: Page) {
  const upload = page.getByRole("button", { name: "Upload media" });
  if (!(await upload.isVisible().catch(() => false))) {
    await page.locator('[aria-label="Add ingredients to the prompt box"]').last().click();
    await upload.waitFor({ timeout: 15_000 });
  }
}

/** Find the asset by its unique name in the picker, uploading it the first time. Clicking it attaches it. */
async function attach(page: Page, a: Attachment) {
  await openPicker(page);
  const search = page.getByPlaceholder("Search assets");
  const option = () => page.getByRole("option").filter({ hasText: a.name }).first();
  await search.fill(a.name);
  await page.waitForTimeout(1500);
  if (!(await option().isVisible().catch(() => false))) {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 15_000 }),
      page.getByRole("button", { name: "Upload media" }).click(),
    ]);
    await chooser.setFiles({ name: a.name, mimeType: mimeOf(a.file), buffer: fs.readFileSync(a.file) });
    await search.fill("");
    await search.fill(a.name);
    await option().waitFor({ timeout: 60_000 });
    await waitUntil(async () => !(await option().innerText()).includes("Uploading"), 120_000, "Upload took too long.");
  }
  await option().click();
  await page.waitForTimeout(800);
  await page.keyboard.press("Escape");
}

function mimeOf(file: string) {
  const ext = path.extname(file).toLowerCase();
  return ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
}

/** Set type, mode, aspect, length, resolution and count; returns Flow's own credit quote. */
async function configure(page: Page, req: Request): Promise<number> {
  await page.locator('[aria-label="Settings trigger"]').last().click();
  const pop = page.locator(".cdk-overlay-container");
  // A button's text is its icon name followed by its label with no space ("imageImage"), so match the end.
  const radio = (label: string) => pop.locator("button[role=radio]").filter({ hasText: new RegExp(`${escape(label)}$`) }).first();
  const pick = async (label: string) => {
    const r = radio(label);
    await r.waitFor({ timeout: 10_000 });
    if ((await r.getAttribute("aria-checked")) !== "true") await r.click();
    await page.waitForTimeout(300);
  };

  await pick(req.kind === "image" ? "Image" : "Video");
  if (req.kind === "video") {
    await pick(req.videoMode === "frames" ? "Frames" : "Ingredients");
    await pick("720p");
    if (req.durationSec) await pick(`${req.durationSec}s`);
  }
  await pick(req.aspect);
  await pick("x1");

  const quote = await pop.getByText(/Generating will use/).innerText().catch(() => "");
  await page.keyboard.press("Escape");
  return Number(/(\d+)\s*credit/.exec(quote)?.[1] ?? 0);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function typePrompt(page: Page, text: string) {
  const box = composer(page);
  await box.click();
  await page.keyboard.insertText(text.replace(/\s+/g, " ").trim());
}

/** Every media URL in the grid right now, so the new result can be told apart. */
async function mediaSources(page: Page): Promise<Set<string>> {
  const srcs = await page.evaluate(() =>
    [...document.querySelectorAll("flow-grid-tile-container img, flow-grid-tile-container video, flow-grid-tile-container source")]
      .map((e) => (e as HTMLImageElement).currentSrc || (e as HTMLImageElement).src)
      .filter(Boolean),
  );
  return new Set(srcs);
}

async function waitForResult(page: Page, before: Set<string>, kind: Request["kind"], report: Report) {
  const deadline = Date.now() + (kind === "video" ? VIDEO_TIMEOUT_MS : IMAGE_TIMEOUT_MS);
  let lastPct = "";
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    const state = await page.evaluate((seen) => {
      const tiles = [...document.querySelectorAll("flow-grid-tile-container")];
      const first = tiles[0] as HTMLElement | undefined;
      const text = first?.innerText ?? "";
      const pct = /(\d{1,3})%/.exec(text)?.[1] ?? "";
      const failed = /fail|went wrong|couldn.t|unable|violat|policy/i.test(text) ? text.trim().slice(0, 200) : "";
      const fresh = tiles
        .flatMap((t) => [...t.querySelectorAll("video, source, img")])
        .map((e) => ({ tag: e.tagName, src: (e as HTMLImageElement).currentSrc || (e as HTMLImageElement).src }))
        .filter((m) => m.src && !seen.includes(m.src) && !m.src.startsWith("data:"));
      return { pct, failed, fresh };
    }, [...before]);

    if (state.failed) throw new Error(`Flow couldn't generate this: ${state.failed}`);
    if (state.pct && state.pct !== lastPct) {
      lastPct = state.pct;
      report(`Generating in Flow… ${state.pct}%`);
    }
    if (state.pct) continue;
    const want = kind === "video" ? state.fresh.find((m) => m.tag !== "IMG") : state.fresh.find((m) => m.tag === "IMG");
    if (want) return want.src;
    if (kind === "video" && state.fresh.length) {
      // Video tiles may only load their <video> on hover.
      await page.locator("flow-grid-tile-container").first().hover().catch(() => {});
    }
  }
  throw new Error("Flow didn't finish in time. The result may still appear in your Flow project.");
}

async function download(page: Page, src: string, kind: Request["kind"]) {
  const url = kind === "image" && /\/asb\//.test(src) ? src.replace(/=[^=/]*$/, "=s0") : src;
  // New results are signed links on flow-content.google: fetch them directly (the page can't, cross-site).
  if (!url.includes("/asb/")) {
    const res = await fetch(url).catch(() => null);
    if (res?.ok) {
      const type = res.headers.get("content-type") ?? "";
      return { bytes: Buffer.from(await res.arrayBuffer()), ext: extFor(type, kind) };
    }
  }
  const r = await page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: "include" });
    if (!res.ok) return { ok: false, status: res.status, type: "", b64: "" };
    const buf = new Uint8Array(await res.arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { ok: true, status: res.status, type: res.headers.get("content-type") ?? "", b64: btoa(s) };
  }, url);
  if (!r.ok) throw new Error(`Couldn't download the result from Flow (HTTP ${r.status}).`);
  return { bytes: Buffer.from(r.b64, "base64"), ext: extFor(r.type, kind) };
}

function extFor(type: string, kind: Request["kind"]) {
  if (type.includes("png")) return ".png";
  if (type.includes("webp")) return ".webp";
  if (type.includes("video") || kind === "video") return ".mp4";
  return ".jpg";
}

async function waitUntil(fn: () => Promise<boolean>, ms: number, message: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(message);
}
