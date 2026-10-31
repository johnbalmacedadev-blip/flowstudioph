import { useState } from "react";
import { chosenRefKeys, exactKeys, hiddenRefOptions, MAX_REFS, refOptions } from "../../../shared/attachments";
import type { Project, Scene } from "../../../shared/types";
import { fileUrl } from "../api";

/**
 * The images a scene sends to Flow. Ticks start as the app's own pick ("Auto"); changing one makes the scene
 * "Custom" and it sends exactly what's ticked. Unticking all of a product's images takes the product out of the
 * shot (even a locked one).
 *
 * 📌 pins images to be used exactly as they are: the first pinned is the scene's frame and its clip's start, the
 * second the clip's end. Nothing new is generated for the frame. × takes an image off this scene's list.
 */
export function SceneRefs({ project, scene: s, onChange, onExact, onHidden }: {
  project: Project;
  scene: Scene;
  onChange: (keys: string[] | null) => void;
  onExact: (keys: string[]) => void;
  onHidden: (keys: string[]) => void;
}) {
  const [showHidden, setShowHidden] = useState(false);
  const options = refOptions(project, s);
  const hidden = hiddenRefOptions(project, s);
  if (!options.length && !hidden.length) return null;

  const chosen = chosenRefKeys(project, s, true);
  const full = chosen.length >= MAX_REFS;
  const custom = Boolean(s.refOverride);
  const pins = exactKeys(s);
  const pinned = (key: string) => pins.indexOf(key); // 0 = start, 1 = end, -1 = not pinned
  const label = (key: string) => options.find((o) => o.key === key)?.label ?? "missing image";
  const hasStart = Boolean(s.imageFile) || s.continuesPrevious;

  const toggle = (key: string) => {
    const on = chosen.includes(key);
    if (!on && full) return;
    onChange(on ? chosen.filter((k) => k !== key) : [...chosen, key]);
  };
  const pin = (key: string) => onExact(pinned(key) >= 0 ? pins.filter((k) => k !== key) : [...pins, key].slice(0, 2));
  // The server also unpins an image when it's removed.
  const hide = (key: string) => onHidden([...(s.hiddenRefKeys ?? []), key]);

  return (
    <div className={`scene-refs ${pins.length ? "exact" : ""}`}>
      <div className="refs-head">
        <span className="refs-title">Images sent to Flow</span>
        {pins.length ? (
          <span className="badge exact">📌 Exact {pins.length > 1 ? "start + end" : "frame"}</span>
        ) : (
          <>
            <span className={`badge ${custom ? "queued" : "done"}`}>{custom ? "Custom" : "Auto"}</span>
            <span className="muted small">{chosen.length} of {MAX_REFS}</span>
            {custom && <button className="link small" onClick={() => onChange(null)}>Reset to auto</button>}
          </>
        )}
        <span className="grow" />
        {hidden.length > 0 && (
          <button className="link small" onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? "Hide removed" : `Show removed (${hidden.length})`}
          </button>
        )}
      </div>

      <div className="refs-row">
        {options.map((o) => {
          const at = pinned(o.key);
          const on = !pins.length && chosen.includes(o.key);
          return (
            <div key={o.key} className={`ref-pick-wrap ${at >= 0 ? "pinned" : ""}`}>
              <button
                className={`ref-pick ${on || at >= 0 ? "on" : ""}`}
                disabled={pins.length > 0 || (!on && full)}
                onClick={() => toggle(o.key)}
                title={
                  pins.length ? "This scene uses exact images, so no other images are sent. Unpin to choose images again."
                  : `${o.group}: ${o.label}${on ? " (sent to Flow; click to leave it out)" : full ? " (3 already picked: untick one first)" : " (click to send it)"}`
                }
              >
                <img src={fileUrl(project.id, o.folder, o.file)} alt={o.label} />
                {at >= 0 ? <span className="tick pin-tag">{at === 0 ? "Start" : "End"}</span> : on && <span className="tick">✓</span>}
                <span className="ref-cap">{o.label}</span>
              </button>
              <button className="ref-remove" onClick={() => hide(o.key)} title="Remove from this scene (it stays in the project)">×</button>
              <button
                className={`pin ${at >= 0 ? "on" : ""}`}
                disabled={at < 0 && pins.length >= 2}
                onClick={() => pin(o.key)}
                title={
                  at === 0 ? "Unpin the start image"
                  : at === 1 ? "Unpin the end image"
                  : pins.length >= 2 ? "Start and end are both pinned: unpin one first"
                  : pins.length ? "Pin as the clip's exact END image"
                  : "Pin as the scene's exact START image: no new frame is generated, and the clip starts on it"
                }
              >
                {at === 0 ? "Unpin start" : at === 1 ? "Unpin end" : pins.length ? "📌 End" : "📌 Start"}
              </button>
            </div>
          );
        })}
      </div>

      {showHidden && hidden.length > 0 && (
        <div className="refs-row removed">
          {hidden.map((o) => (
            <div key={o.key} className="ref-pick-wrap">
              <div className="ref-pick">
                <img src={fileUrl(project.id, o.folder, o.file)} alt={o.label} />
                <span className="ref-cap">{o.label}</span>
              </div>
              <button className="pin" onClick={() => onHidden((s.hiddenRefKeys ?? []).filter((k) => k !== o.key))}>↺ Put back</button>
            </div>
          ))}
        </div>
      )}

      {pins.length ? (
        <p className="muted small">
          Starts exactly on <b>{label(pins[0])}</b>
          {pins[1] ? <> and ends exactly on <b>{label(pins[1])}</b></> : null}: nothing new is generated for the frame, and Flow is
          told to keep {pins[1] ? "both images" : "it"} unchanged. {pins.length < 2 && "Pin a second image as the end to choose where the clip finishes."}
        </p>
      ) : hasStart ? (
        <p className="muted small">
          These go into this scene's frame. Its clip starts from that frame{s.continuesPrevious ? " (or the previous clip's last frame)" : ""},
          so whatever is in the frame is in the clip. 📌 Start uses an image as the frame itself, without redrawing it.
        </p>
      ) : null}
    </div>
  );
}
