#!/usr/bin/env node
// Helper for writing storyboards outside the app (e.g. with Claude Code in this repo).
//
//   npm run storyboard -- list                      projects, with script size and scene count
//   npm run storyboard -- show <name or id>         settings, script, references (with image paths) and cast
//   npm run storyboard -- load <name or id> <file>  load a storyboard JSON file into the project
//
// The app must be running (npm run dev).
import fs from "node:fs";
import path from "node:path";

const API = `http://127.0.0.1:${process.env.FSPH_API_PORT ?? 5174}/api`;
const DATA = path.resolve(process.env.FSPH_DATA_DIR ?? "data");

async function call(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => {
    throw new Error("Flow Studio PH isn't running. Start it with: npm run dev");
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

async function find(nameOrId) {
  const all = await call("GET", "/projects");
  const q = String(nameOrId ?? "").toLowerCase();
  const hit =
    all.find((p) => p.id === nameOrId) ??
    all.find((p) => p.name.toLowerCase() === q) ??
    all.filter((p) => p.name.toLowerCase().includes(q)).at(0);
  if (!hit) throw new Error(`No project matches "${nameOrId}". Projects: ${all.map((p) => p.name).join(", ")}`);
  return call("GET", `/projects/${hit.id}`);
}

const [cmd, target, file] = process.argv.slice(2);
try {
  if (cmd === "list") {
    for (const p of await call("GET", "/projects")) {
      const full = await call("GET", `/projects/${p.id}`);
      console.log(`${p.id}  ${p.name}  (${full.script.length} chars of script, ${p.sceneCount} scenes)`);
    }
  } else if (cmd === "show") {
    const p = await find(target);
    console.log(`# ${p.name}  (id ${p.id})`);
    console.log(`aspect ${p.settings.aspectRatio} · seconds per scene ${p.settings.seconds} · style: ${p.settings.style || "(none)"}`);
    console.log(`\n## References (${p.references.length})`);
    for (const r of p.references) console.log(`- "${r.label}" (${r.kind}): ${path.join(DATA, "projects", p.id, "refs", r.file)}`);
    if (p.characters.length) {
      console.log(`\n## Current cast`);
      for (const c of p.characters) console.log(`- ${c.name}: ${c.visualPrompt}`);
    }
    console.log(`\n## Current storyboard: ${p.scenes.length} scenes`);
    console.log(`\n## Script\n${p.script}`);
  } else if (cmd === "load") {
    if (!file) throw new Error("Usage: npm run storyboard -- load <name or id> <file.json>");
    const p = await find(target);
    const json = fs.readFileSync(file, "utf8");
    const out = await call("POST", `/projects/${p.id}/storyboard`, { json });
    console.log(`Loaded into "${out.name}": ${out.characters.length} characters, ${out.scenes.length} scenes.`);
    for (const s of out.scenes) console.log(`  ${s.number}. ${s.title} (${s.durationSec}s) @ ${s.location}${s.continuesPrevious ? " · seamless" : ""}`);
  } else {
    console.log("Usage: npm run storyboard -- list | show <project> | load <project> <file.json>");
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
