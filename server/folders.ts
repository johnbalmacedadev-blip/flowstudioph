import { execFile, spawn } from "node:child_process";
import fs from "node:fs";

/** Show a file selected in Windows Explorer (or just open a folder). */
export function revealInExplorer(target: string) {
  if (!fs.existsSync(target)) throw new Error("That file or folder isn't there any more.");
  const args = fs.statSync(target).isDirectory() ? [target] : [`/select,${target}`];
  spawn("explorer.exe", args, { detached: true, stdio: "ignore" }).unref();
}

/**
 * Windows' own folder picker, opened on top of other windows. Resolves to the chosen folder, or undefined if
 * you cancel. The start folder goes in through an environment variable, so no path is put into the script.
 */
export function pickFolder(start: string): Promise<string | undefined> {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }",
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$d.Description = 'Where should Flow Studio PH save exported videos?'",
    "$d.ShowNewFolderButton = $true",
    "if (Test-Path $env:FSPH_START) { $d.SelectedPath = $env:FSPH_START }",
    "if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
  ].join("; ");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-STA", "-NonInteractive", "-Command", script],
      { env: { ...process.env, FSPH_START: start }, windowsHide: true, timeout: 10 * 60_000 },
      (err, stdout) => (err ? reject(new Error("Couldn't open the folder picker. Type the folder path instead.")) : resolve(stdout.trim() || undefined)),
    );
  });
}
