import { Fragment, useState } from "react";
import { DURATIONS, type Duration, type FlowStatus, type Project, type Scene } from "../../../shared/types";
import { api, fileUrl } from "../api";
import { Editable } from "./Editable";
import { isBusy, RenderLabel } from "./Busy";
import { StatusBadge } from "./StatusBadge";

interface Props {
  project: Project;
  flow: FlowStatus | null;
  onChange: (p: Project) => void;
  onError: (msg: string) => void;
}

export function StoryboardTab({ project, flow, onChange, onError }: Props) {
  const id = project.id;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const run = (p: Promise<Project>) => p.then(onChange).catch((e) => onError(e.message));
  const render = (kind: "image" | "video", ids?: string[]) => {
    if (!flow?.signedIn) return onError("Connect Google Flow first (top right).");
    api.render(id, kind, ids).catch((e) => onError(e.message));
  };
  const total = project.scenes.reduce((n, s) => n + s.durationSec, 0);
  // How many frames / clips are waiting or rendering, shown on the "Render all" buttons ("Rendering clips… 3").
  const framesBusy = project.scenes.filter((s) => isBusy(s.imageStatus)).length;
  const clipsBusy = project.scenes.filter((s) => isBusy(s.videoStatus)).length;
  const toggle = (sid: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      next.has(sid) ? next.delete(sid) : next.add(sid);
      return next;
    });

  if (!project.scenes.length) {
    return (
      <div className="tab-body">
        <div className="empty">
          No scenes yet. Paste your script on the first tab and click <b>Generate storyboard</b>.
          <div><button className="btn ghost" onClick={() => run(api.addScene(id))}>+ Add a scene by hand</button></div>
        </div>
      </div>
    );
  }

  return (
    <div className="tab-body">
      {project.logline && <p className="logline">{project.logline}</p>}
      <div className="toolbar sticky">
        <div className="stats">
          <b>{project.scenes.length}</b> scenes · <b>{formatTime(total)}</b> total · {project.settings.aspectRatio}
        </div>
        <div className="row tight">
          <button className="btn ghost" onClick={() => setExpanded(expanded.size ? new Set() : new Set(project.scenes.map((s) => s.id)))}>
            {expanded.size ? "Collapse all" : "Edit all prompts"}
          </button>
          <button className="btn" onClick={() => render("image")} disabled={framesBusy > 0}>
            <RenderLabel status={framesBusy ? "running" : "idle"} idle="Render all frames" running={`Rendering frames… ${framesBusy}`} />
          </button>
          <button className="btn primary" onClick={() => render("video")} disabled={clipsBusy > 0}>
            <RenderLabel status={clipsBusy ? "running" : "idle"} idle="Render all clips" running={`Rendering clips… ${clipsBusy}`} />
          </button>
        </div>
      </div>

      {project.styleGuide && (
        <details className="card style-guide">
          <summary>Style guide</summary>
          <Editable multiline rows={3} value={project.styleGuide} onSave={(styleGuide) => run(api.updateProject(id, { styleGuide }))} />
        </details>
      )}

      <div className="scenes">
        {project.scenes.map((s, i) => (
          <Fragment key={s.id}>
          {i > 0 && (
            <button
              className={`link-toggle ${s.continuesPrevious ? "on" : ""}`}
              onClick={() => run(api.updateScene(id, s.id, { continuesPrevious: !s.continuesPrevious }))}
              title={
                s.continuesPrevious
                  ? "Seamless: this clip starts on the last frame of the previous clip, in the same place. Click to make it a cut."
                  : "Cut: this scene is a new shot. Click to make it continue seamlessly from the previous scene."
              }
            >
              {s.continuesPrevious ? `🔗 Seamless from scene ${i}` : "✂ Cut"}
            </button>
          )}
          <SceneCard

            project={project}
            scene={s}
            first={i === 0}
            last={i === project.scenes.length - 1}
            open={expanded.has(s.id)}
            onToggle={() => toggle(s.id)}
            onPatch={(patch) => run(api.updateScene(id, s.id, patch))}
            onMove={(d) => run(api.moveScene(id, s.id, d))}
            onAddAfter={() => run(api.addScene(id, s.id))}
            onDelete={() => confirm(`Delete scene ${s.number}?`) && run(api.deleteScene(id, s.id))}
            onRender={(kind) => render(kind, [s.id])}
          />
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function SceneCard({ project, scene: s, first, last, open, onToggle, onPatch, onMove, onAddAfter, onDelete, onRender }: {
  project: Project;
  scene: Scene;
  first: boolean;
  last: boolean;
  open: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<Scene>) => void;
  onMove: (d: "up" | "down") => void;
  onAddAfter: () => void;
  onDelete: () => void;
  onRender: (kind: "image" | "video") => void;
}) {
  const id = project.id;
  const cast = project.characters.filter((c) => s.characterIds.includes(c.id));
  const products = project.products ?? [];
  const shown = products.filter((x) => x.locked || s.productIds?.includes(x.id));
  const vertical = project.settings.aspectRatio === "9:16";

  return (
    <article className={`card scene ${vertical ? "vertical" : ""}`}>
      <div className={`scene-media ${vertical ? "v" : "h"}`}>
        {s.videoFile ? (
          <video src={fileUrl(id, "renders", s.videoFile)} controls loop poster={s.imageFile && fileUrl(id, "renders", s.imageFile)} />
        ) : s.imageFile ? (
          <img src={fileUrl(id, "renders", s.imageFile)} alt={s.title} />
        ) : (
          <div className="placeholder">
            <span className="scene-num">{s.number}</span>
            <span className="muted small">{s.shot || "No frame yet"}</span>
          </div>
        )}
        <StatusBadge status={s.videoStatus !== "idle" ? s.videoStatus : s.imageStatus} />
      </div>

      <div className="scene-body">
        <div className="scene-head">
          <span className="scene-tag">#{s.number}</span>
          <Editable className="title-input" value={s.title} onSave={(title) => onPatch({ title })} />
          <select className="duration" value={s.durationSec} onChange={(e) => onPatch({ durationSec: Number(e.target.value) as Duration })}>
            {DURATIONS.map((d) => <option key={d} value={d}>{d}s</option>)}
          </select>
        </div>

        <div className="scene-meta">
          {s.location && <span className="meta">📍 {s.location}</span>}
          {cast.map((c) => <span key={c.id} className="chip on static">{c.name}</span>)}
          {shown.map((x) => (
            <span key={x.id} className="chip on static product-chip" title={x.locked ? "Locked: in every scene" : "In this scene"}>
              {x.locked ? "🔒" : "📦"} {x.name}
            </span>
          ))}
        </div>

        <p className="action">{s.action}</p>
        {s.dialogue && <p className="dialogue">{s.dialogue}</p>}

        {open && (
          <div className="prompts">
            <label className="field">
              <span>Characters in this shot</span>
              <div className="chips">
                {project.characters.map((c) => {
                  const on = s.characterIds.includes(c.id);
                  return (
                    <button key={c.id} className={`chip ${on ? "on" : ""}`}
                      onClick={() => onPatch({ characterIds: on ? s.characterIds.filter((x) => x !== c.id) : [...s.characterIds, c.id] })}>
                      {c.name}
                    </button>
                  );
                })}
              </div>
            </label>
            {products.length > 0 && (
              <label className="field">
                <span>Products in this shot</span>
                <div className="chips">
                  {products.map((x) => {
                    const on = x.locked || !!s.productIds?.includes(x.id);
                    return (
                      <button key={x.id} className={`chip product-chip ${on ? "on" : ""}`} disabled={x.locked}
                        title={x.locked ? "Locked to every scene (unlock it on the Cast & Products tab)" : ""}
                        onClick={() => onPatch({ productIds: on ? (s.productIds ?? []).filter((y) => y !== x.id) : [...(s.productIds ?? []), x.id] })}>
                        {x.locked ? "🔒" : "📦"} {x.name}
                      </button>
                    );
                  })}
                </div>
              </label>
            )}
            <label className="field"><span>Action</span><Editable multiline rows={2} value={s.action} onSave={(action) => onPatch({ action })} /></label>
            <div className="row">
              <label className="field grow"><span>Location</span><Editable value={s.location} onSave={(location) => onPatch({ location })} /></label>
              <label className="field grow"><span>Shot & camera</span><Editable value={s.shot} onSave={(shot) => onPatch({ shot })} /></label>
            </div>
            <label className="field"><span>Frame prompt (still image)</span><Editable multiline rows={4} value={s.imagePrompt} onSave={(imagePrompt) => onPatch({ imagePrompt })} /></label>
            <label className="field"><span>Clip prompt (motion)</span><Editable multiline rows={4} value={s.videoPrompt} onSave={(videoPrompt) => onPatch({ videoPrompt })} /></label>
            <div className="row">
              <label className="field grow"><span>Dialogue</span><Editable value={s.dialogue} onSave={(dialogue) => onPatch({ dialogue })} /></label>
              <label className="field grow"><span>Sound</span><Editable value={s.sound} onSave={(sound) => onPatch({ sound })} /></label>
            </div>
          </div>
        )}

        {s.error && <div className="error-text small">{s.error}</div>}

        <div className="scene-actions">
          <button className="btn small" onClick={() => onRender("image")} disabled={isBusy(s.imageStatus)}>
            <RenderLabel status={s.imageStatus} idle={s.imageFile ? "Re-render frame" : "Render frame"} running="Rendering frame…" />
          </button>
          <button className="btn small primary" onClick={() => onRender("video")} disabled={isBusy(s.videoStatus)}>
            <RenderLabel status={s.videoStatus} idle={s.videoFile ? "Re-render clip" : `Render ${s.durationSec}s clip`} running="Rendering clip…" />
          </button>
          <button className="btn small ghost" onClick={onToggle}>{open ? "Done editing" : "Edit prompts"}</button>
          <span className="grow" />
          <button className="icon-btn" title="Move up" disabled={first} onClick={() => onMove("up")}>↑</button>
          <button className="icon-btn" title="Move down" disabled={last} onClick={() => onMove("down")}>↓</button>
          <button className="icon-btn" title="Add scene after" onClick={onAddAfter}>+</button>
          <button className="icon-btn danger" title="Delete scene" onClick={onDelete}>×</button>
        </div>
      </div>
    </article>
  );
}

const formatTime = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
