import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import {
  DURATIONS, EXPORT_RESOLUTIONS, type Character, type ExportResolution, type Product, type Project, type ReferenceKind,
  type Scene,
} from "../shared/types.js";
import { MAX_REFS } from "../shared/attachments.js";
import { lastFrame } from "./media.js";
import { deleteExport, exportFinalCut, resetFinalCut, saveFinalCut, syncFinalCut } from "./finalcut.js";
import { breakdownWithFlowAgent } from "./flow/agent.js";
import { connectFlow, flowStatus, setWindowVisible } from "./flow/browser.js";
import { readCredits, renderPortrait, renderProductShot, renderSceneImage, renderSceneVideo } from "./flow/driver.js";
import { cancelJob, listJobs, queueFlowJob, setAfterFlowJob, startJob, whenFlowIdle } from "./jobs.js";
import { PROJECTS_DIR, ensureDir, refsDir, safeId } from "./paths.js";
import { quickSplit } from "./localsplit.js";
import { cleanSettingsFile, readSettings, writeSettings } from "./settings.js";
import { applyBreakdown, parseBreakdown } from "./storyboard.js";
import {
  createProject, deleteProject, getProject, listProjects, newId, resetInterruptedRenders, updateProject,
} from "./store.js";

const PORT = Number(process.env.FSPH_API_PORT ?? 5174);
const app = express();
app.use(express.json({ limit: "5mb" }));

const KINDS: ReferenceKind[] = ["character", "product", "location", "style", "prop"];
const pick = <T extends object>(src: any, keys: (keyof T)[]) =>
  Object.fromEntries(keys.filter((k) => src?.[k] !== undefined).map((k) => [k, src[k]])) as Partial<T>;

// ---- settings ----
app.get("/api/settings", (_req, res) => res.json(readSettings()));
app.put("/api/settings", (req, res) => {
  const { maxCreditsPerClip } = req.body ?? {};
  res.json(writeSettings(Number.isInteger(maxCreditsPerClip) && maxCreditsPerClip >= 0 ? { maxCreditsPerClip } : {}));
});

// ---- projects ----
app.get("/api/projects", (_req, res) => res.json(listProjects()));
app.post("/api/projects", (req, res) => res.json(createProject(String(req.body?.name ?? ""))));
app.get("/api/projects/:id", (req, res) => res.json(getProject(safeId(req.params.id))));
app.put("/api/projects/:id", (req, res) => {
  const body = req.body ?? {};
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      Object.assign(p, pick<Project>(body, ["name", "script", "logline", "styleGuide"]));
      if (body.settings) {
        const s = body.settings;
        if (s.aspectRatio === "16:9" || s.aspectRatio === "9:16") p.settings.aspectRatio = s.aspectRatio;
        if (s.seconds === "auto" || DURATIONS.includes(s.seconds)) p.settings.seconds = s.seconds;
        if (typeof s.style === "string") p.settings.style = s.style;
        if (s.engine === "flow" || s.engine === "local" || s.engine === "claude") p.settings.engine = s.engine;
        if (s.videoStyle === "cinematic" || s.videoStyle === "ugc") p.settings.videoStyle = s.videoStyle;
      }
    }),
  );
});
app.delete("/api/projects/:id", (req, res) => {
  deleteProject(safeId(req.params.id));
  res.json({ ok: true });
});

// ---- references ----
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => cb(null, ensureDir(refsDir(safeId(String(req.params.id))))),
    filename: (_req, file, cb) => cb(null, `${newId()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith("image/")),
});

app.post("/api/projects/:id/references", upload.array("files", 20), (req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  const kind = KINDS.includes(req.body.kind) ? (req.body.kind as ReferenceKind) : "character";
  res.json(
    updateProject(safeId(String(req.params.id)), (p) => {
      // Photos uploaded from a product card are linked to that product straight away.
      const product = p.products?.find((x) => x.id === req.body.productId);
      for (const f of files) {
        const base = path.parse(f.originalname).name.replace(/[_-]+/g, " ").trim();
        const ref = {
          id: newId(),
          label: (files.length === 1 && req.body.label?.trim()) || product?.name || base || "Reference",
          kind: product ? ("product" as const) : kind,
          file: f.filename,
          mime: f.mimetype,
        };
        p.references.push(ref);
        product?.referenceIds.push(ref.id);
      }
    }),
  );
});
app.put("/api/projects/:id/references/:refId", (req, res) => {
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      const r = p.references.find((x) => x.id === req.params.refId);
      if (!r) return;
      if (typeof req.body.label === "string") r.label = req.body.label.trim() || r.label;
      if (KINDS.includes(req.body.kind)) r.kind = req.body.kind;
    }),
  );
});
app.delete("/api/projects/:id/references/:refId", (req, res) => {
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      const r = p.references.find((x) => x.id === req.params.refId);
      if (!r) return;
      fs.rmSync(path.join(refsDir(p.id), r.file), { force: true });
      p.references = p.references.filter((x) => x.id !== r.id);
      for (const c of p.characters) c.referenceIds = c.referenceIds.filter((id) => id !== r.id);
      for (const x of p.products ?? []) x.referenceIds = x.referenceIds.filter((id) => id !== r.id);
    }),
  );
});

// ---- storyboard: Google Flow's agent (free, in your Flow account) or Quick split (no AI, on this computer) ----
app.post("/api/projects/:id/breakdown", (req, res) => {
  const id = safeId(req.params.id);
  const project = getProject(id);
  if (!project.script.trim()) return void res.status(400).json({ error: "Paste a script or master prompt first." });
  const engine = project.settings.engine ?? "flow";
  if (engine === "claude") {
    return void res.status(400).json({ error: "This project uses Claude Code: ask Claude Code in this folder to storyboard it, or paste the JSON." });
  }
  const label = `Storyboard for "${project.name}"`;
  const runner = async (report: (s: string) => void) => {
    const result = engine === "flow" ? await breakdownWithFlowAgent(getProject(id), report) : quickSplit(getProject(id));
    updateProject(id, (p) => applyBreakdown(p, result));
    report(`Done: ${result.characters.length} characters, ${result.scenes.length} scenes.`);
  };
  // Flow's agent uses the Flow window, so it waits its turn with renders; Quick split runs straight away.
  res.json(engine === "flow" ? queueFlowJob("breakdown", id, label, runner) : startJob("breakdown", id, label, runner));
});

/**
 * Load a ready-made storyboard (the same JSON shape the engines produce), e.g. one written by Claude Code
 * in this repo or pasted by hand. Replaces the project's characters and scenes.
 */
app.post("/api/projects/:id/storyboard", (req, res) => {
  const body = req.body ?? {};
  const breakdown = parseBreakdown(typeof body.json === "string" ? body.json : JSON.stringify(body));
  res.json(updateProject(safeId(req.params.id), (p) => applyBreakdown(p, breakdown)));
});

// ---- characters & scenes ----
const SCENE_FIELDS: (keyof Scene)[] = [
  "title", "durationSec", "location", "characterIds", "action", "shot", "imagePrompt", "videoPrompt", "dialogue", "sound", "continuesPrevious", "productIds", "refOverride", "exactFrameKeys", "hiddenRefKeys", "pinRefKeys",
];
const CHAR_FIELDS: (keyof Character)[] = ["name", "role", "description", "visualPrompt", "referenceIds"];

app.put("/api/projects/:id/scenes/:sceneId", (req, res) => {
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      const s = p.scenes.find((x) => x.id === req.params.sceneId);
      if (!s) return;
      const patch = pick<Scene>(req.body, SCENE_FIELDS);
      if (patch.durationSec !== undefined && !DURATIONS.includes(patch.durationSec)) delete patch.durationSec;
      // refOverride: a list of image keys (your own picks), or null to go back to automatic.
      if ((patch.refOverride as unknown) === null) {
        delete patch.refOverride;
        delete s.refOverride;
      } else if (patch.refOverride !== undefined) {
        patch.refOverride = Array.isArray(patch.refOverride)
          ? [...new Set(patch.refOverride.filter((k): k is string => typeof k === "string"))].slice(0, MAX_REFS)
          : undefined;
      }
      // exactFrameKeys: up to two image keys used exactly (start, end); [] or null to generate frames again.
      // hiddenRefKeys: images taken off this scene's list. Both replace the older single exactFrameKey.
      for (const field of ["exactFrameKeys", "hiddenRefKeys", "pinRefKeys"] as const) {
        const value = patch[field] as unknown;
        if (value === undefined) continue;
        const list = Array.isArray(value) ? [...new Set(value.filter((k): k is string => typeof k === "string"))] : [];
        if (field === "exactFrameKeys") delete s.exactFrameKey;
        if (list.length) patch[field] = field === "exactFrameKeys" ? list.slice(0, 2) : list;
        else {
          delete patch[field];
          delete s[field];
        }
      }
      Object.assign(s, patch);
      // Pinning a removed image puts it back; removing a pinned image unpins it.
      if (patch.exactFrameKeys && s.hiddenRefKeys?.length) {
        s.hiddenRefKeys = s.hiddenRefKeys.filter((k) => !patch.exactFrameKeys!.includes(k));
        if (!s.hiddenRefKeys.length) delete s.hiddenRefKeys;
      }
      if (s.hiddenRefKeys?.length && s.exactFrameKeys?.length) {
        s.exactFrameKeys = s.exactFrameKeys.filter((k) => !s.hiddenRefKeys!.includes(k));
        if (!s.exactFrameKeys.length) delete s.exactFrameKeys;
      }
      if (s.hiddenRefKeys?.length && s.pinRefKeys?.length) s.pinRefKeys = s.pinRefKeys.filter((k) => !s.hiddenRefKeys!.includes(k));
      // Added images belong to a pinned start; without one they go.
      if (!s.exactFrameKeys?.length && !s.exactFrameKey) delete s.pinRefKeys;
    }),
  );
});
app.post("/api/projects/:id/scenes", (req, res) => {
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      const after = p.scenes.findIndex((x) => x.id === req.body?.afterId);
      const scene: Scene = {
        id: newId(), number: 0, title: "New scene",
        durationSec: p.settings.seconds === "auto" ? 8 : p.settings.seconds,
        location: "", characterIds: [], action: "", shot: "", imagePrompt: "", videoPrompt: "",
        dialogue: "", sound: "", continuesPrevious: after >= 0, imageStatus: "idle", videoStatus: "idle",
      };
      p.scenes.splice(after >= 0 ? after + 1 : p.scenes.length, 0, scene);
      p.scenes.forEach((s, i) => (s.number = i + 1));
    }),
  );
});
app.post("/api/projects/:id/scenes/:sceneId/move", (req, res) => {
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      const i = p.scenes.findIndex((x) => x.id === req.params.sceneId);
      const j = i + (req.body?.direction === "up" ? -1 : 1);
      if (i < 0 || j < 0 || j >= p.scenes.length) return;
      [p.scenes[i], p.scenes[j]] = [p.scenes[j], p.scenes[i]];
      p.scenes.forEach((s, k) => (s.number = k + 1));
    }),
  );
});
app.delete("/api/projects/:id/scenes/:sceneId", (req, res) => {
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      p.scenes = p.scenes.filter((x) => x.id !== req.params.sceneId);
      p.scenes.forEach((s, i) => (s.number = i + 1));
    }),
  );
});
app.put("/api/projects/:id/characters/:charId", (req, res) => {
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      const c = p.characters.find((x) => x.id === req.params.charId);
      if (c) Object.assign(c, pick<Character>(req.body, CHAR_FIELDS));
    }),
  );
});
app.post("/api/projects/:id/characters", (req, res) => {
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      p.characters.push({
        id: newId(), name: String(req.body?.name || "New character"), role: "", description: "",
        visualPrompt: "", referenceIds: [], portraitStatus: "idle",
      });
    }),
  );
});
// ---- products ----
const PRODUCT_FIELDS: (keyof Product)[] = ["name", "description", "visualPrompt", "referenceIds", "locked"];
app.post("/api/projects/:id/products", (req, res) => {
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      p.products ??= [];
      p.products.push({
        id: newId(), name: String(req.body?.name || "New product"), description: "", visualPrompt: "", referenceIds: [],
        locked: p.products.length === 0, // the first product is locked to every scene by default
      });
    }),
  );
});
app.put("/api/projects/:id/products/:productId", (req, res) => {
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      const x = p.products?.find((y) => y.id === req.params.productId);
      if (x) Object.assign(x, pick<Product>(req.body, PRODUCT_FIELDS));
    }),
  );
});
app.delete("/api/projects/:id/products/:productId", (req, res) => {
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      p.products = (p.products ?? []).filter((x) => x.id !== req.params.productId);
      for (const s of p.scenes) s.productIds = s.productIds?.filter((id) => id !== req.params.productId);
    }),
  );
});

app.delete("/api/projects/:id/characters/:charId", (req, res) => {
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      p.characters = p.characters.filter((x) => x.id !== req.params.charId);
      for (const s of p.scenes) s.characterIds = s.characterIds.filter((id) => id !== req.params.charId);
    }),
  );
});

// ---- rendering in Flow ----
type RenderKind = "portrait" | "product" | "image" | "video";

/** For each kind of render: what it renders, which fields hold its status and file, and how it's done. */
const RENDERS: Record<RenderKind, {
  list: (p: Project) => { id: string }[];
  fields: { status: string; file: string };
  label: (t: any) => string;
  run: (p: Project, id: string, report: (s: string) => void) => Promise<string>;
}> = {
  portrait: { list: (p) => p.characters, fields: { status: "portraitStatus", file: "portraitFile" }, label: (c: Character) => `Portrait: ${c.name}`, run: renderPortrait },
  product: { list: (p) => p.products ?? [], fields: { status: "shotStatus", file: "shotFile" }, label: (x: Product) => `Product shot: ${x.name}`, run: renderProductShot },
  image: { list: (p) => p.scenes, fields: { status: "imageStatus", file: "imageFile" }, label: (s: Scene) => `Scene ${s.number} image`, run: renderSceneImage },
  video: { list: (p) => p.scenes, fields: { status: "videoStatus", file: "videoFile" }, label: (s: Scene) => `Scene ${s.number} video`, run: renderSceneVideo },
};

app.post("/api/projects/:id/render", (req, res) => {
  const id = safeId(req.params.id);
  const kind = req.body?.kind as RenderKind;
  const render = RENDERS[kind];
  if (!render) return void res.status(400).json({ error: "Unknown render kind" });
  const ids: string[] | undefined = Array.isArray(req.body?.ids) ? req.body.ids : undefined;
  const targets = render.list(getProject(id)).filter((t) => !ids || ids.includes(t.id));

  const setStatus = (targetId: string, status: Scene["imageStatus"], extra: Record<string, unknown> = {}) =>
    updateProject(id, (p) => {
      const t = render.list(p).find((x) => x.id === targetId);
      if (t) Object.assign(t, { [render.fields.status]: status, ...extra });
    });

  const jobs = targets.map((t) => {
    setStatus(t.id, "queued", { error: undefined });
    return queueFlowJob(
      kind,
      id,
      render.label(t),
      async (report) => {
        setStatus(t.id, "running");
        try {
          const file = await render.run(getProject(id), t.id, report);
          setStatus(t.id, "done", { [render.fields.file]: file });
        } catch (e) {
          setStatus(t.id, "failed", { error: (e as Error).message });
          throw e;
        }
      },
      t.id,
      () => setStatus(t.id, "idle"),
    );
  });
  res.json(jobs);
});

// ---- Final Cut ----
app.get("/api/projects/:id/final-cut", async (req, res) => res.json(await syncFinalCut(safeId(req.params.id))));
app.put("/api/projects/:id/final-cut", (req, res) => res.json(saveFinalCut(safeId(req.params.id), req.body ?? {})));
app.post("/api/projects/:id/final-cut/reset", async (req, res) => res.json(await resetFinalCut(safeId(req.params.id))));
app.post("/api/projects/:id/export", (req, res) => {
  const id = safeId(req.params.id);
  const resolution = EXPORT_RESOLUTIONS.includes(req.body?.resolution) ? (req.body.resolution as ExportResolution) : "1080p";
  const label = `Export ${resolution === "4k" ? "4K" : resolution} MP4`;
  const runner = async (report: (s: string) => void) => void (await exportFinalCut(id, resolution, report));
  // 1080p and 4K fetch Flow's upscales, so they wait their turn with other Flow work; 720p doesn't need Flow.
  res.json(resolution === "720p" ? startJob("export", id, label, runner) : queueFlowJob("export", id, label, runner));
});
app.delete("/api/projects/:id/exports/:file", (req, res) => {
  deleteExport(safeId(req.params.id), req.params.file);
  res.json(getProject(safeId(req.params.id)));
});

// ---- jobs ----
app.get("/api/jobs", (req, res) => res.json(listJobs(req.query.projectId as string | undefined)));
app.post("/api/jobs/:jobId/cancel", (req, res) => res.json(cancelJob(req.params.jobId) ?? null));

// ---- Google Flow connection ----
// Remaining credits: read when Flow is free (after each Flow job, on connect, or when asked) and kept here.
const credits: { value?: number; resets?: string; at?: string } = {};
async function refreshCredits() {
  const read = await readCredits().catch(() => undefined);
  if (read?.credits !== undefined) Object.assign(credits, { value: read.credits, resets: read.resets, at: new Date().toISOString() });
}
setAfterFlowJob(refreshCredits);
const withCredits = <T extends object>(s: T) => ({ ...s, credits: credits.value, creditsResets: credits.resets, creditsAt: credits.at });

app.get("/api/flow/status", async (_req, res) => {
  const status = await flowStatus();
  // First time Flow is signed in, read the credits (once Flow is free).
  if (status.signedIn && !credits.at) {
    credits.at = new Date(0).toISOString();
    void whenFlowIdle(refreshCredits);
  }
  res.json(withCredits(status));
});
app.post("/api/flow/connect", async (_req, res) => res.json(withCredits(await connectFlow())));
app.post("/api/flow/credits", async (_req, res) => {
  await whenFlowIdle(refreshCredits);
  res.json(withCredits(await flowStatus()));
});
app.post("/api/flow/window", async (req, res) => {
  await setWindowVisible(Boolean(req.body?.visible));
  res.json(await flowStatus());
});

// ---- files: references, renders and exports (?download=1 saves instead of playing) ----
app.get("/files/:projectId/:folder/:file", (req, res) => {
  const { folder, file } = req.params;
  if (!["refs", "renders", "exports"].includes(folder) || !/^[\w.-]+$/.test(file)) return void res.sendStatus(404);
  const full = path.join(PROJECTS_DIR, safeId(req.params.projectId), folder, file);
  const send = () => (req.query.download ? res.download(full, file) : res.sendFile(full));
  // A clip's last frame (<clip>-last.jpg) is made the first time it's asked for.
  const clip = full.replace(/-last\.jpg$/, ".mp4");
  if (folder === "renders" && file.endsWith("-last.jpg") && !fs.existsSync(full) && fs.existsSync(clip)) {
    lastFrame(clip).then(send, () => res.sendStatus(404));
  } else send();
});

// ---- production: serve the built UI ----
const dist = path.resolve("dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|files).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
  res.status(missing ? 404 : 400).json({ error: missing ? "Not found" : err.message });
});

resetInterruptedRenders();
cleanSettingsFile();
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Flow Studio PH API on http://127.0.0.1:${PORT}`);
});
