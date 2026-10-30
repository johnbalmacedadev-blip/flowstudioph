import { useEffect, useRef, useState } from "react";
import {
  DURATIONS, type FlowStatus, type Job, type Project, type ReferenceKind, type SecondsSetting, type StoryboardEngine,
} from "../../../shared/types";
import { api, fileUrl } from "../api";
import { Editable } from "./Editable";

const KINDS: ReferenceKind[] = ["character", "product", "location", "style", "prop"];

interface Props {
  project: Project;
  jobs: Job[];
  flow: FlowStatus | null;
  onChange: (p: Project) => void;
  onError: (msg: string) => void;
  onDone: () => void;
}

export function ScriptTab({ project, jobs, flow, onChange, onError, onDone }: Props) {
  const [script, setScript] = useState(project.script);
  const [kind, setKind] = useState<ReferenceKind>("character");
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const id = project.id;

  useEffect(() => setScript(project.script), [project.id]);

  const job = jobs.find((j) => j.id === jobId) ?? jobs.findLast((j) => j.kind === "breakdown");
  const running = job?.status === "running" || job?.status === "queued";
  const engine: StoryboardEngine = project.settings.engine ?? "flow";

  useEffect(() => {
    if (jobId && job?.id === jobId && job.status === "done") {
      setJobId(null);
      onDone();
    }
  }, [job?.status]);

  const run = (p: Promise<Project>) => p.then(onChange).catch((e) => onError(e.message));
  const saveScript = () => script !== project.script && run(api.updateProject(id, { script }));
  const setSetting = (patch: Partial<Project["settings"]>) => run(api.updateProject(id, { settings: patch }));

  const upload = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return onError("Only image files can be used as references.");
    setUploading(true);
    await run(api.uploadRefs(id, images, kind));
    setUploading(false);
  };

  const generate = async () => {
    if (engine === "flow" && !flow?.signedIn) {
      return onError("Connect Google Flow first (top right), or switch the storyboard engine to Quick split.");
    }
    if (project.scenes.length && !confirm("This replaces the current characters and scenes with a new storyboard. Continue?")) return;
    try {
      if (script !== project.script) onChange(await api.updateProject(id, { script }));
      setJobId((await api.breakdown(id)).id);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const words = script.trim() ? script.trim().split(/\s+/).length : 0;

  return (
    <div className="tab-body">
      <section className="card">
        <div className="row wrap">
          <label className="field grow">
            <span>Project name</span>
            <Editable value={project.name} onSave={(name) => run(api.updateProject(id, { name }))} />
          </label>
          <label className="field">
            <span>Video style</span>
            <div className="segmented">
              <button className={(project.settings.videoStyle ?? "cinematic") === "cinematic" ? "on" : ""}
                onClick={() => setSetting({ videoStyle: "cinematic" })} title="Film-like shots: composed framing, camera moves, graded light.">
                🎬 Cinematic
              </button>
              <button className={project.settings.videoStyle === "ugc" ? "on" : ""}
                onClick={() => setSetting({ videoStyle: "ugc", aspectRatio: "9:16" })}
                title="Creator-style phone video: handheld, talking to camera, natural light, real places, hook and call to action. Switches to 9:16.">
                📱 UGC
              </button>
            </div>
          </label>
          <label className="field">
            <span>Aspect ratio</span>
            <div className="segmented">
              {(["16:9", "9:16"] as const).map((a) => (
                <button key={a} className={project.settings.aspectRatio === a ? "on" : ""} onClick={() => setSetting({ aspectRatio: a })}>
                  {a === "16:9" ? "16:9 Landscape" : "9:16 Vertical"}
                </button>
              ))}
            </div>
          </label>
          <label className="field">
            <span>Seconds per scene</span>
            <select
              value={String(project.settings.seconds)}
              onChange={(e) => setSetting({ seconds: (e.target.value === "auto" ? "auto" : Number(e.target.value)) as SecondsSetting })}
            >
              {DURATIONS.map((d) => <option key={d} value={d}>{d} seconds</option>)}
              <option value="auto">Let the storyboard choose</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>Visual style <span className="muted">(optional)</span></span>
          <Editable
            value={project.settings.style}
            placeholder="e.g. Cinematic, warm Manila golden hour, 35mm film grain, shallow depth of field"
            onSave={(style) => setSetting({ style })}
          />
        </label>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Script, workflow or master prompt</h3>
          <span className="muted small">{words.toLocaleString()} words</span>
        </div>
        <textarea
          className="script"
          value={script}
          onChange={(e) => setScript(e.target.value)}
          onBlur={saveScript}
          placeholder={"Paste anything: a screenplay, a scene-by-scene workflow, or one long master prompt.\n\nExample:\nA 60-second ad for a Filipino coffee brand. Open on a jeepney at sunrise in Quezon City…"}
        />
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Reference images</h3>
          <div className="row tight">
            <span className="muted small">Upload as</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as ReferenceKind)}>
              {KINDS.map((k) => <option key={k}>{k}</option>)}
            </select>
          </div>
        </div>
        <p className="muted small">
          Name each image after who or what it shows (e.g. "Lola Nena", "Sari-sari store"). The storyboard matches those names to
          the script, and Flow uses the images to keep characters and places consistent.
        </p>
        <div
          className={`dropzone ${dragging ? "drag" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); upload([...e.dataTransfer.files]); }}
          onClick={() => fileInput.current?.click()}
        >
          {uploading ? "Uploading…" : "Drop images here or click to choose"}
          <input ref={fileInput} type="file" accept="image/*" multiple hidden
            onChange={(e) => { upload([...(e.target.files ?? [])]); e.target.value = ""; }} />
        </div>
        {project.references.length > 0 && (
          <div className="ref-grid">
            {project.references.map((r) => (
              <div key={r.id} className="ref">
                <img src={fileUrl(id, "refs", r.file)} alt={r.label} />
                <Editable value={r.label} onSave={(label) => run(api.updateRef(id, r.id, { label }))} />
                <div className="row tight">
                  <select value={r.kind} onChange={(e) => run(api.updateRef(id, r.id, { kind: e.target.value as ReferenceKind }))}>
                    {KINDS.map((k) => <option key={k}>{k}</option>)}
                  </select>
                  <button className="icon-btn" title="Remove" onClick={() => run(api.deleteRef(id, r.id))}>×</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="generate-bar">
        <div className="engine">
          <div className="segmented">
            <button className={engine === "claude" ? "on" : ""} onClick={() => setSetting({ engine: "claude" })} disabled={running}
              title="Claude Code (the chat you build this app with) writes the storyboard and loads it here. Fast and reliable, no API key.">
              🤖 Claude Code
            </button>
            <button className={engine === "flow" ? "on" : ""} onClick={() => setSetting({ engine: "flow" })} disabled={running}
              title="Google Flow's own AI (Gemini) writes the storyboard in your signed-in Flow account. Free, no API key.">
              ✨ Flow AI
            </button>
            <button className={engine === "local" ? "on" : ""} onClick={() => setSetting({ engine: "local" })} disabled={running}
              title="Splits the script on this computer without AI: follows scene headings, numbered shots, NAME: dialogue and paragraphs.">
              ⚡ Quick split
            </button>
          </div>
          {running ? (
            <span className="pulse">{job?.progress}</span>
          ) : job?.status === "failed" ? (
            <span className="error-text">{job.error}</span>
          ) : (
            <span className="muted small">
              {engine === "claude"
                ? "Ask Claude Code (below) and it writes the cast and scene list and loads them here. No API key"
                : engine === "flow"
                  ? "Google Flow's own AI writes the cast and scene list in your Flow account. Free, no API key; takes a minute or two"
                  : "Splits your script on this computer, no AI. Instant; best for scripts already written scene by scene"}
              {project.settings.seconds === "auto" ? ", with a length chosen for each scene" : `, every scene ${project.settings.seconds}s`}.
            </span>
          )}
        </div>
        {engine !== "claude" && (
          <button className="btn primary big" onClick={generate} disabled={running || !script.trim()}>
            {running ? "Generating…" : project.scenes.length ? "Regenerate storyboard" : "Generate storyboard"}
          </button>
        )}
      </div>
      {engine === "claude" && <ClaudeCodePanel project={project} onLoaded={(p) => { onChange(p); onDone(); }} onError={onError} />}
    </div>
  );
}

/**
 * The Claude Code engine: the storyboard is written in the Claude Code chat for this folder (the "storyboard"
 * skill in .claude/skills) and arrives through the import endpoint. Pasting JSON works too.
 */
function ClaudeCodePanel({ project, onLoaded, onError }: {
  project: Project;
  onLoaded: (p: Project) => void;
  onError: (msg: string) => void;
}) {
  const [json, setJson] = useState("");
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const request = `Storyboard my Flow Studio PH project "${project.name}" and load it into the app.`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(request);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      onError("Couldn't copy. Select the text and copy it by hand.");
    }
  };
  const load = async () => {
    if (project.scenes.length && !confirm("This replaces the current characters and scenes. Continue?")) return;
    setLoading(true);
    try {
      onLoaded(await api.importStoryboard(project.id, json));
      setJson("");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="card claude-panel">
      <div className="card-head"><h3>🤖 Storyboard with Claude Code</h3></div>
      <ol className="steps compact">
        <li>Save your script above (it saves when you click away).</li>
        <li>
          In the Claude Code chat for this folder, send:
          <div className="copy-row">
            <code>{request}</code>
            <button className="btn small" onClick={copy}>{copied ? "✓ Copied" : "Copy"}</button>
          </div>
        </li>
        <li>Claude reads your script and reference images, writes the cast and scenes, and loads them here. The Storyboard tab updates by itself.</li>
      </ol>
      <details>
        <summary className="muted small">Or paste storyboard JSON</summary>
        <textarea rows={6} value={json} onChange={(e) => setJson(e.target.value)}
          placeholder='{"title":"…","characters":[…],"scenes":[…]}' />
        <button className="btn small" onClick={load} disabled={!json.trim() || loading}>{loading ? "Loading…" : "Load storyboard"}</button>
      </details>
    </section>
  );
}
