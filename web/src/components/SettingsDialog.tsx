import { useState } from "react";
import type { AppSettings } from "../../../shared/types";
import { api } from "../api";

const EFFORTS: AppSettings["effort"][] = ["low", "medium", "high", "xhigh", "max"];

export function SettingsDialog({ settings, onClose, onSaved }: {
  settings: AppSettings;
  onClose: () => void;
  onSaved: (s: AppSettings) => void;
}) {
  const [key, setKey] = useState("");
  const [model, setModel] = useState(settings.model);
  const [effort, setEffort] = useState(settings.effort);
  const [cap, setCap] = useState(settings.maxCreditsPerClip);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      onSaved(await api.saveSettings({ ...(key ? { apiKey: key } : {}), model, effort, maxCreditsPerClip: cap }));
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <label className="field">
          <span>Claude API key</span>
          <input
            type="password"
            placeholder={settings.hasApiKey ? `Saved (ends in …${settings.apiKeyHint}). Paste a new one to replace it.` : "sk-ant-…"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoComplete="off"
          />
          <small className="muted">
            Get one at console.anthropic.com. It's stored only on this computer, in <code>data/settings.json</code>.
          </small>
        </label>

        <div className="row">
          <label className="field grow">
            <span>Model</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
          <label className="field">
            <span>Effort</span>
            <select value={effort} onChange={(e) => setEffort(e.target.value as AppSettings["effort"])}>
              {EFFORTS.map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
        </div>
        <small className="muted">Higher effort writes more careful storyboards but takes longer and costs more.</small>

        <label className="field">
          <span>Google Flow credit limit per render</span>
          <input type="number" min={0} step={1} value={cap} onChange={(e) => setCap(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
          <small className="muted">
            Before each render the app reads Flow's own price. If it's above this, the render is skipped and nothing is
            spent. Stills are free; an 8-second 720p clip is about 12 credits.
          </small>
        </label>

        <div className="modal-actions">
          {settings.hasApiKey && (
            <button className="btn ghost danger" onClick={async () => { onSaved(await api.saveSettings({ apiKey: "" })); onClose(); }}>
              Remove key
            </button>
          )}
          <span className="grow" />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}
