// Which images a scene sends to Flow. Shared by the renderer and the UI, so the ticks a scene shows are
// exactly what gets attached.
import type { Product, Project, Scene } from "./types.js";

/** Flow takes at most three reference images per generation. */
export const MAX_REFS = 3;

/**
 * An image a scene can send to Flow, by key:
 *   ref:<referenceId>        an uploaded reference (product photo, character photo, place, style…)
 *   portrait:<characterId>   a character's rendered portrait
 *   product-shot:<productId> a product's rendered product shot
 *   prev-frame               the previous scene's frame (keeps a seamless scene's set and light)
 *   prev-last                the last frame of the previous scene's clip (pin it to start exactly there)
 */
export interface RefOption {
  key: string;
  label: string;
  group: "Continuity" | "Product" | "Character" | "Reference";
  folder: "refs" | "renders";
  file: string;
  /** The product or character the image belongs to, if any. */
  ownerId?: string;
}

/** Every image this scene could send, in the order they're offered (minus any removed from this scene). */
export function refOptions(p: Project, s: Scene): RefOption[] {
  const hidden = new Set(s.hiddenRefKeys ?? []);
  return allRefOptions(p, s).filter((o) => !hidden.has(o.key));
}

/** Images removed from this scene's list, so they can be put back. */
export function hiddenRefOptions(p: Project, s: Scene): RefOption[] {
  const hidden = new Set(s.hiddenRefKeys ?? []);
  return allRefOptions(p, s).filter((o) => hidden.has(o.key));
}

/** A clip's last frame, kept next to it as <clip>-last.jpg (made when needed; see lastFrame in media.ts). */
export const lastFrameFile = (clip: string) => clip.replace(/\.[^.]+$/, "-last.jpg");

/** The images pinned to be used exactly: [start] or [start, end]. */
export function exactKeys(s: Scene): string[] {
  return (s.exactFrameKeys ?? (s.exactFrameKey ? [s.exactFrameKey] : [])).slice(0, 2);
}

function allRefOptions(p: Project, s: Scene): RefOption[] {
  const out: RefOption[] = [];
  const refsById = new Map(p.references.map((r) => [r.id, r]));
  const listed = new Set<string>();

  const prev = previousScene(p, s);
  if (prev?.videoFile) {
    out.push({ key: "prev-last", label: `Scene ${prev.number} clip end`, group: "Continuity", folder: "renders", file: lastFrameFile(prev.videoFile) });
  }
  if (prev?.imageFile) {
    out.push({ key: "prev-frame", label: `Scene ${prev.number} frame`, group: "Continuity", folder: "renders", file: prev.imageFile });
  }
  for (const x of p.products ?? []) {
    for (const id of x.referenceIds) {
      const r = refsById.get(id);
      if (!r) continue;
      listed.add(id);
      out.push({ key: `ref:${id}`, label: x.name, group: "Product", folder: "refs", file: r.file, ownerId: x.id });
    }
    if (x.shotFile) {
      out.push({ key: `product-shot:${x.id}`, label: `${x.name} (shot)`, group: "Product", folder: "renders", file: x.shotFile, ownerId: x.id });
    }
  }
  for (const c of p.characters) {
    if (c.portraitFile) {
      out.push({ key: `portrait:${c.id}`, label: `${c.name} (portrait)`, group: "Character", folder: "renders", file: c.portraitFile, ownerId: c.id });
    }
    for (const id of c.referenceIds) {
      const r = refsById.get(id);
      if (!r || listed.has(id)) continue;
      listed.add(id);
      out.push({ key: `ref:${id}`, label: c.name, group: "Character", folder: "refs", file: r.file, ownerId: c.id });
    }
  }
  for (const r of p.references) {
    if (listed.has(r.id)) continue;
    out.push({ key: `ref:${r.id}`, label: r.label, group: "Reference", folder: "refs", file: r.file });
  }
  return out;
}

/**
 * The app's own pick: for a frame, the previous frame when the scene continues the one before; then up to two
 * photos of each product in the scene; then each character's portrait (or their photos). At most three.
 */
export function autoRefKeys(p: Project, s: Scene, forFrame: boolean): string[] {
  const keys: string[] = [];
  if (forFrame && s.continuesPrevious && previousScene(p, s)?.imageFile) keys.push("prev-frame");
  for (const x of autoProducts(p, s)) keys.push(...x.referenceIds.filter((id) => p.references.some((r) => r.id === id)).slice(0, 2).map((id) => `ref:${id}`));
  for (const c of p.characters.filter((y) => s.characterIds.includes(y.id))) {
    if (c.portraitFile) keys.push(`portrait:${c.id}`);
    else keys.push(...c.referenceIds.map((id) => `ref:${id}`));
  }
  const hidden = new Set(s.hiddenRefKeys ?? []);
  return [...new Set(keys)].filter((k) => !hidden.has(k)).slice(0, MAX_REFS);
}

/** What this scene actually sends: your own picks if you've made some, otherwise the app's. */
export function chosenRefKeys(p: Project, s: Scene, forFrame: boolean): string[] {
  if (!s.refOverride) return autoRefKeys(p, s, forFrame);
  const available = new Set(refOptions(p, s).map((o) => o.key));
  return s.refOverride.filter((k) => available.has(k) && (forFrame || k !== "prev-frame")).slice(0, MAX_REFS);
}

/**
 * Products in this scene. Automatically: locked products plus the ones the scene lists. With your own picks:
 * only products with at least one image ticked, so unticking a product's images takes it out of the shot.
 */
export function sceneProducts(p: Project, s: Scene): Product[] {
  if (!s.refOverride) return autoProducts(p, s);
  const picked = new Set(s.refOverride);
  return (p.products ?? []).filter(
    (x) => picked.has(`product-shot:${x.id}`) || x.referenceIds.some((id) => picked.has(`ref:${id}`)),
  );
}

function autoProducts(p: Project, s: Scene): Product[] {
  return (p.products ?? []).filter((x) => x.locked || s.productIds?.includes(x.id));
}

function previousScene(p: Project, s: Scene) {
  const i = p.scenes.findIndex((x) => x.id === s.id);
  return i > 0 ? p.scenes[i - 1] : undefined;
}
