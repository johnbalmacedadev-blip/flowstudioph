import { useState } from "react";
import type { AppSettings } from "../../../shared/types";
import { api } from "../api";

export function SettingsDialog({ settings, onClose, onSaved }: {
  settings: AppSettings;
  onClose: () => void;
  onSaved: (s: AppSettings) => void;
}) {
  const [cap, setCap] = useState(settings.maxCreditsPerClip);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      onSaved(await api.saveSettings({ maxCreditsPerClip: cap }));
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <p className="muted small">
          Flow Studio PH needs no API keys. Storyboards and renders both run in your own Google Flow account, in the
          Flow window the app keeps signed in, so the only cost is your Flow credits.
        </p>

        <label className="field">
          <span>Google Flow credit limit per render</span>
          <input type="number" min={0} step={1} value={cap} onChange={(e) => setCap(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
          <small className="muted">
            Before each render the app reads Flow's own price. If it's above this, the render is skipped and nothing is
            spent. Stills and storyboards are free; an 8-second 720p clip is about 12 credits.
          </small>
        </label>

        <div className="modal-actions">
          <span className="grow" />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}
