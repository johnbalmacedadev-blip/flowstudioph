import { DURATIONS, type Character, type Duration, type Product, type Project, type Scene } from "../shared/types.js";
import { newId } from "./store.js";

/** What a storyboard engine returns: the cast and the shot list. */
export interface Breakdown {
  title: string;
  logline: string;
  style_guide: string;
  characters: {
    name: string;
    role: string;
    description: string;
    visual_prompt: string;
    reference_labels: string[];
  }[];
  products: {
    name: string;
    description: string;
    visual_prompt: string;
    reference_labels: string[];
  }[];
  scenes: {
    title: string;
    duration_seconds: number;
    location: string;
    characters: string[];
    action: string;
    shot: string;
    image_prompt: string;
    video_prompt: string;
    dialogue: string;
    sound: string;
    continues_previous: boolean;
    products: string[];
  }[];
}

export const RULES = `Turn the source into a cast of characters and an ordered list of scenes, where each scene is exactly one continuous shot that becomes one short video clip.

Rules:
- Keep everything the source asks for. If it already lists scenes, shots or timings, follow them in order and do not merge, drop or reorder them. If it is prose, break it into shots that tell the whole story.
- Each scene's action must fit its duration_seconds. Split a long beat across several scenes rather than cramming it into one.
- Clips have no memory of each other. Every image_prompt and video_prompt must stand alone: repeat each character's full visual description, the location, and the style in every prompt that uses them. Never write "the same man" or "as before".
- image_prompt describes the opening still frame (composition, characters, setting, style, lighting). video_prompt describes the motion: subject and action, then shot size and one camera move, then location, style, lighting and sound. Put spoken lines in quotes and say who speaks them.
- Write prompts in English even if the source is in another language; keep dialogue in the language the source uses.
- style_guide is one paragraph describing the shared visual style. Fold it into every prompt.
- characters lists only recurring or named people, creatures or mascots, with a full visual_prompt (age, build, face, hair, clothing). Use the exact same name in each scene's characters list.
- dialogue and sound may be empty strings when there is none.
- products lists any product the video sells or shows (from the source, or the products given to you), with a visual_prompt describing its exact look: packaging shape, size, colours, label text and logo. A scene's products lists the product names it shows. In every prompt where a product appears, describe it exactly that way and have it shown clearly, label facing camera, never altered or replaced by a generic one.

Continuity (the scenes are cut together into one film, so they must feel continuous):
- Stay in the same location from scene to scene unless the source clearly moves the story somewhere else. Do not invent a new location; find a new angle or action in the same place instead.
- Give each location one fixed name and one fixed visual description (set, props, time of day, light, weather), and repeat it word for word in every prompt set there. Keep wardrobe, props and positions consistent from shot to shot.
- Set continues_previous to true when a scene happens in the same place and moment as the scene before it (same location, no time jump); its prompts then pick up exactly where the previous shot ends. Set it to false for the first scene, after a change of location, or after a time jump.`;

export const SHAPE = `{"title":"","logline":"","style_guide":"","characters":[{"name":"","role":"","description":"","visual_prompt":"","reference_labels":[]}],"products":[{"name":"","description":"","visual_prompt":"","reference_labels":[]}],"scenes":[{"title":"","duration_seconds":8,"location":"","characters":[""],"products":[""],"action":"","shot":"","image_prompt":"","video_prompt":"","dialogue":"","sound":"","continues_previous":false}]}`;

/** Extra rules for UGC (creator-style) videos. */
export const UGC_RULES = `This is a UGC (user-generated content) video: it must look like a real person filmed it on their phone, not like an ad agency shoot.
- Vertical 9:16, handheld smartphone footage: slight natural camera shake, selfie angle or a phone propped up, eye-level, no dolly, crane or drone moves.
- A relatable creator talks straight to the camera in a casual, authentic way (testimonial, review, "get ready with me", unboxing or demo).
- Real everyday settings (bedroom, bathroom mirror, kitchen counter, car, street, office desk) with natural window light or home lighting; no studio lighting or cinematic colour grading.
- Structure: a scroll-stopping hook in the first scene, then the problem, the product in use or the result, and a clear call to action at the end.
- Keep the product in the creator's hand or close to the lens when it's featured, label facing the camera.`;

/** Style and product context for the storyboard engines, from the project's settings and Products. */
export function projectBrief(p: Project) {
  const lines: string[] = [];
  if (p.settings.videoStyle === "ugc") lines.push(UGC_RULES);
  const products = p.products ?? [];
  if (products.length) {
    lines.push(
      "Products in this project (use these exact names in products and in each scene's products; describe each exactly as given):\n" +
        products
          .map((x) => `- ${x.name}${x.locked ? " (LOCKED: appears in every scene)" : ""}: ${x.visualPrompt || x.description}${x.description && x.visualPrompt ? ` (${x.description})` : ""}`)
          .join("\n"),
    );
  }
  return lines.join("\n\n");
}

/** Timing instruction for the project's "seconds per scene" setting. */
export function timingRule(p: Project) {
  const s = p.settings.seconds;
  return s === "auto"
    ? `Choose each scene's duration_seconds from ${DURATIONS.join(", ")} to fit its action.`
    : `Every scene's duration_seconds is ${s}; plan each shot's action to fill exactly ${s} seconds.`;
}

/**
 * Long scripts go to the engine in parts (at paragraph breaks) so no single reply gets cut off.
 * Each part is still one story; merge() stitches the results back together.
 */
export function chunkScript(script: string, maxChars = 5000): string[] {
  const paras = script.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const para of paras) {
    if (cur && cur.length + para.length > maxChars) {
      chunks.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${para}` : para;
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [script.trim()];
}

/** Join the breakdowns of several parts: one cast (first description of a name wins), scenes in order. */
export function merge(parts: Breakdown[]): Breakdown {
  const [first] = parts;
  const cast = new Map<string, Breakdown["characters"][number]>();
  for (const part of parts) for (const c of part.characters) if (!cast.has(c.name.toLowerCase())) cast.set(c.name.toLowerCase(), c);
  const products = new Map<string, Breakdown["products"][number]>();
  for (const part of parts) for (const x of part.products) if (!products.has(x.name.toLowerCase())) products.set(x.name.toLowerCase(), x);
  return { ...first, characters: [...cast.values()], products: [...products.values()], scenes: parts.flatMap((x) => x.scenes) };
}

/**
 * Pull a breakdown out of a chat reply. Replies may wrap the JSON in a ```json fence, escape it as a string
 * (\" and \n), or trail stray brackets, so: unescape, then try the longest {...} that parses.
 */
export function parseBreakdown(reply: string): Breakdown {
  let text = reply.replace(/^\s*(```)?\s*json\b/i, "").replace(/```/g, "");
  if (/\\"/.test(text) && !/"\s*:\s*"/.test(text.replace(/\\"/g, ""))) {
    text = text.replace(/\\n/g, "\n").replace(/\\t/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  const start = text.indexOf("{");
  if (start < 0) throw new Error("The reply didn't contain a storyboard.");
  for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
    const candidate = text.slice(start, end + 1);
    // Sometimes the "scenes": label goes missing and the scene list follows the characters unnamed.
    const relabelled = candidate.includes('"scenes"') ? candidate : candidate.replace(/\]\s*,\s*\[\s*\{/, '],"scenes":[{');
    for (const attempt of [candidate, escapeStrayQuotes(candidate), escapeStrayQuotes(relabelled)]) {
      try {
        return normalise(JSON.parse(attempt));
      } catch {
        // try the repaired version, then keep trimming from the end
      }
    }
  }
  throw new Error("Couldn't read the storyboard from the reply.");
}

/**
 * Chat replies often quote dialogue inside a JSON string without escaping it:
 *   "dialogue": ""Lola, bukas ulit tayo!" - Paolo"
 * Inside a string, a quote only ends it when what follows is , } ] or : (after spaces); any other quote
 * is part of the text and gets escaped.
 */
export function escapeStrayQuotes(json: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (!inString) {
      if (c === '"') inString = true;
      out += c;
      continue;
    }
    if (c === "\\") {
      out += c + (json[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "\n") {
      out += "\\n";
      continue;
    }
    if (c === '"') {
      const next = /\S/.exec(json.slice(i + 1))?.[0];
      if (next === undefined || next === "," || next === "}" || next === "]" || next === ":") {
        inString = false;
        out += c;
      } else out += '\\"';
      continue;
    }
    out += c;
  }
  return out;
}

/** Fill in anything a reply left out, so the rest of the app can rely on every field being there. */
function normalise(raw: any): Breakdown {
  if (!raw || !Array.isArray(raw.scenes) || !raw.scenes.length) throw new Error("The reply had no scenes.");
  const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
  const list = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
  return {
    title: str(raw.title),
    logline: str(raw.logline),
    style_guide: str(raw.style_guide),
    characters: (Array.isArray(raw.characters) ? raw.characters : []).filter((c: any) => c?.name).map((c: any) => ({
      name: str(c.name),
      role: str(c.role),
      description: str(c.description),
      visual_prompt: str(c.visual_prompt) || str(c.description),
      reference_labels: list(c.reference_labels),
    })),
    products: (Array.isArray(raw.products) ? raw.products : []).filter((x: any) => x?.name).map((x: any) => ({
      name: str(x.name),
      description: str(x.description),
      visual_prompt: str(x.visual_prompt) || str(x.description),
      reference_labels: list(x.reference_labels),
    })),
    scenes: raw.scenes.map((s: any, i: number) => ({
      title: str(s.title) || `Scene ${i + 1}`,
      duration_seconds: Number(s.duration_seconds) || 8,
      location: str(s.location),
      characters: list(s.characters),
      action: str(s.action),
      shot: str(s.shot),
      image_prompt: str(s.image_prompt) || str(s.action),
      video_prompt: str(s.video_prompt) || str(s.action),
      dialogue: str(s.dialogue),
      sound: str(s.sound),
      continues_previous: s.continues_previous === true,
      products: list(s.products),
    })),
  };
}

/** Replace the project's cast and scenes with a fresh breakdown. */
export function applyBreakdown(project: Project, b: Breakdown) {
  const refByLabel = new Map(project.references.map((r) => [r.label.toLowerCase(), r.id]));
  // A reference image named after a character is linked to them even if the engine didn't say so.
  const characters: Character[] = b.characters.map((c) => ({
    id: newId(),
    name: c.name,
    role: c.role,
    description: c.description,
    visualPrompt: c.visual_prompt,
    referenceIds: [...new Set([...c.reference_labels, c.name].flatMap((l) => refByLabel.get(l.toLowerCase()) ?? []))],
    portraitStatus: "idle",
  }));
  const charByName = new Map(characters.map((c) => [c.name.toLowerCase(), c.id]));
  const products = mergeProducts(project, b);
  const productByName = new Map(products.map((x) => [x.name.toLowerCase(), x.id]));
  const fixed: Duration | undefined = project.settings.seconds === "auto" ? undefined : project.settings.seconds;
  const scenes: Scene[] = b.scenes.map((s, i) => ({
    id: newId(),
    number: i + 1,
    title: s.title,
    durationSec: fixed ?? nearestDuration(s.duration_seconds),
    location: s.location,
    characterIds: s.characters.flatMap((n) => charByName.get(n.toLowerCase()) ?? []),
    action: s.action,
    shot: s.shot,
    imagePrompt: s.image_prompt,
    videoPrompt: s.video_prompt,
    dialogue: s.dialogue,
    sound: s.sound,
    continuesPrevious: i > 0 && s.continues_previous,
    productIds: s.products.flatMap((n) => productByName.get(n.toLowerCase()) ?? []),
    imageStatus: "idle",
    videoStatus: "idle",
  }));
  project.logline = b.logline;
  project.styleGuide = b.style_guide;
  project.characters = characters;
  project.products = products;
  project.scenes = scenes;
  if ((!project.name || project.name === "Untitled story") && b.title) project.name = b.title;
}

/**
 * Products are the user's own setup (photos, lock), so a storyboard never removes them: a product it names is
 * matched to an existing one by name and only fills in what's missing; new names become new products.
 */
function mergeProducts(project: Project, b: Breakdown): Product[] {
  const refByLabel = new Map(project.references.map((r) => [r.label.toLowerCase(), r.id]));
  const products: Product[] = structuredClone(project.products ?? []);
  for (const x of b.products) {
    const linked = [...x.reference_labels, x.name].flatMap((l) => refByLabel.get(l.toLowerCase()) ?? []);
    const existing = products.find((y) => y.name.toLowerCase() === x.name.toLowerCase());
    if (existing) {
      existing.description ||= x.description;
      existing.visualPrompt ||= x.visual_prompt;
      existing.referenceIds = [...new Set([...existing.referenceIds, ...linked])];
    } else {
      products.push({ id: newId(), name: x.name, description: x.description, visualPrompt: x.visual_prompt, referenceIds: [...new Set(linked)], locked: false });
    }
  }
  return products;
}

function nearestDuration(sec: number): Duration {
  return DURATIONS.reduce((best, d) => (Math.abs(d - sec) < Math.abs(best - sec) ? d : best), DURATIONS[0] as Duration);
}
