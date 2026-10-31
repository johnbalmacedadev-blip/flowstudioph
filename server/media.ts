import fs from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import ffmpegStatic from "ffmpeg-static";

// FFmpeg ships with the app (ffmpeg-static), so nobody has to install it.
const FFMPEG = ffmpegStatic as unknown as string;
const execFileAsync = promisify(execFile);

export interface Probe {
  duration: number;
  hasAudio: boolean;
  width: number;
  height: number;
}

const probes = new Map<string, Probe>();

/** Duration, size and whether there's sound, read from FFmpeg's own summary of the file. */
export async function probe(file: string): Promise<Probe> {
  const key = `${file}:${fs.statSync(file).mtimeMs}`;
  const cached = probes.get(key);
  if (cached) return cached;
  // `ffmpeg -i` with no output exits with an error but prints the summary we want on stderr.
  const stderr: string = await execFileAsync(FFMPEG, ["-hide_banner", "-i", file]).then(
    (r) => r.stderr,
    (e) => e.stderr ?? "",
  );
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr);
  const size = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(stderr);
  const result: Probe = {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    hasAudio: /Stream #.*Audio:/.test(stderr),
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
  };
  probes.set(key, result);
  return result;
}

/** The clip's final frame as a JPEG next to it (made once). */
export async function lastFrame(clip: string) {
  const out = clip.replace(/\.[^.]+$/, "-last.jpg");
  if (fs.existsSync(out)) return out;
  // -sseof seeks to just before the end; -update keeps overwriting one image, leaving the last frame.
  await execFileAsync(FFMPEG, ["-v", "error", "-y", "-sseof", "-0.5", "-i", clip, "-update", "1", "-q:v", "2", out]);
  if (!fs.existsSync(out)) throw new Error("Couldn't read the last frame of the previous clip.");
  return out;
}

export interface Segment {
  file: string;
  inSec: number;
  outSec: number;
}

/**
 * Trim each segment, fit it to width x height, and join them into one H.264/AAC MP4.
 * Clips without sound get silence, so the joined audio stays in sync.
 */
export async function renderCut(
  segments: Segment[],
  out: string,
  width: number,
  height: number,
  onProgress: (fraction: number) => void,
) {
  const total = segments.reduce((t, s) => t + (s.outSec - s.inSec), 0);
  const args = ["-hide_banner", "-v", "error", "-y", "-progress", "pipe:1", "-nostats"];
  const filters: string[] = [];
  const pads: string[] = [];
  for (const [i, s] of segments.entries()) {
    args.push("-i", s.file);
    const len = (s.outSec - s.inSec).toFixed(3);
    filters.push(
      `[${i}:v]trim=start=${s.inSec}:end=${s.outSec},setpts=PTS-STARTPTS,` +
        `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[v${i}]`,
    );
    filters.push(
      (await probe(s.file)).hasAudio
        ? `[${i}:a]atrim=start=${s.inSec}:end=${s.outSec},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${len}[a${i}]`,
    );
    pads.push(`[v${i}][a${i}]`);
  }
  filters.push(`${pads.join("")}concat=n=${segments.length}:v=1:a=1[v][a]`);
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", width >= 3000 ? "medium" : "slow", "-crf", "17", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    out,
  );

  await new Promise<void>((resolve, reject) => {
    const ff = spawn(FFMPEG, args, { windowsHide: true });
    let err = "";
    ff.stdout.on("data", (d: Buffer) => {
      const t = /out_time_us=(\d+)/.exec(d.toString());
      if (t && total > 0) onProgress(Math.min(1, Number(t[1]) / 1e6 / total));
    });
    ff.stderr.on("data", (d: Buffer) => (err += d.toString()));
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Export failed: ${err.trim().split("\n").pop() || `FFmpeg exited with ${code}`}`))));
  });
}

/**
 * A video frame made from a photo without redrawing it: the photo is scaled to fit width x height whole,
 * and any space left (a square photo in a 9:16 frame) is filled with a blurred copy of the same photo.
 */
export async function exactFrame(photo: string, out: string, width: number, height: number) {
  const filter =
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=40:5[bg];` +
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuvj420p`;
  await execFileAsync(FFMPEG, ["-v", "error", "-y", "-i", photo, "-filter_complex", filter, "-frames:v", "1", "-q:v", "2", out]);
  if (!fs.existsSync(out)) throw new Error("Couldn't make the frame from that image.");
  return out;
}
