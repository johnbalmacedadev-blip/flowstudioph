import { useState } from "react";
import type { AppSettings, FlowStatus } from "../../../shared/types";
import { api } from "../api";

export function SettingsDialog({ settings, flow, onClose, onSaved, onSwitchAccount }: {
  settings: AppSettings;
  flow: FlowStatus | null;
  onClose: () => void;
  onSaved: (s: AppSettings) => void;
  onSwitchAccount: () => Promise<void>;
}) {
  const [cap, setCap] = useState(settings.maxCreditsPerClip);
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const account = flow?.signedIn ? flow.account : undefined;

  const switchAccount = async () => {
    setSwitching(true);
    setSwitchError("");
    try {
      await onSwitchAccount();
    } catch (e) {
      setSwitchError((e as Error).message);
    } finally {
      setSwitching(false);
    }
  };

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

        <div className="field">
          <span>Google Flow account</span>
          <div className="account-row">
            <div className="account-who">
              {account ? (
                <>
                  <b>{account.name}</b>
                  <span className="muted small">{account.email}</span>
                </>
              ) : (
                <span className="muted small">{flow?.browserOpen ? flow.message : "Google Flow isn't connected."}</span>
              )}
            </div>
            <button className="btn small" onClick={switchAccount} disabled={switching || !flow?.browserOpen}>
              {switching ? "Opening…" : "Use a different Google account"}
            </button>
          </div>
          <small className="muted">
            Opens the Flow window on Google's account chooser: pick another account or <b>Use another account</b> to
            sign in (you type your password in Google's page; the app never sees it). The window hides once Flow is
            back. Each project then gets its own Flow project under that account, and credits are that account's.
            Waits for any render to finish first.
          </small>
          {switchError && <small className="error-text">{switchError}</small>}
        </div>

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
