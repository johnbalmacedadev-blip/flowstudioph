import { chosenRefKeys, MAX_REFS, refOptions } from "../../../shared/attachments";
import type { Project, Scene } from "../../../shared/types";
import { fileUrl } from "../api";

/**
 * The images a scene sends to Flow. Ticks start as the app's own pick ("Auto"); changing one makes the scene
 * "Custom" and it sends exactly what's ticked. Unticking all of a product's images takes the product out of the
 * shot (even a locked one). 📌 pins an image as the scene's exact frame: no frame is generated, the clip starts
 * on that image as-is.
 */
export function SceneRefs({ project, scene: s, onChange, onExact }: {
  project: Project;
  scene: Scene;
  onChange: (keys: string[] | null) => void;
  onExact: (key: string | null) => void;
}) {
  const options = refOptions(project, s);
  if (!options.length) return null;
  const chosen = chosenRefKeys(project, s, true);
  const full = chosen.length >= MAX_REFS;
  const custom = Boolean(s.refOverride);
  const exact = options.find((o) => o.key === s.exactFrameKey);
  const hasStart = Boolean(s.imageFile) || s.continuesPrevious;

  const toggle = (key: string) => {
    const on = chosen.includes(key);
    if (!on && full) return;
    onChange(on ? chosen.filter((k) => k !== key) : [...chosen, key]);
  };

  return (
    <div className={`scene-refs ${exact ? "exact" : ""}`}>
      <div className="refs-head">
        <span className="refs-title">Images sent to Flow</span>
        {exact ? (
          <span className="badge exact">📌 Exact frame</span>
        ) : (
          <>
            <span className={`badge ${custom ? "queued" : "done"}`}>{custom ? "Custom" : "Auto"}</span>
            <span className="muted small">{chosen.length} of {MAX_REFS}</span>
            {custom && <button className="link small" onClick={() => onChange(null)}>Reset to auto</button>}
          </>
        )}
      </div>
      <div className="refs-row">
        {options.map((o) => {
          const on = !exact && chosen.includes(o.key);
          const pinned = o.key === s.exactFrameKey;
          return (
            <div key={o.key} className={`ref-pick-wrap ${pinned ? "pinned" : ""}`}>
              <button
                className={`ref-pick ${on || pinned ? "on" : ""}`}
                disabled={Boolean(exact) || (!on && full)}
                onClick={() => toggle(o.key)}
                title={
                  exact ? "This scene uses an exact frame, so no other images are sent. Unpin it to choose images again."
                  : `${o.group}: ${o.label}${on ? " (sent to Flow; click to leave it out)" : full ? " (3 already picked: untick one first)" : " (click to send it)"}`
                }
              >
                <img src={fileUrl(project.id, o.folder, o.file)} alt={o.label} />
                {(on || pinned) && <span className="tick">{pinned ? "📌" : "✓"}</span>}
                <span className="ref-cap">{o.label}</span>
              </button>
              <button
                className={`pin ${pinned ? "on" : ""}`}
                onClick={() => onExact(pinned ? null : o.key)}
                title={pinned
                  ? "Unpin: this scene's frame will be generated again (re-render the frame)"
                  : "Use this exact image as the scene's frame: no new image is generated, and the clip starts on it"}
              >
                {pinned ? "Unpin" : "📌 Exact"}
              </button>
            </div>
          );
        })}
      </div>
      {exact ? (
        <p className="muted small">
          This scene uses <b>{exact.label}</b> exactly as it is for its frame: nothing is generated for the frame, and the
          clip starts on it, with Flow told to keep it unchanged and move gently.
        </p>
      ) : hasStart ? (
        <p className="muted small">
          These go into this scene's frame. Its clip starts from that frame{s.continuesPrevious ? " (or the previous clip's last frame)" : ""},
          so whatever is in the frame is in the clip. 📌 Exact uses an image as the frame itself, without redrawing it.
        </p>
      ) : null}
    </div>
  );
}
