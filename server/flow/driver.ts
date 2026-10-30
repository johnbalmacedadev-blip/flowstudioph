import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import type { Character, Project, Scene } from "../../shared/types.js";
import { lastFrame } from "../media.js";
import { ensureDir, refsDir, rendersDir } from "../paths.js";
import { readSettings } from "../settings.js";
import { getProject, updateProject } from "../store.js";
import { getBrowser, getFlowPage } from "./browser.js";

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

const CONTINUE_FRAME =
  "Continue the exact same scene as the first reference image: same location, set, props, lighting, time of day and wardrobe, as the next moment of the same shot.";

export async function renderSceneImage(p: Project, sceneId: string, report: Report) {
  const s = scene(p, sceneId);
  const prevFrame = s.continuesPrevious ? renderFile(p, previous(p, s)?.imageFile) : undefined;
  if (s.continuesPrevious && !prevFrame) report("No frame for the previous scene yet; matching the cast only.");
  const refs = characterRefs(p, cast(p, s), true);
  return generate(p, report, `scene-${pad(s.number)}-frame`, {
    kind: "image",
    prompt: prevFrame ? `${CONTINUE_FRAME} ${s.imagePrompt || s.action}` : s.imagePrompt || s.action,
    aspect: p.settings.aspectRatio,
    attachments: (prevFrame ? [upload(prevFrame), ...refs] : refs).slice(0, MAX_ATTACHMENTS),
  });
}

/**
 * Where a clip starts: a continuing scene picks up on the last frame of the previous clip (a seamless cut);
 * otherwise the scene's own frame; otherwise Flow works from the cast as references.
 */
export async function renderSceneVideo(p: Project, sceneId: string, report: Report) {
  const s = scene(p, sceneId);
  let start: string | undefined;
  if (s.continuesPrevious) {
    const prevClip = renderFile(p, previous(p, s)?.videoFile);
    if (prevClip) {
      report("Taking the last frame of the previous clip…");
      start = await lastFrame(prevClip);
    } else {
      report("The previous scene has no clip yet, so this one can't pick up from it; using its own frame.");
    }
  }
  start ??= renderFile(p, s.imageFile);
  const { file, src } = await generateMedia(p, report, `scene-${pad(s.number)}-clip`, {
    kind: "video",
    prompt: s.videoPrompt || s.action,
    aspect: p.settings.aspectRatio,
    durationSec: s.durationSec,
    videoMode: start ? "frames" : "ingredients",
    attachments: start ? [upload(start)] : characterRefs(p, cast(p, s), true),
  });
  updateProject(p.id, (x) => {
    const sc = x.scenes.find((y) => y.id === s.id);
    if (sc) Object.assign(sc, { videoFlowId: flowVideoId(src), videoHdFile: undefined });
  });
  return file;
}

/**
 * Flow's 1080p AI upscale of a scene's clip, downloaded next to it (once; later exports reuse it).
 * Flow does the work: it takes about a minute per clip and is free on paid Google AI plans.
 */
export async function upscaleClip(p: Project, sceneId: string, report: Report): Promise<string> {
  const s = scene(p, sceneId);
  const original = renderFile(p, s.videoFile);
  if (!original) throw new Error(`Scene ${s.number} has no clip to upscale.`);
  const existing = renderFile(p, s.videoHdFile);
  if (existing) return existing;

  const page = await getFlowPage();
  await openProject(page, p);
  for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
  report(`Finding scene ${s.number}'s clip in Flow…`);
  const { tile, id } = await findClipTile(page, s.videoFlowId, fs.statSync(original).size);
  if (id !== s.videoFlowId) {
    updateProject(p.id, (x) => {
      const sc = x.scenes.find((y) => y.id === s.id);
      if (sc) sc.videoFlowId = id;
    });
  }

  // Have Chrome save downloads into the renders folder under a temporary name, and tell us when done.
  const dir = ensureDir(rendersDir(p.id));
  const cdp = await (await getBrowser()).newBrowserCDPSession();
  try {
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: dir, eventsEnabled: true });
    const finished = new Promise<{ guid: string; state: string }>((resolve) =>
      cdp.on("Browser.downloadProgress", (e: { guid: string; state: string }) => {
        if (e.state !== "inProgress") resolve(e);
      }),
    );
    await tile.evaluate((t) => t.scrollIntoView({ block: "center" }));
    await tile.hover({ position: { x: 40, y: 12 }, force: true });
    await tile.locator('[aria-label="More options"]').first().click();
    const menu = page.locator(".cdk-overlay-container [role=menuitem]");
    await menu.filter({ hasText: /download/i }).first().click();
    await menu.filter({ hasText: "1080p" }).first().click();
    report(`Flow is upscaling scene ${s.number} to 1080p (about a minute)…`);
    const result = await Promise.race([
      finished,
      new Promise<{ guid: string; state: string }>((r) => setTimeout(() => r({ guid: "", state: "timeout" }), 10 * 60_000)),
    ]);
    if (result.state !== "completed") {
      throw new Error(result.state === "timeout" ? "Flow's 1080p upscale took too long." : "Flow's 1080p download was cancelled.");
    }
    const hd = path.join(dir, path.basename(original).replace(/\.mp4$/i, "") + "-1080p.mp4");
    fs.renameSync(path.join(dir, result.guid), hd);
    updateProject(p.id, (x) => {
      const sc = x.scenes.find((y) => y.id === s.id);
      if (sc && sc.videoFile === s.videoFile) sc.videoHdFile = path.basename(hd);
    });
    return hd;
  } finally {
    await cdp.send("Browser.setDownloadBehavior", { behavior: "default" }).catch(() => {});
    await cdp.detach().catch(() => {});
    for (let i = 0; i < 3; i++) await page.keyboard.press("Escape").catch(() => {});
  }
}

/** Flow's id for a video: the path in its media URL (flow-content.google/video/<id>). */
function flowVideoId(src: string) {
  return /\/video\/([\w-]+)/.exec(src)?.[1];
}

/**
 * The grid tile for a clip. Found by Flow id when the app recorded one, otherwise by matching the
 * downloaded file's size against each video's size (for clips rendered before ids were recorded).
 * Video tiles only load their video when hovered, and the grid only draws what's near the screen,
 * so it hovers each video tile in turn and scrolls down until the clip turns up.
 */
async function findClipTile(page: Page, flowId: string | undefined, size: number) {
  const videos = page
    .locator("flow-grid-tile-container")
    .filter({ has: page.locator('img[alt="Generated video thumbnail"], video') });
  await page.locator("flow-grid-tile-container").first().waitFor({ timeout: 30_000 });
  // Start from the top: newest clips are first, and an earlier search may have left the grid scrolled down.
  await page.evaluate(() => document.querySelectorAll("*").forEach((e) => e.scrollTop > 0 && (e.scrollTop = 0)));
  await page.waitForTimeout(800);
  const checked = new Set<string>();
  let stalePasses = 0;
  for (let pass = 0; pass < 40 && stalePasses < 3; pass++) {
    let progressed = false;
    for (let i = 0; i < (await videos.count()); i++) {
      const tile = videos.nth(i);
      // Identify a tile by its thumbnail, or by its video when it's already playing one (no thumbnail then).
      const key = await tile.evaluate((t) => {
        const img = t.querySelector("img") as HTMLImageElement | null;
        const vid = t.querySelector("video") as HTMLVideoElement | null;
        return (img?.src || vid?.currentSrc || vid?.src || "").split("?")[0];
      }, undefined, { timeout: 2000 }).catch(() => "");
      if (key && checked.has(key)) continue;
      if (key) checked.add(key);
      progressed = true;
      // A video's thumbnail carries the same id as the video, so a known id needs no hovering.
      if (flowId && key.includes(flowId)) return { tile, id: flowId };
      const src = await hoverForVideo(page, tile);
      const id = flowVideoId(src);
      if (!id) continue;
      checked.add(src.split("?")[0]);
      if (flowId ? id === flowId : await sameSize(src, size)) return { tile, id };
    }
    stalePasses = progressed ? 0 : stalePasses + 1;
    // Scroll the grid's own container by most of a screen (a mouse wheel does nothing in the hidden window).
    const atEnd = await page.evaluate(() => {
      const tile = document.querySelector("flow-grid-tile-container");
      let el = tile?.parentElement ?? null;
      while (el && !(el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
      const box = el ?? document.scrollingElement!;
      const before = box.scrollTop;
      box.scrollTop += box.clientHeight * 0.8;
      return box.scrollTop === before;
    });
    await page.waitForTimeout(1000);
    if (atEnd && !progressed) break;
  }
  throw new Error("Couldn't find this clip in the Flow project. It may have been moved to Flow's Trash.");
}

async function hoverForVideo(page: Page, tile: ReturnType<Page["locator"]>) {
  // Flow's prompt box floats over the bottom of the grid and catches hovers there, so bring the tile up
  // and hover near its top edge (the last row can't scroll to the middle).
  await tile.evaluate((t) => t.scrollIntoView({ block: "center" }), undefined, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(300);
  await tile.hover({ position: { x: 40, y: 12 }, timeout: 3000, force: true }).catch(() => {});
  for (let k = 0; k < 16; k++) {
    const src = await tile
      .locator("video")
      .first()
      .evaluate((v) => (v as HTMLVideoElement).currentSrc || (v as HTMLVideoElement).src || "", undefined, { timeout: 1000 })
      .catch(() => "");
    if (src) return src;
    await page.waitForTimeout(250);
  }
  return "";
}

/** Flow's signed links ignore HEAD and Range, so start a normal download, read its size, and stop. */
async function sameSize(src: string, size: number) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(src, { signal: ac.signal });
    return Number(res.headers.get("content-length")) === size;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}

// ---------------------------------------------------------------- helpers

const pad = (n: number) => String(n).padStart(2, "0");

/** Render file names are unique (timestamped), so the upload name is too: a re-render never reuses a stale upload. */
const upload = (file: string): Attachment => ({ name: `fsph-${path.basename(file)}`, file });

function renderFile(p: Project, file?: string) {
  const full = file && path.join(rendersDir(p.id), file);
  return full && fs.existsSync(full) ? full : undefined;
}

function previous(p: Project, s: Scene) {
  const i = p.scenes.findIndex((x) => x.id === s.id);
  return i > 0 ? p.scenes[i - 1] : undefined;
}

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
      out.push(upload(portrait));
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
  return (await generateMedia(p, report, baseName, req)).file;
}

/** Generate in Flow and download the result; returns the saved file name and Flow's URL for it. */
async function generateMedia(p: Project, report: Report, baseName: string, req: Request) {
  const page = await getFlowPage();
  report("Opening the Flow project…");
  await openProject(page, p);
  await resetComposer(page);

  // Flow remembers attachments separately for each mode and brings them back when you switch, so switch to
  // the final mode first, clear what it remembered, then attach. A clip's start frame goes straight into
  // the Start slot; everything else is a reference added with +.
  const fromFrame = req.kind === "video" && req.videoMode === "frames";
  await configure(page, req);
  await clearAttachments(page);

  const expected: string[] = [];
  for (const [i, a] of req.attachments.entries()) {
    report(fromFrame ? "Setting the start frame…" : `Attaching reference ${i + 1} of ${req.attachments.length}…`);
    expected.push(await attach(page, a, fromFrame ? "start" : "reference"));
  }

  report("Setting up the generation…");
  const credits = await configure(page, req);
  await checkAttachments(page, req, expected);
  const cap = readSettings().maxCreditsPerClip;
  if (credits > cap) {
    await resetComposer(page);
    throw new Error(`Flow quoted ${credits} credits, over your limit of ${cap}. Raise it in Settings to allow this.`);
  }

  await typePrompt(page, req.prompt);
  if (process.env.FSPH_DRY_RUN) {
    report(`Dry run: ${credits} credits, ${(await composerSummary(page)).text}`);
    throw new Error("Dry run: stopped before generating.");
  }
  const before = await mediaSources(page);
  await page.locator('[aria-label="Start generation"]').last().click();
  report(credits ? `Generating in Flow (${credits} credits)…` : "Generating in Flow (free)…");

  const src = await waitForResult(page, before, req.kind, report);
  report("Downloading…");
  const { bytes, ext } = await download(page, src, req.kind);
  const file = `${baseName}-${Date.now().toString(36)}${ext}`;
  fs.writeFileSync(path.join(ensureDir(rendersDir(p.id)), file), bytes);
  return { file, src };
}

/** Flow's id for an image: the path in its media URL (flow-content.google/image/<id> or /asb/<id>). */
function assetId(src: string) {
  return /\/(?:image|asb)\/([\w-]+)/.exec(src)?.[1] ?? "";
}

/** The composer box: the part of the page around the prompt field and its settings chip. */
const composerBox = (page: Page) =>
  composer(page).locator("xpath=ancestor::*[.//*[@aria-label='Settings trigger']][1]");

/** What's attached above the prompt: the asset ids in order (a start frame comes first) and the mode chip. */
async function composerSummary(page: Page) {
  const ids = await composerBox(page)
    .locator("img")
    .evaluateAll((imgs) =>
      imgs.filter((i) => i.getBoundingClientRect().width > 20).map((i) => (i as HTMLImageElement).currentSrc || (i as HTMLImageElement).src),
    )
    .then((srcs) => srcs.map(assetId));
  const startEmpty = await page.getByRole("button", { name: "Start", exact: true }).isVisible().catch(() => false);
  const framesMode = await page.locator('[aria-label="Swap first and last frames"]').last().isVisible().catch(() => false);
  const startFilled = framesMode && !startEmpty;
  const mode = (await page.locator('[aria-label="Settings trigger"]').last().innerText().catch(() => "")).replace(/\s+/g, " ");
  return { ids, startFilled, mode, text: `${mode}; start frame: ${startFilled ? "yes" : "no"}; attached: ${ids.length}` };
}

/** Make sure Flow holds exactly the images this request chose, the right way round, before any credits are spent. */
async function checkAttachments(page: Page, req: Request, expected: string[]) {
  const s = await composerSummary(page);
  const known = expected.every(Boolean);
  const same = s.ids.length === expected.length && (!known || expected.every((id) => s.ids.includes(id)));
  if (req.kind === "video" && req.videoMode === "frames") {
    if (!s.startFilled || !same || (known && s.ids[0] !== expected[0])) {
      throw new Error("Flow didn't take the right image as the clip's start frame, so nothing was generated. Try again.");
    }
  } else if (!same || (req.kind === "video" && s.startFilled)) {
    throw new Error("Flow didn't hold exactly the references this shot needs, so nothing was generated. Try again.");
  }
}

/** Remove every start/end frame and reference Flow is still holding in the current mode. */
async function clearAttachments(page: Page) {
  const remove = composerBox(page).locator('[aria-label="Image ingredient"], [aria-label="Ingredient"]');
  for (let i = 0; i < 10 && (await remove.count()) > 0; i++) {
    await remove.first().click().catch(() => {});
    await page.waitForTimeout(400);
  }
}

/** Each app project gets its own Flow project, created on first use and remembered. */
export async function openProject(page: Page, p: Project) {
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

export async function resetComposer(page: Page) {
  await page.keyboard.press("Escape");
  // Flow's agent chat (used for storyboards) takes over the composer while its panel is open; close it.
  const panelClose = page.locator('flow-agent-panel [aria-label="Close"]').first();
  if (await panelClose.isVisible().catch(() => false)) {
    await panelClose.click();
    await page.waitForTimeout(600);
  }
  const clear = page.locator('[aria-label="Clear prompt"]').last();
  if (await clear.isVisible().catch(() => false)) await clear.click();
  // Direct mode, not Flow's chat agent: the app sets every option itself.
  const agent = page.getByRole("button", { name: "Agent", exact: true }).last();
  if ((await agent.getAttribute("aria-pressed").catch(() => null)) === "true") await agent.click();
  await page.waitForTimeout(500);
}

/** Open the asset picker: from the Start slot for a start frame, or from + for a reference. */
async function openPicker(page: Page, slot: "start" | "reference") {
  const upload = page.getByRole("button", { name: "Upload media" });
  if (await upload.isVisible().catch(() => false)) await page.keyboard.press("Escape");
  if (slot === "start") await page.getByRole("button", { name: "Start", exact: true }).click({ timeout: 15_000 });
  else await page.locator('[aria-label="Add ingredients to the prompt box"]').last().click({ timeout: 15_000 });
  await upload.waitFor({ timeout: 15_000 });
}

/**
 * Find the asset by its unique name in the picker, uploading it the first time, and pick it.
 * Returns Flow's id for it, so checkAttachments() can confirm Flow is holding this exact image.
 */
async function attach(page: Page, a: Attachment, slot: "start" | "reference") {
  await openPicker(page, slot);
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
  await waitUntil(async () => Boolean(assetId((await option().locator("img").first().getAttribute("src")) ?? "")), 30_000, "Upload took too long.");
  const id = assetId((await option().locator("img").first().getAttribute("src")) ?? "");
  await option().click();
  await page.waitForTimeout(800);
  // The reference picker attaches on click; the frame picker selects and waits for "Add to prompt".
  const add = page.getByText("Add to prompt", { exact: true });
  if (await page.getByRole("button", { name: "Upload media" }).isVisible().catch(() => false)) {
    if (await add.isVisible().catch(() => false)) await add.click();
    await page.waitForTimeout(800);
  }
  if (await page.getByRole("button", { name: "Upload media" }).isVisible().catch(() => false)) await page.keyboard.press("Escape");
  return id;
}

function mimeOf(file: string) {
  const ext = path.extname(file).toLowerCase();
  return ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
}

/** Set type, mode, aspect, length, resolution and count; returns Flow's own credit quote. */
async function configure(
  page: Page,
  req: Pick<Request, "kind"> & Partial<Pick<Request, "aspect" | "durationSec" | "videoMode">>,
): Promise<number> {
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
  if (req.aspect) await pick(req.aspect);
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
