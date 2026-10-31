import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CutItem, ExportResolution, FinalCut, Job, Project } from "../../../shared/types";
import { api, fileUrl } from "../api";

interface Props {
  project: Project;
  jobs: Job[];
  onChange: (p: Project) => void;
  onError: (msg: string) => void;
}

/** A timeline clip with where it sits in the whole film. */
interface Seg {
  item: CutItem;
  url: string;
  start: number;
  len: number;
}

/** Unsaved timelines by project, so switching tabs doesn't lose them. */
const drafts = new Map<string, FinalCut>();
/** Undo steps by project, kept across tab switches too. */
const histories = new Map<string, FinalCut[]>();
/** Pieces must be at least this long (the server holds the same limit). */
const MIN_PIECE = 0.5;

const RESOLUTIONS: { id: ExportResolution; title: string; note: string }[] = [
  { id: "720p", title: "720p", note: "Flow's originals. Fastest." },
  { id: "1080p", title: "1080p HD", note: "Flow's AI upscale of each clip. Recommended." },
  { id: "4k", title: "4K", note: "Enlarged from Flow's 1080p. Bigger file, no new detail." },
];

export function FinalCutTab({ project, jobs, onChange, onError }: Props) {
  const id = project.id;
  const [cut, setCut] = useState<FinalCut | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pps, setPps] = useState(48); // timeline pixels per second
  const [resolution, setResolution] = useState<ExportResolution>("1080p");
  const [watching, setWatching] = useState<string | null>(null);
  const [saved, setSaved] = useState(""); // the timeline as last saved, to tell if there are changes
  const [saving, setSaving] = useState(false);
  const [cutMode, setCutMode] = useState(false);
  const history = useRef<FinalCut[]>([]);
  if (!histories.has(id)) histories.set(id, []);
  history.current = histories.get(id)!;

  // Reload when a clip is rendered or re-rendered on the storyboard (unsaved edits are kept).
  const clipsKey = project.scenes.map((s) => s.videoFile ?? "").join("|");
  useEffect(() => {
    api
      .finalCut(id)
      .then((c) => {
        setSaved(JSON.stringify(c));
        setCut(drafts.get(id) ?? c);
      })
      .catch((e) => onError(e.message));
  }, [id, clipsKey]);
  const dirty = Boolean(cut) && JSON.stringify(cut) !== saved;

  // Closing or reloading the page with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const segs: Seg[] = useMemo(() => {
    let start = 0;
    return (cut?.items ?? []).map((item) => {
      const len = Math.max(0.1, item.outSec - item.inSec);
      const seg = { item, url: fileUrl(id, "renders", item.file), start, len };
      start += len;
      return seg;
    });
  }, [cut, id]);
  const total = segs.reduce((t, s) => t + s.len, 0);

  /** Apply an edit (kept as an unsaved change until you save). */
  const edit = (next: FinalCut) => {
    if (cut) {
      history.current.push(cut);
      if (history.current.length > 50) history.current.shift();
    }
    drafts.set(id, next);
    setCut(next);
  };
  const save = async () => {
    if (!cut) return;
    setSaving(true);
    try {
      const out = await api.saveFinalCut(id, cut);
      drafts.delete(id);
      setSaved(JSON.stringify(out));
      setCut(out);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const undo = () => {
    const prev = history.current.pop();
    if (!prev) return;
    drafts.set(id, prev);
    setCut(prev);
  };
  const discard = () => {
    if (!confirm("Throw away your unsaved timeline changes?")) return;
    drafts.delete(id);
    history.current.length = 0;
    setCut(JSON.parse(saved));
  };
  /** Cut one clip in two at a point in its own time (seconds into the clip file). */
  const split = (itemId: string, at: number) => {
    if (!cut) return;
    const it = cut.items.find((i) => i.id === itemId);
    if (!it) return;
    if (at - it.inSec < MIN_PIECE || it.outSec - at < MIN_PIECE) {
      return onError(`Too close to the clip's edge to cut there: each piece needs at least ${MIN_PIECE}s.`);
    }
    const at2 = Math.round(at * 100) / 100;
    const piece: CutItem = { ...it, id: `${it.id.slice(0, 20)}-${Math.random().toString(36).slice(2, 8)}`, inSec: at2 };
    const items = cut.items.flatMap((i) => (i.id === itemId ? [{ ...i, outSec: at2 }, piece] : [i]));
    edit({ ...cut, items });
    setSelected(piece.id);
  };

  // Ctrl+S saves, Ctrl+Z undoes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const tag = (e.target as HTMLElement).tagName;
      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) void save();
      } else if (e.key.toLowerCase() === "z" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const patchItem = (itemId: string, patch: Partial<CutItem>) =>
    cut && edit({ ...cut, items: cut.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i)) });
  const move = (itemId: string, to: number) => {
    if (!cut) return;
    const items = [...cut.items];
    const from = items.findIndex((i) => i.id === itemId);
    if (from < 0 || to < 0 || to >= items.length) return;
    const [it] = items.splice(from, 1);
    items.splice(to, 0, it);
    edit({ ...cut, items });
  };
  const remove = (itemId: string) => {
    if (!cut) return;
    const it = cut.items.find((i) => i.id === itemId);
    if (!it) return;
    edit({ items: cut.items.filter((i) => i.id !== itemId), removed: [it, ...cut.removed] });
    setSelected(null);
  };
  const restore = (itemId: string) => {
    if (!cut) return;
    const it = cut.removed.find((i) => i.id === itemId);
    if (!it) return;
    // Back where it belongs in story order.
    const order = project.scenes.map((s) => s.id);
    const pos = cut.items.findLastIndex((i) => order.indexOf(i.sceneId) < order.indexOf(it.sceneId));
    const items = [...cut.items];
    items.splice(pos + 1, 0, it);
    edit({ items, removed: cut.removed.filter((i) => i.id !== itemId) });
  };
  const reset = async () => {
    if (!confirm("Put every rendered clip back in storyboard order, untrimmed? This also undoes your cuts and saves.")) return;
    const out = await api.resetFinalCut(id);
    drafts.delete(id);
    history.current.length = 0;
    setSaved(JSON.stringify(out));
    setCut(out);
  };

  const exportJob = jobs.findLast((j) => j.kind === "export");
  const exporting = exportJob && (exportJob.status === "queued" || exportJob.status === "running");
  // e.g. a clip that couldn't be upscaled and used its original: say so where you'll see it.
  const exportNote = exportJob?.status === "done" && exportJob.progress.includes("Note:") ? exportJob.progress : "";
  // Export what you see: unsaved changes are saved first.
  const startExport = () => {
    const before = dirty ? save() : Promise.resolve();
    before.then(() => api.exportCut(id, resolution)).catch((e) => onError(e.message));
  };

  const sceneOf = (it: CutItem) => project.scenes.find((s) => s.id === it.sceneId);
  const sel = segs.find((s) => s.item.id === selected);

  if (!cut) return <div className="tab-body"><div className="empty">Loading the timeline…</div></div>;
  if (!segs.length && !cut.removed.length) {
    return (
      <div className="tab-body">
        <div className="empty">
          No clips yet. Render clips on the Storyboard tab and they'll appear here, in order, ready to edit and export.
        </div>
      </div>
    );
  }

  return (
    <div className="tab-body">
      <div className={`save-bar ${dirty ? "dirty" : ""}`}>
        <span className="save-state">{dirty ? "● Unsaved changes" : "✓ All changes saved"}</span>
        <span className="grow" />
        <button className="btn small ghost" onClick={undo} disabled={!history.current.length} title="Undo the last edit (Ctrl+Z)">↶ Undo</button>
        <button className="btn small ghost" onClick={discard} disabled={!dirty}>Discard</button>
        <button className="btn small primary" onClick={save} disabled={!dirty || saving} title="Save the timeline (Ctrl+S)">
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
      <Player segs={segs} total={total} aspect={project.settings.aspectRatio} selected={selected} onSelect={setSelected}
        pps={pps} setPps={setPps} sceneOf={sceneOf} projectId={id} onMove={move}
        cutMode={cutMode} setCutMode={setCutMode} onSplit={split} />

      {sel ? (
        <section className="card inspector">
          <div className="card-head">
            <h3>
              Clip {segs.indexOf(sel) + 1}: #{sceneOf(sel.item)?.number} {sceneOf(sel.item)?.title}
            </h3>
            <span className="muted small">
              Uses {fmt(sel.len)} of {fmt(sel.item.duration)}
            </span>
          </div>
          <div className="trim">
            <label className="field">
              <span>Start at {sel.item.inSec.toFixed(2)}s</span>
              <input type="range" min={0} max={sel.item.duration} step={0.05} value={sel.item.inSec}
                onChange={(e) => patchItem(sel.item.id, { inSec: Math.min(Number(e.target.value), sel.item.outSec - 0.5) })} />
            </label>
            <label className="field">
              <span>End at {sel.item.outSec.toFixed(2)}s</span>
              <input type="range" min={0} max={sel.item.duration} step={0.05} value={sel.item.outSec}
                onChange={(e) => patchItem(sel.item.id, { outSec: Math.max(Number(e.target.value), sel.item.inSec + 0.5) })} />
            </label>
          </div>
          <div className="row tight wrap">
            <button className="btn small" disabled={segs.indexOf(sel) === 0} onClick={() => move(sel.item.id, segs.indexOf(sel) - 1)}>◀ Move earlier</button>
            <button className="btn small" disabled={segs.indexOf(sel) === segs.length - 1} onClick={() => move(sel.item.id, segs.indexOf(sel) + 1)}>Move later ▶</button>
            <button className="btn small ghost" onClick={() => patchItem(sel.item.id, { inSec: 0, outSec: sel.item.duration })}>Reset trim</button>
            <span className="grow" />
            <button className="btn small ghost danger" onClick={() => remove(sel.item.id)}>Delete from timeline</button>
          </div>
          {sceneOf(sel.item)?.continuesPrevious && sel.item.inSec > 0 && (
            <p className="muted small">This clip continues seamlessly from the one before; trimming its start will show a jump at that cut.</p>
          )}
        </section>
      ) : (
        <p className="muted small">
          Click a clip on the timeline to trim, move or delete it. Drag clips to reorder. Click the ruler to jump there.
          To cut a clip in two, use <b>✂ Split at playhead</b> (or press S), or turn on <b>✂ Cut tool</b> and click where to cut.
        </p>
      )}

      {cut.removed.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Deleted from the timeline</h3><span className="muted small">The clips are still on the storyboard</span></div>
          <div className="chips">
            {cut.removed.map((it) => (
              <button key={it.id} className="chip" onClick={() => restore(it.id)} title="Put it back on the timeline">
                ↺ #{sceneOf(it)?.number} {sceneOf(it)?.title} ({fmt(it.outSec - it.inSec)})
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h3>Export MP4</h3>
          <button className="btn small ghost" onClick={reset}>Reset timeline to storyboard</button>
        </div>
        <div className="res-grid">
          {RESOLUTIONS.map((r) => (
            <button key={r.id} className={`res ${resolution === r.id ? "on" : ""}`} onClick={() => setResolution(r.id)}>
              <b>{r.title}</b>
              <span className="muted small">{r.note}</span>
            </button>
          ))}
        </div>
        <div className="generate-bar static">
          <span className={exportJob?.status === "failed" ? "error-text" : exporting ? "pulse" : exportNote ? "warn-text small" : "muted small"}>
            {exportJob?.status === "failed"
              ? exportJob.error
              : exporting
                ? exportJob!.progress
                : exportNote
                  ? exportNote
                : `${segs.length} clips · ${fmt(total)}${resolution !== "720p" ? " · the first 1080p export takes about a minute per clip while Flow upscales" : ""}`}
          </span>
          <button className="btn primary big" onClick={startExport} disabled={!segs.length || !!exporting}>
            {exporting ? "Exporting…" : `Export ${resolution === "4k" ? "4K" : resolution} MP4`}
          </button>
        </div>

        {(project.exports ?? []).length > 0 && (
          <ul className="exports">
            {project.exports!.map((x) => (
              <li key={x.file}>
                <span className="badge done">{x.resolution === "4k" ? "4K" : x.resolution}</span>
                <span className="grow">
                  <b>{x.file}</b>
                  <span className="muted small"> · {x.width}×{x.height} · {fmt(x.duration)} · {(x.sizeBytes / 1e6).toFixed(1)} MB · {new Date(x.createdAt).toLocaleString()}</span>
                </span>
                <button className="btn small ghost" onClick={() => setWatching(watching === x.file ? null : x.file)}>
                  {watching === x.file ? "Close" : "Watch"}
                </button>
                <a className="btn small" href={`${fileUrl(id, "exports", x.file)}?download=1`}>Download</a>
                <button className="icon-btn danger" title="Delete this export"
                  onClick={() => confirm(`Delete ${x.file}?`) && api.deleteExport(id, x.file).then(onChange).catch((e) => onError(e.message))}>
                  ×
                </button>
                {watching === x.file && <video className="export-video" src={fileUrl(id, "exports", x.file)} controls autoPlay />}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Plays the timeline as one film. Two <video> elements take turns: while one plays, the next clip waits,
 * already loaded and cued to its start in the other, so cuts land without a gap.
 */
function Player({ segs, total, aspect, selected, onSelect, pps, setPps, sceneOf, projectId, onMove, cutMode, setCutMode, onSplit }: {
  segs: Seg[];
  total: number;
  aspect: Project["settings"]["aspectRatio"];
  selected: string | null;
  onSelect: (id: string | null) => void;
  pps: number;
  setPps: (n: number) => void;
  sceneOf: (it: CutItem) => Project["scenes"][number] | undefined;
  projectId: string;
  onMove: (itemId: string, to: number) => void;
  cutMode: boolean;
  setCutMode: (on: boolean) => void;
  onSplit: (itemId: string, at: number) => void;
}) {
  const [hoverX, setHoverX] = useState<number | null>(null);
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);
  const [slot, setSlot] = useState(0); // which element is on screen
  const [idx, setIdx] = useState(0); // which timeline clip it holds
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dragging, setDragging] = useState<string | null>(null);
  const live = useRef({ slot: 0, idx: 0, playing: false });
  live.current = { slot, idx, playing };
  const els = () => [a.current!, b.current!];

  /** Load a clip into an element and park it at a time; resolves once that frame is ready. */
  const cue = useCallback((v: HTMLVideoElement, url: string, time: number) => {
    return new Promise<void>((resolve) => {
      const seek = () => {
        v.currentTime = time;
        v.addEventListener("seeked", () => resolve(), { once: true });
      };
      if (v.dataset.url !== url) {
        v.dataset.url = url;
        v.src = url;
        v.addEventListener("loadedmetadata", seek, { once: true });
      } else if (v.readyState >= 1) seek();
      else v.addEventListener("loadedmetadata", seek, { once: true });
    });
  }, []);

  /** Jump to a point in the whole film. */
  const seek = useCallback(
    async (global: number) => {
      if (!segs.length) return;
      const g = Math.min(Math.max(0, global), total - 0.01);
      const i = Math.max(0, segs.findLastIndex((s) => s.start <= g));
      const s = segs[i];
      const [cur, other] = live.current.slot === 0 ? els() : els().reverse();
      const wasPlaying = live.current.playing;
      cur.pause();
      setT(g);
      setIdx(i);
      await cue(cur, s.url, s.item.inSec + (g - s.start));
      if (segs[i + 1]) void cue(other, segs[i + 1].url, segs[i + 1].item.inSec);
      if (wasPlaying) void cur.play();
    },
    [segs, total, cue],
  );

  // Re-cue when the timeline changes (trim, reorder, delete), keeping roughly the same spot.
  const segKey = segs.map((s) => `${s.item.id}:${s.item.inSec}:${s.item.outSec}`).join("|");
  useEffect(() => {
    void seek(Math.min(t, Math.max(0, total - 0.01)));
  }, [segKey]);

  // While playing, follow the clock every frame and switch clips exactly at each out point.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const { slot: sl, idx: i } = live.current;
      const v = els()[sl];
      const s = segs[i];
      if (!s) return;
      if (v.currentTime >= s.item.outSec - 0.03 || v.ended) {
        const next = segs[i + 1];
        if (!next) {
          v.pause();
          setPlaying(false);
          setT(total);
          return;
        }
        const nv = els()[1 - sl];
        void nv.play();
        v.pause();
        setSlot(1 - sl);
        setIdx(i + 1);
        live.current = { slot: 1 - sl, idx: i + 1, playing: true };
        if (segs[i + 2]) void cue(v, segs[i + 2].url, segs[i + 2].item.inSec);
      } else {
        setT(s.start + Math.max(0, v.currentTime - s.item.inSec));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, segs, total, cue]);

  const toggle = async () => {
    const v = els()[slot];
    if (playing) {
      v.pause();
      setPlaying(false);
    } else {
      if (t >= total - 0.05) await seek(0);
      setPlaying(true);
      void els()[live.current.slot].play();
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (e.code === "Space" && !typing) {
        e.preventDefault();
        void toggle();
      } else if (e.key.toLowerCase() === "s" && !typing && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        splitAtPlayhead();
      } else if (e.key === "Escape" && cutMode) {
        setCutMode(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** Cut the clip under the playhead there. */
  const splitAtPlayhead = () => {
    const s = segs.find((x) => t >= x.start && t < x.start + x.len) ?? segs[segs.length - 1];
    if (s) onSplit(s.item.id, s.item.inSec + (t - s.start));
  };

  const width = Math.max(total * pps, 200);
  const ticks = Array.from({ length: Math.floor(total) + 1 }, (_, i) => i);

  return (
    <section className="card player-card">
      <div className={`player ${aspect === "9:16" ? "v" : "h"}`}>
        <video ref={a} className={slot === 0 ? "on" : ""} playsInline preload="auto" />
        <video ref={b} className={slot === 1 ? "on" : ""} playsInline preload="auto" />
      </div>
      <div className="transport">
        <button className="icon-btn big" title="Back to start" onClick={() => seek(0)}>⏮</button>
        <button className="btn primary play" onClick={toggle}>{playing ? "❚❚ Pause" : "▶ Play"}</button>
        <button className="icon-btn big" title="Next clip" onClick={() => segs[idx + 1] && seek(segs[idx + 1].start)}>⏭</button>
        <span className="timecode">{fmt(t)} / {fmt(total)}</span>
        <button className="btn small" onClick={splitAtPlayhead} title="Cut the clip under the playhead in two (S)">✂ Split at playhead</button>
        <button className={`btn small ${cutMode ? "primary" : "ghost"}`} onClick={() => setCutMode(!cutMode)}
          title="Scissors: click anywhere on a clip to cut it there (Esc to stop)">
          ✂ Cut tool{cutMode ? ": on" : ""}
        </button>
        <span className="grow" />
        <span className="muted small">Zoom</span>
        <button className="icon-btn" onClick={() => setPps(Math.max(12, pps / 1.5))}>−</button>
        <button className="icon-btn" onClick={() => setPps(Math.min(200, pps * 1.5))}>+</button>
      </div>

      <div className="timeline">
        <div className="tl-inner" style={{ width }}>
          <div className="ruler" onClick={(e) => seek((e.clientX - e.currentTarget.getBoundingClientRect().left) / pps)}>
            {ticks.map((s) => (
              <span key={s} className={`tick ${s % 2 === 0 ? "major" : ""}`} style={{ left: s * pps }}>
                {s % 2 === 0 && <i>{fmt(s)}</i>}
              </span>
            ))}
          </div>
          <div className={`track ${cutMode ? "cutting" : ""}`}
            onMouseMove={(e) => cutMode && setHoverX(e.clientX - e.currentTarget.getBoundingClientRect().left)}
            onMouseLeave={() => setHoverX(null)}>
            {cutMode && hoverX !== null && <div className="cut-line" style={{ left: hoverX }} />}
            {segs.map((s, i) => {
              const sc = sceneOf(s.item);
              const thumb = sc?.imageFile ? fileUrl(projectId, "renders", sc.imageFile) : undefined;
              return (
                <div
                  key={s.item.id}
                  className={`clip ${selected === s.item.id ? "sel" : ""} ${i === idx ? "current" : ""} ${dragging === s.item.id ? "dragging" : ""}`}
                  style={{ width: s.len * pps, backgroundImage: thumb ? `url(${thumb})` : undefined }}
                  draggable={!cutMode}
                  onDragStart={(e) => {
                    setDragging(s.item.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => setDragging(null)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragging && dragging !== s.item.id) onMove(dragging, i);
                    setDragging(null);
                  }}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    const into = ((e.clientX - r.left) / r.width) * s.len;
                    if (cutMode) {
                      onSplit(s.item.id, s.item.inSec + into);
                      void seek(s.start + into);
                      return;
                    }
                    onSelect(selected === s.item.id ? null : s.item.id);
                    void seek(s.start + into);
                  }}
                  title={`#${sc?.number} ${sc?.title} · ${fmt(s.len)}`}
                >
                  <span className="clip-label">#{sc?.number} {sc?.title}</span>
                  <span className="clip-len">{s.len.toFixed(1)}s</span>
                  {sc?.continuesPrevious && i > 0 && <span className="clip-link" title="Continues seamlessly from the previous scene">🔗</span>}
                </div>
              );
            })}
          </div>
          <div className="playhead" style={{ left: t * pps }} />
        </div>
      </div>
    </section>
  );
}

function fmt(sec: number) {
  const s = Math.max(0, sec);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}
