import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import { chosenRefKeys, exactKeys, MAX_REFS, pinExtraKeys, pinFrameKey, sceneProducts } from "../../shared/attachments.js";
import type { Character, Product, Project, Scene } from "../../shared/types.js";
import { exactFrame, lastFrame } from "../media.js";
import { ensureDir, refsDir, rendersDir } from "../paths.js";
import { readSettings } from "../settings.js";
import { getProject, updateProject } from "../store.js";
import { removeProductMentions } from "../storyboard.js";
import { flowAccount, getBrowser, getFlowPage } from "./browser.js";

type Report = (progress: string) => void;

const FLOW_HOME = "https://flow.google.com/?hl=en";
const IMAGE_TIMEOUT_MS = 4 * 60_000;
const VIDEO_TIMEOUT_MS = 12 * 60_000;

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
  /** Frames mode only: the clip's end frame. */
  endFrame?: Attachment;
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

/** A clean product shot from its photos, to check Flow keeps the packaging, label and logo right. */
export async function renderProductShot(p: Project, productId: string, report: Report) {
  const x = (p.products ?? []).find((y) => y.id === productId);
  if (!x) throw new Error("Product not found");
  const prompt = [
    `Product photo of ${x.name}: ${x.visualPrompt || x.description}.`,
    "Centred on a clean neutral surface, soft even light, the label facing the camera, sharp focus, no text added.",
    productLock([x]),
  ].join(" ");
  return generate(p, report, `product-${x.id}`, {
    kind: "image",
    prompt,
    aspect: p.settings.aspectRatio,
    attachments: productRefs(p, [x]),
  });
}

const CONTINUE_FRAME =
  "Continue the exact same scene as the first reference image: same location, set, props, lighting, time of day and wardrobe, as the next moment of the same shot.";

/**
 * The clip prompt with the scene's Dialogue as the spoken line. Storyboards write the line into the prompt too
 * ("Maya says: '…'"), and that copy goes stale when you edit the Dialogue, so any quoted speech in the prompt
 * is taken out and the current Dialogue put in, to be said word for word.
 */
export function clipPrompt(s: Scene): string {
  const base = (s.videoPrompt || s.action).trim();
  const line = s.dialogue.trim();
  if (!line) return base;
  // A sentence like "He says in Tagalog: '<line>'" (or "…"); the closing quote is followed by punctuation, a
  // space or the end, so apostrophes inside the line ("'to", "Maya's") don't end it.
  const speech =
    /[^.!?]*\b(?:say|says|said|saying|ask|asks|asked|exclaim|exclaims|whisper|whispers|tell|tells|speak|speaks|reply|replies|shout|shouts|add|adds)\b[^.!?'"“‘]*?[:,]?\s*['"“‘][\s\S]+?['"”’](?=[\s.,!?]|$)[.!?]?/gi;
  const cleaned = base.replace(speech, " ").replace(/\s{2,}/g, " ").trim();
  // The Dialogue field may start with the speaker ("Host: …") and carry its own quotes.
  const spoken = line.replace(/^[\p{L} .'-]{1,30}:\s*/u, "").replace(/^["“'‘]+|["”'’]+$/g, "").trim();
  return `${cleaned} Spoken line, said word for word and nothing else: "${spoken}"`;
}

const PIN_FRAME =
  "Edit the first reference image, don't redraw it: keep the same place, camera framing and lighting, each person's face, hair, clothes and look, and every object already there (everything on the table or counter stays where it is). Only change what this shot's action needs, and add what the other reference images show. Other images of a person only show who they are: keep the hair and clothes from the first image. Keep any product's packaging, label text and logo exactly as photographed.";

/**
 * A pinned scene's frame. The start image alone is used exactly (nothing generated). With images added to it,
 * Flow redraws it with those in it, the start image leading the references. For a clip (reuse = true) a
 * frame already made from the same images is reused.
 */
async function pinnedFrame(p: Project, s: Scene, report: Report, reuse = false): Promise<string> {
  // (Used as the scene's frame, and as a clip's end frame when images were added to a pinned start.)
  const key = pinFrameKey(p, s);
  const current = renderFile(p, s.imageFile);
  if (reuse && current && s.frameKey === key) return current;
  const added = pinExtraKeys(p, s);
  let file: string;
  if (!added.length) {
    report("Using your exact image as the frame…");
    file = await makeExactFrame(p, s, exactKeys(s)[0], "start");
  } else {
    report("Adding the product and ticked images to your start image…");
    const exact = await makeExactFrame(p, s, exactKeys(s)[0], "start");
    const name = await generate(p, report, `scene-${pad(s.number)}-frame`, {
      kind: "image",
      // Just the action, not the frame prompt: that describes a whole new picture, and Flow would redraw the set.
      prompt: `${PIN_FRAME} ${withLocks(p, s.action.trim() ? "" : s.imagePrompt, sceneProducts(p, s), s)} ${NO_TEXT}`,
      aspect: p.settings.aspectRatio,
      attachments: [upload(exact), ...(await sceneAttachments(p, s, added))].slice(0, MAX_REFS),
    });
    file = path.join(rendersDir(p.id), name);
  }
  updateProject(p.id, (x) => {
    const sc = x.scenes.find((y) => y.id === s.id);
    if (sc) Object.assign(sc, { frameKey: key, imageFile: path.basename(file), imageStatus: "done" });
  });
  return file;
}

/**
 * A seamless scene's start frame with its products in it: the previous clip's last frame leads the references,
 * followed by the scene's own images (product photos first). It becomes the scene's frame too.
 */
async function bridgeFrame(p: Project, s: Scene, last: string, report: Report) {
  report("Putting the product into the start frame…");
  const products = sceneProducts(p, s);
  const own = new Set(products.flatMap((x) => x.referenceIds.map((id) => `ref:${id}`)));
  const keys = chosenRefKeys(p, s, true).filter((k) => !k.startsWith("prev-"));
  keys.sort((a, b) => Number(own.has(b)) - Number(own.has(a)));
  const refs = await sceneAttachments(p, s, keys);
  if (!refs.some((a) => products.some((x) => x.referenceIds.some((id) => a.name.startsWith(`fsph-${id}`))))) {
    refs.unshift(...productRefs(p, products).slice(0, 1));
  }
  const file = await generate(p, report, `scene-${pad(s.number)}-frame`, {
    kind: "image",
    prompt: `${CONTINUE_FRAME} ${withLocks(p, s.imagePrompt || s.action, products, s)} ${NO_TEXT}`,
    aspect: p.settings.aspectRatio,
    attachments: [upload(last), ...refs].slice(0, MAX_REFS),
  });
  updateProject(p.id, (x) => {
    const sc = x.scenes.find((y) => y.id === s.id);
    if (sc) Object.assign(sc, { imageFile: file, imageStatus: "done" });
  });
  return path.join(rendersDir(p.id), file);
}

export async function renderSceneImage(p: Project, sceneId: string, report: Report) {
  const s = scene(p, sceneId);
  const pins = exactKeys(s);
  if (pins.length) return path.basename(await pinnedFrame(p, s, report));
  const keys = chosenRefKeys(p, s, true);
  if (s.continuesPrevious && !keys.includes("prev-frame") && !s.refOverride) {
    report("No frame for the previous scene yet; matching the cast only.");
  }
  const products = sceneProducts(p, s);
  // The previous frame leads the references, and the prompt says to carry its set and light over.
  const base = keys.includes("prev-frame") ? `${CONTINUE_FRAME} ${s.imagePrompt || s.action}` : s.imagePrompt || s.action;
  return generate(p, report, `scene-${pad(s.number)}-frame`, {
    kind: "image",
    prompt: `${withLocks(p, base, products, s)} ${NO_TEXT}`,
    aspect: p.settings.aspectRatio,
    attachments: await sceneAttachments(p, s, keys),
  });
}

/**
 * Where a clip starts: a continuing scene picks up on the last frame of the previous clip (a seamless cut);
 * otherwise the scene's own frame; otherwise Flow works from the cast as references.
 */
export async function renderSceneVideo(p: Project, sceneId: string, report: Report) {
  const s = scene(p, sceneId);
  let start: string | undefined;
  let end: string | undefined;
  const pins = exactKeys(s);
  if (s.continuesPrevious && !pins.length) {
    const prevClip = renderFile(p, previous(p, s)?.videoFile);
    if (prevClip) {
      report("Taking the last frame of the previous clip…");
      start = await lastFrame(prevClip);
      // A clip from a start frame gets no other images, so a product missing from that frame would be invented
      // from the prompt. Bring the product in first: a new frame that continues the last one, with its photos.
      if (sceneProducts(p, s).length) start = await bridgeFrame(p, s, start, report);
    } else {
      report("The previous scene has no clip yet, so this one can't pick up from it; using its own frame.");
    }
  }
  // Pinned exact images win over everything: the clip starts (and maybe ends) on the images themselves.
  if (pins.length) {
    report(pins.length > 1 ? "Setting your exact start and end images…" : "Starting the clip on your exact image…");
    start = await makeExactFrame(p, s, pins[0], "start");
    if (pins[1]) end = await makeExactFrame(p, s, pins[1], "end");
    // Images added to the start (a product, say) can't go into a clip that starts from a frame, so they make
    // the frame the clip moves to: the start image with them in it.
    else if (pinExtraKeys(p, s).length) end = await pinnedFrame(p, s, report, true);
  }
  start ??= renderFile(p, s.imageFile);
  // From a start frame the product is already in the picture; without one, the scene's chosen images go in.
  const products = sceneProducts(p, s);
  const refs = await sceneAttachments(p, s, chosenRefKeys(p, s, false));
  const { file, src } = await generateMedia(p, report, `scene-${pad(s.number)}-clip`, {
    kind: "video",
    prompt: pins.length
      ? `${end ? EXACT_START_END : EXACT_START} ${withLocks(p, clipPrompt(s), products, s)}`
      : withLocks(p, clipPrompt(s), products, s),
    aspect: p.settings.aspectRatio,
    durationSec: s.durationSec,
    videoMode: start ? "frames" : "ingredients",
    attachments: start ? [upload(start)] : refs,
    endFrame: start && end ? upload(end) : undefined,
  });
  updateProject(p.id, (x) => {
    const sc = x.scenes.find((y) => y.id === s.id);
    if (sc) Object.assign(sc, { videoFlowId: flowVideoId(src), videoHdFile: undefined });
  });
  return file;
}

/**
 * The Google Flow credits left and when they reset, from Flow's account panel (opened if needed, then closed
 * with its ✕: Escape doesn't close it, and an open panel covers the account button).
 */
export async function readCredits(): Promise<{ credits?: number; resets?: string }> {
  const page = await getFlowPage();
  const text = page.getByText(/[\d,]+\s+Google Flow credits/i).first();
  if (!(await text.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Account details", exact: true }).first().click({ timeout: 10_000 });
  }
  try {
    await text.waitFor({ timeout: 8_000 });
    const m = /([\d,]+)\s+Google Flow credits/i.exec((await text.textContent()) ?? "");
    const resets = (await page.getByText(/^\s*Resets\s/i).first().textContent({ timeout: 2_000 }).catch(() => null))?.trim();
    return { credits: m ? Number(m[1].replace(/,/g, "")) : undefined, resets: resets || undefined };
  } finally {
    // The panel's own close button: the nearest "close" button around the credits line.
    const closed = await text
      .evaluate((el) => {
        for (let n: Element | null = el; n; n = n.parentElement) {
          const btn = [...n.querySelectorAll("button, [role=button]")].find((b) =>
            /close/i.test(`${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`),
          ) as HTMLElement | undefined;
          if (btn) return btn.click(), true;
        }
        return false;
      })
      .catch(() => false);
    if (!closed) await page.keyboard.press("Escape").catch(() => {});
  }
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

  report(`Flow is upscaling scene ${s.number} to 1080p (about a minute)…`);
  const hd = path.join(ensureDir(rendersDir(p.id)), path.basename(original).replace(/\.mp4$/i, "") + "-1080p.mp4");
  await downloadFromMenu(page, tile, "1080p", hd, 10 * 60_000);
  updateProject(p.id, (x) => {
    const sc = x.scenes.find((y) => y.id === s.id);
    if (sc && sc.videoFile === s.videoFile) sc.videoHdFile = path.basename(hd);
  });
  return hd;
}

/**
 * Save a tile's media with Flow's own Download menu (option "720p" = original size, "1080p" = Flow's upscale).
 * Chrome saves into the target folder under a temporary name and reports when it's done.
 */
export async function downloadFromMenu(page: Page, tile: Locator, option: string, target: string, timeoutMs: number) {
  const dir = path.dirname(target);
  const cdp = await (await getBrowser()).newBrowserCDPSession();
  try {
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: dir, eventsEnabled: true });
    const finished = new Promise<{ guid: string; state: string }>((resolve) =>
      cdp.on("Browser.downloadProgress", (e: { guid: string; state: string }) => {
        if (e.state !== "inProgress") resolve(e);
      }),
    );
    for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
    await tile.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await tile.hover({ position: { x: 40, y: 12 }, force: true });
    await tile.locator('[aria-label="More options"]').first().click();
    const menu = page.locator(".cdk-overlay-container [role=menuitem]");
    await menu.filter({ hasText: /download/i }).first().click();
    await menu.filter({ hasText: option }).first().click();
    const result = await Promise.race([
      finished,
      new Promise<{ guid: string; state: string }>((r) => setTimeout(() => r({ guid: "", state: "timeout" }), timeoutMs)),
    ]);
    if (result.state !== "completed") {
      throw new Error(result.state === "timeout" ? "Flow's download took too long." : "Flow's download was cancelled.");
    }
    fs.renameSync(path.join(dir, result.guid), target);
  } finally {
    await cdp.send("Browser.setDownloadBehavior", { behavior: "default" }).catch(() => {});
    await cdp.detach().catch(() => {});
    for (let i = 0; i < 3; i++) await page.keyboard.press("Escape").catch(() => {});
  }
}

/**
 * Flow's id for a video, from its media URL: flow-content.google/video/<uuid>, or flow.google.com/asb/<token>
 * (the asb token stays the same across page loads).
 */
function flowVideoId(src: string) {
  return /\/video\/([\w-]+)/.exec(src)?.[1] ?? /\/asb\/([^?=/]+)/.exec(src)?.[1];
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
      if (flowId ? id === flowId : await sameSize(page, src, size)) return { tile, id };
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
async function sameSize(page: Page, src: string, size: number) {
  if (src.includes("/asb/")) {
    // These need the signed-in browser; Flow's streaming copy isn't the original file, so sizes can't match.
    return false;
  }
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

/** Products in a scene: the ones it lists, plus every locked product. */
/** The files behind a scene's chosen image keys (see shared/attachments.ts); missing files are skipped. */
async function sceneAttachments(p: Project, s: Scene, keys: string[]): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const key of keys) {
    const file = await keyFile(p, s, key);
    if (!file) continue;
    // References keep their own upload name, so one already in Flow is reused.
    const ref = key.startsWith("ref:") ? p.references.find((x) => x.id === key.slice(4)) : undefined;
    out.push(ref ? { name: `fsph-${ref.id}${path.extname(ref.file)}`, file } : upload(file));
  }
  return out.slice(0, MAX_REFS);
}

/** The file on disk behind an image key, if it exists. */
async function keyFile(p: Project, s: Scene, key: string): Promise<string | undefined> {
  const [kind, id] = key.split(":");
  if (kind === "prev-last") {
    const clip = renderFile(p, previous(p, s)?.videoFile);
    return clip ? lastFrame(clip) : undefined;
  }
  if (kind === "ref") {
    const r = p.references.find((x) => x.id === id);
    const file = r && path.join(refsDir(p.id), r.file);
    return file && fs.existsSync(file) ? file : undefined;
  }
  return kind === "prev-frame" ? renderFile(p, previous(p, s)?.imageFile)
    : kind === "portrait" ? renderFile(p, p.characters.find((c) => c.id === id)?.portraitFile)
    : kind === "product-shot" ? renderFile(p, p.products?.find((x) => x.id === id)?.shotFile)
    : undefined;
}

const EXACT_START_END =
  "The clip starts on the exact image in the start frame and ends on the exact image in the end frame; move naturally from one to the other. Keep both images, especially any product packaging, label text and logo, exactly as they are: do not redraw or redesign them.";

const EXACT_START =
  "The clip starts on the exact photo in the start frame. Keep everything in it, especially the product's packaging, label text and logo, exactly as it is: do not redraw or redesign it. Animate gently.";

/** The scene's pinned image as an exact frame at the video's size (see exactFrame in media.ts). */
async function makeExactFrame(p: Project, s: Scene, key: string, which: "start" | "end") {
  const photo = await keyFile(p, s, key);
  if (!photo) throw new Error(`The image pinned as this scene's exact ${which} is missing. Pick another one.`);
  const [w, h] = p.settings.aspectRatio === "9:16" ? [1080, 1920] : [1920, 1080];
  const name = which === "start" ? "frame-exact" : "end-exact";
  const out = path.join(ensureDir(rendersDir(p.id)), `scene-${pad(s.number)}-${name}-${Date.now().toString(36)}.jpg`);
  return exactFrame(photo, out, w, h);
}

/** Up to two photos per product, so a product never crowds the cast out of Flow's three references. */
function productRefs(p: Project, products: Product[]): Attachment[] {
  return products
    .flatMap((x) => p.references.filter((r) => x.referenceIds.includes(r.id)).slice(0, 2))
    .map((r) => ({ name: `fsph-${r.id}${path.extname(r.file)}`, file: path.join(refsDir(p.id), r.file) }))
    .filter((a) => fs.existsSync(a.file));
}

function productLock(products: Product[]) {
  return products
    .map(
      (x) =>
        `Product: ${x.name}${x.visualPrompt ? `, ${x.visualPrompt}` : ""}. Show this exact product exactly as in its reference photo: same packaging shape, colours, label text and logo, unchanged, clearly visible, label facing the camera. If any text describes the product differently (a tub, jar, can, bottle or other colours), ignore that and follow the photo.`,
    )
    .join(" ");
}

const UGC_LOOK =
  "Authentic UGC look: smartphone footage, handheld, natural window or home light, a real person in a real everyday setting, no studio lighting or cinematic colour grading.";

/** Added at render time, so they hold even after you edit a scene's prompt by hand. */
/** Stills are frames of a clip: spoken lines in the prompt must not turn into burned-in subtitles. */
const NO_TEXT = "A still frame: no subtitles, captions or on-screen text (only text printed on real objects, like the product label).";

const LOOK_RULE =
  "Every person looks exactly like their reference image: same face, hair, hairstyle and clothes. If the text describes their hair or clothes differently, follow the image.";

/** The scene's Action, first: it's what you last wrote, so it wins over an older, longer description. */
function actionLead(s: Scene) {
  const action = s.action.trim().replace(/\s+/g, " ");
  return action ? `What happens in this shot: ${action.replace(/[.\s]+$/, "")}. Where the description below differs (what they do, props, cups or containers), follow this.` : "";
}

/** "<product> (a sleek tub with …)" → "<product>": a product with photos is shown by its photo, not a description. */
function dropProductLooks(p: Project, prompt: string) {
  let out = prompt;
  for (const x of p.products ?? []) {
    if (!x.referenceIds.length && !x.shotFile) continue;
    const name = x.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(${name})\\s*\\([^)]*\\)`, "gi"), "$1");
  }
  return out;
}

function withLocks(p: Project, prompt: string, products: Product[], s?: Scene) {
  prompt = dropProductLooks(p, prompt);
  // Products this scene leaves out: drop the sentences that describe them (a storyboard written while they were
  // locked still mentions them) and say plainly not to show them.
  const leftOut = (p.products ?? []).filter((x) => !products.some((y) => y.id === x.id));
  const names = leftOut.map((x) => x.name);
  const keepOut = !leftOut.length
    ? ""
    : products.length
      ? `Do not show ${names.join(" or ")}.`
      : `Do not show ${names.join(", ")} or any other product, packaging, jar, box, sachet or brand label.`;
  const people = s && s.characterIds.length ? LOOK_RULE : "";
  return [s ? actionLead(s) : "", removeProductMentions(prompt, names), people, productLock(products), keepOut, p.settings.videoStyle === "ugc" ? UGC_LOOK : ""]
    .filter(Boolean)
    .join(" ");
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
  return out.filter((a) => fs.existsSync(a.file)).slice(0, MAX_REFS);
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

  const attachAll = async () => {
    const ids: string[] = [];
    for (const [i, a] of req.attachments.entries()) {
      report(fromFrame ? "Setting the start frame…" : `Attaching reference ${i + 1} of ${req.attachments.length}…`);
      ids.push(await attach(page, a, fromFrame ? "start" : "reference"));
    }
    if (fromFrame && req.endFrame) {
      report("Setting the end frame…");
      ids.push(await attach(page, req.endFrame, "end"));
    }
    return ids;
  };
  let expected = await attachAll();

  report("Setting up the generation…");
  const credits = await configure(page, req);
  try {
    await checkAttachments(page, req, expected);
  } catch {
    // Usually a fresh upload Flow is still processing: clear, wait a moment and attach once more.
    report("Re-attaching references…");
    await clearAttachments(page);
    await page.waitForTimeout(3000);
    expected = await attachAll();
    await configure(page, req);
    await checkAttachments(page, req, expected);
  }
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
  const dir = ensureDir(rendersDir(p.id));
  if (req.kind === "video" && src.includes("/asb/")) {
    // This kind of link only plays inside Flow (and in reduced quality), so use Flow's own Download menu.
    const file = `${baseName}-${Date.now().toString(36)}.mp4`;
    const tile = page.locator("flow-grid-tile-container").filter({ has: page.locator(`video[src="${src}"], source[src="${src}"]`) }).first();
    const target = (await tile.count()) ? tile : page.locator("flow-grid-tile-container").first();
    await downloadFromMenu(page, target, "720p", path.join(dir, file), 3 * 60_000);
    return { file, src };
  }
  const { bytes, ext } = await download(page, src, req.kind);
  const file = `${baseName}-${Date.now().toString(36)}${ext}`;
  fs.writeFileSync(path.join(dir, file), bytes);
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

/**
 * Each app project gets its own Flow project, created on first use and remembered, one per Google account:
 * after switching accounts a project gets a new Flow project (and its old one back if you switch back).
 */
export async function openProject(page: Page, p: Project) {
  const email = (await flowAccount(page))?.email;
  const stored = getProject(p.id);
  let saved = stored.flowProjectUrl;
  if (saved && email && stored.flowAccount && stored.flowAccount !== email) {
    // Made under another account: keep it for later, use this account's own (if any).
    const other = stored.flowAccount;
    const mine = stored.flowProjects?.[email];
    updateProject(p.id, (x) => {
      x.flowProjects = { ...x.flowProjects, [other]: saved! };
      delete x.flowProjects[email];
      x.flowProjectUrl = mine;
      x.flowAccount = mine ? email : undefined;
    });
    saved = mine;
  }
  if (saved) {
    if (!page.url().startsWith(saved)) await page.goto(`${saved}?hl=en`, { waitUntil: "domcontentloaded" });
    // An older project with no account noted may belong to an account you've switched away from.
    if (!stored.flowAccount && !(await composer(page).waitFor({ timeout: 30_000 }).then(() => true, () => false))) {
      updateProject(p.id, (x) => (x.flowProjectUrl = undefined));
      return openProject(page, p);
    }
    if (email && !getProject(p.id).flowAccount) updateProject(p.id, (x) => (x.flowAccount = email));
  } else {
    await page.goto(FLOW_HOME, { waitUntil: "domcontentloaded" });
    await page.getByText("New project", { exact: true }).first().click({ timeout: 30_000 });
    await page.waitForURL(/\/project\//, { timeout: 30_000 });
    const title = page.locator('input[aria-label="Editable text"]').first();
    await title.waitFor({ timeout: 30_000 });
    await title.fill(`Flow Studio PH · ${p.name}`.slice(0, 80));
    await title.press("Enter");
    const url = page.url().split("?")[0];
    updateProject(p.id, (x) => Object.assign(x, { flowProjectUrl: url, flowAccount: email }));
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
async function openPicker(page: Page, slot: "start" | "end" | "reference") {
  const upload = page.getByRole("button", { name: "Upload media" });
  if (await upload.isVisible().catch(() => false)) await page.keyboard.press("Escape");
  if (slot === "start") await page.getByRole("button", { name: "Start", exact: true }).click({ timeout: 15_000 });
  else if (slot === "end") await page.getByRole("button", { name: "End", exact: true }).click({ timeout: 15_000 });
  else await page.locator('[aria-label="Add ingredients to the prompt box"]').last().click({ timeout: 15_000 });
  await upload.waitFor({ timeout: 15_000 });
}

/**
 * Find the asset by its unique name in the picker, uploading it the first time, and pick it.
 * Returns Flow's id for it, so checkAttachments() can confirm Flow is holding this exact image.
 */
async function attach(page: Page, a: Attachment, slot: "start" | "end" | "reference") {
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
