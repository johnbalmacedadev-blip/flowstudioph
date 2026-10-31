import { useState } from "react";
import { chosenRefKeys, exactKeys, hiddenRefOptions, MAX_REFS, pinFrameKey, pinRefKeys, refOptions } from "../../../shared/attachments";
import type { Project, Scene } from "../../../shared/types";
import { fileUrl } from "../api";

/**
 * The images a scene sends to Flow. Ticks start as the app's own pick ("Auto"); changing one makes the scene
 * "Custom" and it sends exactly what's ticked. Unticking all of a product's images takes the product out of the
 * shot (even a locked one).
 *
 * 📌 pins images: the first pinned is the scene's frame and its clip's start, the second the clip's end. A
 * pinned start alone is used exactly; tick other images (a product, say) and the frame is redrawn from the start
 * image with them in it. × takes an image off this scene's list.
 */
export function SceneRefs({ project, scene: s, busy, onChange, onExact, onPinRefs, onHidden, onRegenerate }: {
  project: Project;
  scene: Scene;
  busy: boolean;
  onChange: (keys: string[] | null) => void;
  onExact: (keys: string[]) => void;
  onPinRefs: (keys: string[]) => void;
  onHidden: (keys: string[]) => void;
  onRegenerate: () => void;
}) {
  const [showHidden, setShowHidden] = useState(false);
  const options = refOptions(project, s);
  const hidden = hiddenRefOptions(project, s);
  if (!options.length && !hidden.length) return null;

  const pins = exactKeys(s);
  const pinMode = pins.length > 0;
  // While pinned, ticks are the images added to the start image (the start takes one of the three slots).
  const chosen = pinMode ? pinRefKeys(project, s) : chosenRefKeys(project, s, true);
  const limit = pinMode ? MAX_REFS - 1 : MAX_REFS;
  const full = chosen.length >= limit;
  const custom = Boolean(s.refOverride);
  const pinned = (key: string) => pins.indexOf(key); // 0 = start, 1 = end, -1 = not pinned
  const label = (key: string) => [...options, ...hidden].find((o) => o.key === key)?.label ?? "missing image";
  const hasStart = Boolean(s.imageFile) || s.continuesPrevious;
  // Out of date when the images behind the frame changed (an older pinned frame counts once images are added).
  const stale = pinMode && s.frameKey !== pinFrameKey(project, s) && (s.frameKey !== undefined || chosen.length > 0);

  const toggle = (key: string) => {
    const on = chosen.includes(key);
    if (!on && full) return;
    const next = on ? chosen.filter((k) => k !== key) : [...chosen, key];
    pinMode ? onPinRefs(next) : onChange(next);
  };
  // A seamless scene should start on the previous clip's last frame (offered even if it was removed).
  const clipEnd = [...options, ...hidden].find((o) => o.key === "prev-last");
  const seamGap = s.continuesPrevious && pinMode && pins[0] !== "prev-last" && Boolean(clipEnd);
  const prevScene = project.scenes[project.scenes.findIndex((x) => x.id === s.id) - 1];
  const atClipEnd = pins[0] === "prev-last";
  // The server puts a removed image back when it's pinned.
  const startFromClipEnd = () => onExact(["prev-last", ...pins.slice(1).filter((k) => k !== "prev-last")]);
  const pin = (key: string) => onExact(pinned(key) >= 0 ? pins.filter((k) => k !== key) : [...pins, key].slice(0, 2));
  // The server also unpins an image when it's removed.
  const hide = (key: string) => onHidden([...(s.hiddenRefKeys ?? []), key]);

  return (
    <div className={`scene-refs ${pinMode ? "exact" : ""}`}>
      <div className="refs-head">
        <span className="refs-title">Images sent to Flow</span>
        {pinMode ? (
          <>
            <span className="badge exact">
              📌 {chosen.length ? `Start + ${chosen.length} added` : `Exact ${pins.length > 1 ? "start + end" : "frame"}`}
            </span>
            <button className={`btn small ${stale ? "primary" : "ghost"}`} disabled={busy} onClick={onRegenerate}
              title="Make the frame again from the pinned start image and the ticked images">
              ↻ {stale ? "Regenerate frame (images changed)" : "Regenerate frame"}
            </button>
          </>
        ) : (
          <>
            <span className={`badge ${custom ? "queued" : "done"}`}>{custom ? "Custom" : "Auto"}</span>
            <span className="muted small">{chosen.length} of {MAX_REFS}</span>
            {custom && <button className="link small" onClick={() => onChange(null)}>Reset to auto</button>}
          </>
        )}
        <span className="grow" />
        {prevScene && (
          // Always here (every scene after the first): start exactly where the previous clip ends.
          <button
            className={`btn small ${atClipEnd ? "ghost" : seamGap ? "primary" : ""}`}
            disabled={!clipEnd || atClipEnd}
            onClick={startFromClipEnd}
            title={
              !clipEnd ? `Render scene ${prevScene.number}'s clip first; then this scene can start on its last frame.`
              : atClipEnd ? `This scene already starts on the last frame of scene ${prevScene.number}'s clip.`
              : `Pin the last frame of scene ${prevScene.number}'s clip as this scene's start. Tick other images (your product) to add them to it.`
            }
          >
            {atClipEnd ? `✓ Starts at end of #${prevScene.number}` : `⤵ Start from end of #${prevScene.number}`}
          </button>
        )}
        {hidden.length > 0 && (
          <button className="link small" onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? "Hide removed" : `Show removed (${hidden.length})`}
          </button>
        )}
      </div>

      <div className="refs-row">
        {options.map((o) => {
          const at = pinned(o.key);
          const on = at < 0 && chosen.includes(o.key);
          return (
            <div key={o.key} className={`ref-pick-wrap ${at >= 0 ? "pinned" : ""}`}>
              <button
                className={`ref-pick ${on || at >= 0 ? "on" : ""}`}
                disabled={at >= 0 || (!on && full)}
                onClick={() => toggle(o.key)}
                title={
                  at >= 0 ? `Pinned as the ${at === 0 ? "start" : "end"} image`
                  : `${o.group}: ${o.label}${on ? " (sent to Flow; click to leave it out)" : full ? ` (${limit} already picked: untick one first)` : pinMode ? " (click to add it to the start image)" : " (click to send it)"}`
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
                  : "Pin as the scene's START image: the clip starts on it"
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

      {seamGap && (
        <div className="seam-warn small">
          <span>
            ⚠ This scene is seamless, but its start is <b>{label(pins[0])}</b>, not where the previous clip ends, so the
            cut will jump. Use <b>Start from end of #{prevScene?.number}</b> above.
          </span>
        </div>
      )}

      {pinMode ? (
        <p className="muted small">
          {chosen.length ? (
            <>Starts from <b>{label(pins[0])}</b>, redrawn with <b>{chosen.map(label).join(", ")}</b> in it (labels and logos kept as photographed)</>
          ) : (
            <>Starts exactly on <b>{label(pins[0])}</b>, used as it is</>
          )}
          {pins[1] ? <> and ends exactly on <b>{label(pins[1])}</b></> : null}. Tick up to {limit} images to add them to the start
          {pins.length < 2 && "; pin a second image as the end to choose where the clip finishes"}.
        </p>
      ) : hasStart ? (
        <p className="muted small">
          These go into this scene's frame. Its clip starts from that frame{s.continuesPrevious ? " (or the previous clip's last frame)" : ""},
          so whatever is in the frame is in the clip. 📌 Start makes an image the frame itself.
        </p>
      ) : null}
    </div>
  );
}
