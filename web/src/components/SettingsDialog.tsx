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
  const [exportDir, setExportDir] = useState(settings.exportDir);
  const [folderError, setFolderError] = useState("");
  const [picking, setPicking] = useState(false);
  const browse = async () => {
    setPicking(true);
    setFolderError("");
    try {
      const { dir } = await api.pickExportDir();
      if (dir) setExportDir(dir);
    } catch (e) {
      setFolderError((e as Error).message);
    } finally {
      setPicking(false);
    }
  };
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
      onSaved(await api.saveSettings({ maxCreditsPerClip: cap, exportDir }));
      onClose();
    } catch (e) {
      setFolderError((e as Error).message);
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

        <div className="field">
          <span>Export folder</span>
          <div className="row tight">
            <input className="grow" value={exportDir} onChange={(e) => setExportDir(e.target.value)} spellCheck={false} />
            <button className="btn small" onClick={browse} disabled={picking}>{picking ? "Choosing…" : "Browse…"}</button>
            <button className="btn small ghost" onClick={() => api.openExportDir().catch((e) => setFolderError(e.message))}
              title="Open the saved export folder in File Explorer">Open folder</button>
          </div>
          <small className="muted">
            Every MP4 you export from the Final Cut tab is saved here, named after the project (the app keeps its own
            copy to play). Browse opens Windows' folder picker; it may appear behind this window.
          </small>
          {folderError && <small className="error-text">{folderError}</small>}
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
