import { DURATIONS, type Project } from "../shared/types.js";
import type { Breakdown } from "./storyboard.js";

// Roughly how many words of action fit in each clip length (an 8-second shot is about one beat).
const WORDS_PER_SECOND = 3;

/**
 * Quick split: a storyboard without any AI, on this computer. It follows the structure the script already
 * has (scene headings, numbered shots, NAME: dialogue, paragraphs) and builds prompts from the text itself.
 * Good for scripts that are already written shot by shot; edit the prompts afterwards for anything else.
 */
export function quickSplit(p: Project): Breakdown {
  const seconds = p.settings.seconds === "auto" ? 8 : p.settings.seconds;
  const style = p.settings.style.trim();
  const blocks = splitBlocks(p.script);
  if (!blocks.length) throw new Error("Paste a script or master prompt first.");

  // Characters: people who speak (NAME: line), character reference images named in the text, and names
  // that come up more than once.
  const speakers = new Set<string>();
  for (const m of p.script.matchAll(/^\s*([A-Z][\p{L}'.-]*(?: [A-Z][\p{L}'.-]*){0,2})\s*(?:\([^)]*\))?\s*:/gmu)) {
    if (!/^(INT|EXT|SCENE|SHOT|CUT|FADE|NOTE|STYLE|TITLE)\b/i.test(m[1])) speakers.add(titleCase(m[1].trim()));
  }
  for (const r of p.references) if (r.kind === "character" && mentions(p.script, r.label)) speakers.add(r.label);
  const places = new Set(blocks.flatMap((b) => headingLocation(b.heading)?.toLowerCase().split(/\s+/) ?? []));
  for (const name of recurringNames(blocks.map((b) => b.text).join("\n"))) {
    if (![...speakers].some((s) => s.toLowerCase().includes(name.toLowerCase())) && !places.has(name.toLowerCase())) speakers.add(name);
  }
  const characters = [...speakers].map((name) => ({
    name,
    role: "",
    description: "",
    visual_prompt: name, // edit on the Characters tab, or render a portrait from a reference image
    reference_labels: p.references.filter((r) => r.label.toLowerCase() === name.toLowerCase()).map((r) => r.label),
  }));
  const locationRefs = p.references.filter((r) => r.kind === "location");

  let location = "";
  const scenes: Breakdown["scenes"] = [];
  for (const block of blocks) {
    const named = locationRefs.find((r) => mentions(block.text, r.label));
    const newLocation = headingLocation(block.heading) || named?.label || "";
    const continues = scenes.length > 0 && (!newLocation || newLocation === location);
    if (newLocation) location = newLocation;

    const cast = characters.filter((c) => mentions(block.text, c.name)).map((c) => c.name);
    const dialogue = [...block.text.matchAll(/^\s*([A-Z][\p{L}'. -]{0,30}?)\s*(?:\([^)]*\))?\s*:\s*(.+)$/gmu)]
      .filter((m) => speakers.has(titleCase(m[1].trim())))
      .map((m) => `${titleCase(m[1].trim())}: "${m[2].trim().replace(/^"|"$/g, "")}"`)
      .join(" ");
    const action = block.text.replace(/^\s*[A-Z][\p{L}'. -]{0,30}?\s*(?:\([^)]*\))?\s*:\s*.+$/gmu, "").replace(/\s+/g, " ").trim() || block.text;

    for (const piece of fitToLength(action, seconds)) {
      const where = location ? ` Location: ${location}.` : "";
      const who = cast.length ? ` Characters: ${cast.join(", ")}.` : "";
      const look = style ? ` Style: ${style}.` : "";
      scenes.push({
        title: block.title || piece.split(/[.!?]/)[0].slice(0, 48),
        duration_seconds: seconds,
        location,
        characters: cast,
        action: piece,
        shot: "",
        image_prompt: `${piece}${who}${where}${look}`.trim(),
        video_prompt: `${piece}${dialogue ? ` ${dialogue}` : ""}${who}${where}${look}`.trim(),
        dialogue,
        sound: "",
        continues_previous: scenes.length > 0 && continues,
      });
    }
  }

  const firstLine = p.script.trim().split("\n")[0].replace(/^#+\s*/, "").slice(0, 60);
  return { title: firstLine, logline: "", style_guide: style, characters, scenes };
}

interface Block {
  heading?: string;
  title?: string;
  text: string;
}

/** Split at scene headings / numbered shots when the script has them; otherwise at blank lines. */
function splitBlocks(script: string): Block[] {
  const lines = script.replace(/\r/g, "").split("\n");
  const marker = /^\s*(?:(?:scene|shot|eksena)\s*#?\d+\b.*|(?:INT|EXT|INT\/EXT)\.?\s+.+|\d{1,3}[.)]\s+.+)$/i;
  if (lines.some((l) => marker.test(l))) {
    const blocks: Block[] = [];
    let cur: Block | null = null;
    for (const line of lines) {
      if (marker.test(line)) {
        const h = line.trim();
        // "Scene 1: Jeepney" straight after by "INT. JEEPNEY - DAY" is one scene: keep the title, take the place.
        if (cur && !cur.text.trim() && cur.heading && /^(INT|EXT)/i.test(h)) {
          cur.heading = h;
          continue;
        }
        if (cur?.text.trim()) blocks.push(cur);
        // "1. She opens the door" is both marker and action; "Scene 3: Kitchen" is a title.
        const inline = /^\d{1,3}[.)]\s+(.+)$/.exec(h)?.[1];
        const title = /^(INT|EXT)/i.test(h) ? headingLocation(h) : h.replace(/^(scene|shot|eksena)\s*#?\d+\s*[:.-]?\s*/i, "");
        cur = { heading: h, title: inline ? undefined : title?.slice(0, 60), text: inline ?? "" };
      } else if (cur) cur.text += `${line}\n`;
      // Text before the first heading: a one-line title is the film's title, anything longer is a scene.
      else if (line.trim()) cur = { text: `${line}\n` };
    }
    if (cur?.text.trim()) blocks.push(cur);
    return blocks
      .filter((b, i) => !(i === 0 && !b.heading && b.text.trim().split("\n").length === 1 && b.text.trim().length < 80))
      .map((b) => ({ ...b, text: b.text.trim() }));
  }
  return script.split(/\n\s*\n/).map((t) => ({ text: t.trim() })).filter((b) => b.text);
}

/** Break action that's too long for one clip into clip-sized pieces at sentence ends. */
function fitToLength(text: string, seconds: number): string[] {
  const budget = Math.max(seconds, Math.min(...DURATIONS)) * WORDS_PER_SECOND;
  const sentences = text.match(/[^.!?]+[.!?]*["”]?\s*/g) ?? [text];
  const pieces: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && (cur + s).split(/\s+/).length > budget) {
      pieces.push(cur.trim());
      cur = "";
    }
    cur += s;
  }
  if (cur.trim()) pieces.push(cur.trim());
  return pieces;
}

/** "INT. JEEPNEY - SUNRISE" → "Jeepney". */
function headingLocation(heading?: string) {
  const place = /^(?:INT\.?|EXT\.?|INT\/EXT\.?)\s+(.+?)(?:\s+-\s+.+)?$/i.exec(heading?.trim() ?? "")?.[1];
  return place ? titleCase(place) : undefined;
}

function titleCase(s: string) {
  return s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (c) => c.toUpperCase()) : s;
}

// Capitalised words that start sentences or are otherwise not names.
const NOT_NAMES = new Set(
  ("The A An And But So Then When While After Before As At In On Of To From With Without Into Over Under He She They We I You " +
    "His Her Their Our My Your It Its This That These Those There Here Scene Shot Cut Close Wide Camera Slow Fast Day Night " +
    "Morning Evening Sunrise Sunset Int Ext Monday Tuesday Wednesday Thursday Friday Saturday Sunday Mr Mrs Ms Dr")
    .split(" "),
);

/** Capitalised names (one or two words) that appear at least twice. */
function recurringNames(text: string): string[] {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/\b([A-Z][a-z]{2,}(?: [A-Z][a-z]{2,})?)\b/g)) {
    const name = m[1].split(" ").filter((w) => !NOT_NAMES.has(w)).join(" ");
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n >= 2).map(([name]) => name);
}

function mentions(text: string, name: string) {
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}
