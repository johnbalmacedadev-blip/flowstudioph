# Flow Studio PH

Turn a script, a workflow or one long master prompt into a cast of characters and a timed storyboard, render
every frame and clip, and cut the film, all in **your own Google Flow account**. It runs on your computer at
`http://localhost:5173`. **No API keys and nothing to pay for beyond your Flow plan.**

```
Your script ──> Flow Studio PH ──> Chrome (signed in to Flow) ──> Flow's AI writes the storyboard,
                                                                  Flow renders frames and clips ──> your files
```

## What it does

1. **Script & references.** Paste anything: a screenplay, a scene-by-scene workflow, or a long master prompt.
   Pick **🎬 Cinematic** or **📱 UGC** (creator-style phone video: handheld, talking to camera, natural light,
   real settings, a hook first and a call to action last; switches to 9:16), 16:9 or 9:16, and how many
   **seconds per scene** (4, 6, 8, 10, or let the storyboard choose). Drop in reference
   images and name them after who or what they show ("Lola Nena", "Sari-sari store").
2. **Generate storyboard**, with any of three engines (none needs an API key):
   - **🤖 Claude Code**: fastest and most reliable. Open Claude Code in this folder and say
     *"Storyboard my Flow Studio PH project "<name>" and load it into the app"* (the Script tab has a Copy button
     for this). Claude reads the script and looks at your reference images, writes the cast and scenes following
     the same rules as the other engines (`.claude/skills/storyboard`), and loads them; the app updates by itself.
     Uses your Claude Code plan, not pay-per-use API billing. You can also paste storyboard JSON there by hand.
   - **✨ Flow AI**: Google Flow's own AI (Gemini), in your signed-in Flow account, writes the characters
     and a list of one-shot scenes. It only writes text: the app tells it not to generate media and never confirms
     a generation, so it costs no credits. Long master prompts are sent in parts and stitched together. Every prompt
     repeats the full character and style description, because Flow doesn't remember anything between clips.
   - **⚡ Quick split**: no AI, on this computer, instant. Follows the script's own structure (Scene / Shot
     headings, `INT./EXT.`, numbered shots, `NAME:` dialogue, paragraphs). Best for scripts already written scene
     by scene; edit the prompts afterwards.
3. **Cast & Products.** Edit each character's look and render a free portrait in Flow to check it.
   **Products** (for ads and UGC): upload clear photos of the product (front label, packaging) and describe its
   exact look. **🔒 Locked** products are in every scene; others only in the scenes you tick. Whenever a product
   is in a shot, its photos are attached to Flow first and the prompt says to keep its packaging, colours, label
   text and logo exactly as photographed. **Render product shot** (free) shows how Flow reproduces it.
4. **Storyboard.** Edit, reorder, retime, add or delete scenes. Render a free **frame** per scene, then the paid
   **clip**. Character portraits are attached to every frame so people stay on-model. Frames never get
   subtitles burned in; clips speak the dialogue. A spinning gear on a render button means it's queued or
   rendering. **Images sent to Flow** on each scene shows the reference images it will attach (up to 3): the
   app's own pick (Auto), or tick exactly the ones you want (Custom; Reset to auto undoes it). Untick all of a
   product's images (or click its chip off) and that scene leaves the product out, even a locked one: at render
   time the sentences describing it are taken out of the prompt (spoken lines stay) and Flow is told not to
   show it.
   **📌 Start** on any of those images uses it as the scene's frame exactly as it is: nothing is generated for
   the frame (it's fitted to the video's shape, any gap filled with a blurred copy of the same photo), and the
   clip starts on it with Flow told to keep it unchanged. Use it for packshots where the label must be exact.
   Then **📌 End** on a second image makes the clip finish exactly on that one (Flow's End frame). With a start
   pinned you can still tick up to 2 other images (your product, say): the frame is then redrawn from the start
   image with them in it, and **↻ Regenerate frame** makes it again (it lights up when the images changed). **Scene N clip end** (the last frame of the previous clip) is offered too:
   pin it as Start to begin exactly where the last scene stopped. **×** takes an image off that scene's list
   (it stays in the project); **Show removed** lists them with **Put back**.
5. **Seamless scenes.** The storyboard keeps the story in one location unless the script moves it, and marks each scene
   that continues from the one before. Between scenes the storyboard shows **🔗 Seamless** or **✂ Cut**; click it
   to switch. A seamless scene's frame is matched to the previous frame, and its clip **starts on the last frame
   of the previous clip**, so the cut picks up exactly where the last shot ended. Render clips in order (Render
   all clips does). A cut starts from its own frame, or from the cast as references when it has none.
6. **Final Cut.** Every rendered clip on one timeline, in story order. Play the whole film (cuts land without a
   gap), drag clips to reorder, click one to trim its start and end, delete it from the timeline (and put it back
   from the tray), then **Export MP4**:
   - **720p**: Flow's originals, joined. Fastest.
   - **1080p HD**: Flow's own AI 1080p upscale of each clip (about a minute per clip the first time, then reused).
   - **4K**: enlarged from Flow's 1080p. Flow's native 4K needs a higher Google plan.

   Exports are H.264/AAC MP4s in `data/projects/<id>/exports/`; watch, download or delete them from the tab.

Renders are saved in `data/projects/<id>/renders/`. Each project gets its own Flow project called
"Flow Studio PH · <name>".

## Requirements

- Windows 10/11 or macOS
- [Node.js](https://nodejs.org) 22 or newer
- Google Chrome
- A Google account with Flow access (stills are free; video uses Flow credits)

## Run it

```bash
git clone https://github.com/johnbalmacedadev-blip/flowstudioph.git
cd flowstudioph
npm install
npm run dev
```

Open **http://localhost:5173**, then:

1. **Connect Google Flow** (top right). The first time, a Chrome window appears so you can sign in to Google
   yourself; once you're signed in it hides itself. After that, Flow runs in that hidden window and you never see
   it. **Show Flow** in the top bar brings it up if you want to watch or fix something by hand. The Chrome profile
   lives in `data/chrome-profile`, separate from your everyday Chrome.
2. **+ New project**, paste your script, and click **Generate storyboard**.

## Credits and safety

- Before every render the app reads Flow's own price. If it's above your **credit limit per render** (Settings,
  default 20), the render is skipped and nothing is spent. Storyboards and stills are 0 credits; an 8-second
  720p clip with Omni 1.1 Flash is about 12.
- If Flow's AI declines a script ("might violate our policies", which happens now and then even with harmless
  stories), the app retries, then tells you; reword the flagged part or use Quick split.
- Renders run one at a time with a short pause between them.
- Before anything is generated, the app checks Flow is holding exactly the images it chose (by Flow's asset id),
  the right way round: the start frame in the Start slot, or the cast as references. If not, it stops before
  spending anything.
- Your Google password is never seen or stored by the app; it only uses the Chrome session you signed in to.

## Settings

| Environment variable | Default | |
|---|---|---|
| `FSPH_API_PORT` | `5174` | API server port (the UI is on 5173) |
| `FSPH_CDP_PORT` | `9335` | Chrome debugging port |
| `FSPH_CHROME` | auto | Path to `chrome.exe` if it isn't found |
| `FSPH_DATA_DIR` | `./data` | Where projects, renders and the Chrome profile live |

## Project layout

```
server/            Express API (port 5174)
  storyboard.ts    Storyboard rules, parsing and applying a breakdown (shared by both engines)
  flow/agent.ts    ✨ Flow AI: writes the storyboard with Google Flow's own agent
  localsplit.ts    ⚡ Quick split: storyboard without AI
scripts/storyboard.mjs   npm run storyboard -- list | show <project> | load <project> <file.json>
.claude/skills/storyboard  How Claude Code writes and loads a storyboard (🤖 Claude Code engine)
  flow/browser.ts  Starts and connects to the Flow Chrome window
  flow/driver.ts   Drives Flow: attach references, set options, generate, download, 1080p upscales
  finalcut.ts      Final Cut timeline (sync with the storyboard, edits) and MP4 export
  media.ts         FFmpeg (bundled): probing, last frames, trimming and joining
  jobs.ts          Job queue (Flow renders run one at a time)
web/               React UI (Vite, port 5173)
shared/types.ts    Types used by both
```

## Good to know

This automates Flow's web page, so it can break when Google changes that page. Automated use may also go
against Google's terms of service. Use it with your own account, at your own risk.
