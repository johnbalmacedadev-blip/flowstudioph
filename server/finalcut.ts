import fs from "node:fs";
import path from "node:path";
import type { CutItem, ExportFile, ExportResolution, FinalCut } from "../shared/types.js";
import { upscaleClip } from "./flow/driver.js";
import { probe, renderCut, type Segment } from "./media.js";
import { ensureDir, exportsDir, rendersDir } from "./paths.js";
import { getProject, newId, updateProject } from "./store.js";

type Report = (progress: string) => void;

const SIZES: Record<ExportResolution, [number, number]> = {
  "720p": [1280, 720],
  "1080p": [1920, 1080],
  "4k": [3840, 2160],
};

/**
 * Bring the timeline in line with the storyboard: every scene with a clip is on it (new ones are added in
 * scene order), a re-rendered clip replaces the old one with its trim reset, and clips whose scene is gone
 * drop off. Your order, trims and removals are kept.
 */
export async function syncFinalCut(projectId: string): Promise<FinalCut> {
  const p = getProject(projectId);
  const cut: FinalCut = structuredClone(p.finalCut ?? { items: [], removed: [] });
  const clips = new Map(
    p.scenes.filter((s) => s.videoFile && fs.existsSync(path.join(rendersDir(p.id), s.videoFile))).map((s) => [s.id, s.videoFile!]),
  );

  const refresh = async (item: CutItem): Promise<CutItem | null> => {
    const file = clips.get(item.sceneId);
    if (!file) return null;
    if (file === item.file && item.duration > 0) return item;
    const { duration } = await probe(path.join(rendersDir(p.id), file));
    return { ...item, file, duration, inSec: 0, outSec: duration };
  };
  cut.items = (await Promise.all(cut.items.map(refresh))).filter((x): x is CutItem => !!x);
  cut.removed = (await Promise.all(cut.removed.map(refresh))).filter((x): x is CutItem => !!x);

  const known = new Set([...cut.items, ...cut.removed].map((i) => i.sceneId));
  for (const s of p.scenes) {
    const file = clips.get(s.id);
    if (!file || known.has(s.id)) continue;
    const { duration } = await probe(path.join(rendersDir(p.id), file));
    const item: CutItem = { id: newId(), sceneId: s.id, file, duration, inSec: 0, outSec: duration };
    // Put it after the nearest earlier scene that's already on the timeline, so story order is kept.
    const order = p.scenes.map((x) => x.id);
    const before = cut.items.findLastIndex((i) => order.indexOf(i.sceneId) < order.indexOf(s.id));
    cut.items.splice(before + 1, 0, item);
  }

  if (JSON.stringify(cut) !== JSON.stringify(p.finalCut)) updateProject(p.id, (x) => (x.finalCut = cut));
  return cut;
}

/**
 * Save an edited timeline. Only clips that are really this project's are kept; trims are clamped. A new piece
 * (from splitting a clip) is kept when it's a part of a clip already on the timeline.
 */
export function saveFinalCut(projectId: string, input: FinalCut): FinalCut {
  const p = getProject(projectId);
  const before = [...(p.finalCut?.items ?? []), ...(p.finalCut?.removed ?? [])];
  const all = new Map(before.map((i) => [i.id, i]));
  const byClip = new Map(before.map((i) => [`${i.sceneId}|${i.file}`, i]));
  const used = new Set<string>();
  const clean = (list: unknown): CutItem[] =>
    (Array.isArray(list) ? list : []).flatMap((raw: Partial<CutItem>) => {
      let known = raw?.id ? all.get(raw.id) : undefined;
      if (!known && typeof raw?.id === "string" && /^[a-z0-9-]{4,40}$/i.test(raw.id) && !used.has(raw.id)) {
        const source = byClip.get(`${raw.sceneId}|${raw.file}`);
        if (source) known = { ...source, id: raw.id };
      }
      if (!known || used.has(known.id)) return [];
      used.add(known.id);
      const inSec = clamp(Number(raw.inSec), 0, known.duration - 0.5);
      const outSec = clamp(Number(raw.outSec), inSec + 0.5, known.duration);
      all.delete(known.id);
      return [{ ...known, inSec: round(inSec), outSec: round(outSec) }];
    });
  const cut: FinalCut = { items: clean(input.items), removed: [] };
  cut.removed = clean(input.removed);
  // Anything left out goes to Removed, never lost, unless it's a piece another clip already covers (an undone split).
  const kept = [...cut.items, ...cut.removed];
  const covered = (x: CutItem) =>
    kept.some((k) => k.sceneId === x.sceneId && k.file === x.file && k.inSec <= x.inSec + 0.01 && k.outSec >= x.outSec - 0.01);
  cut.removed.push(...[...all.values()].filter((x) => !covered(x)));
  updateProject(projectId, (x) => (x.finalCut = cut));
  return cut;
}

/** Start over from the storyboard: every clip, in scene order, untrimmed. */
export async function resetFinalCut(projectId: string) {
  updateProject(projectId, (x) => (x.finalCut = { items: [], removed: [] }));
  return syncFinalCut(projectId);
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Join the timeline into one MP4. 1080p and 4K use Flow's own 1080p AI upscale of each clip (fetched once
 * and reused); 4K is then enlarged from that. A clip that can't be upscaled falls back to its original.
 */
export async function exportFinalCut(projectId: string, resolution: ExportResolution, report: Report) {
  const cut = await syncFinalCut(projectId);
  if (!cut.items.length) throw new Error("The timeline is empty. Render some clips first.");
  const p = getProject(projectId);
  const notes: string[] = [];

  const segments: Segment[] = [];
  for (const [i, item] of cut.items.entries()) {
    const s = p.scenes.find((x) => x.id === item.sceneId)!;
    let file = path.join(rendersDir(p.id), item.file);
    if (resolution !== "720p") {
      report(`Getting the 1080p version of clip ${i + 1} of ${cut.items.length}…`);
      try {
        file = await upscaleClip(getProject(projectId), s.id, report);
      } catch (e) {
        notes.push(`scene ${s.number} used its 720p original (${(e as Error).message})`);
      }
    }
    const { duration } = await probe(file);
    segments.push({ file, inSec: Math.min(item.inSec, duration - 0.1), outSec: Math.min(item.outSec, duration) });
  }

  const [w, h] = SIZES[resolution];
  const [width, height] = p.settings.aspectRatio === "9:16" ? [h, w] : [w, h];
  const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "film";
  const name = `${slug}-${resolution}-${Date.now().toString(36)}.mp4`;
  const out = path.join(ensureDir(exportsDir(p.id)), name);

  report("Exporting… 0%");
  await renderCut(segments, out, width, height, (f) => report(`Exporting… ${Math.round(f * 100)}%`));

  const meta = await probe(out);
  const record: ExportFile = {
    file: name,
    resolution,
    width,
    height,
    duration: meta.duration,
    sizeBytes: fs.statSync(out).size,
    createdAt: new Date().toISOString(),
  };
  updateProject(projectId, (x) => (x.exports = [record, ...(x.exports ?? [])]));
  report(notes.length ? `Done. Note: ${notes.join("; ")}.` : `Done: ${width}×${height}, ${meta.duration.toFixed(1)}s.`);
  return record;
}

export function deleteExport(projectId: string, file: string) {
  updateProject(projectId, (x) => {
    if (!x.exports?.some((e) => e.file === file)) return;
    fs.rmSync(path.join(exportsDir(projectId), path.basename(file)), { force: true });
    x.exports = x.exports.filter((e) => e.file !== file);
  });
}

