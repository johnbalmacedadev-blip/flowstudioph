# Flow Studio PH

Turn a script, a workflow or one long master prompt into a cast of characters and a timed storyboard with
Claude, then render every frame and clip in **your own Google Flow account**. It runs on your computer at
`http://localhost:5173`.

```
Your script ──> Claude (storyboard, characters, prompts) ──> Flow Studio PH ──> Chrome (signed in to Flow) ──> your files
```

## What it does

1. **Script & references.** Paste anything: a screenplay, a scene-by-scene workflow, or a long master prompt.
   Pick 16:9 or 9:16 and how many **seconds per scene** (4, 6, 8, 10, or let Claude choose). Drop in reference
   images and name them after who or what they show ("Lola Nena", "Sari-sari store").
2. **Generate storyboard.** Claude reads the script and the reference images and writes the characters and a list
   of one-shot scenes. Each prompt repeats the full character and style description, because Flow doesn't
   remember anything between clips.
3. **Characters.** Edit each look and render a free portrait in Flow to check it.
4. **Storyboard.** Edit, reorder, retime, add or delete scenes. Render a free **frame** per scene, then the paid
   **clip**. A clip starts from its scene's frame (or uses the cast as references when there is no frame).
   Character portraits are attached to every frame so people stay on-model.

Renders are saved in `data/projects/<id>/renders/`. Each project gets its own Flow project called
"Flow Studio PH · <name>".

## Requirements

- Windows 10/11 or macOS
- [Node.js](https://nodejs.org) 22 or newer
- Google Chrome
- A Google account with Flow access (stills are free; video uses Flow credits)
- A Claude API key from [console.anthropic.com](https://console.anthropic.com)

## Run it

```bash
git clone https://github.com/johnbalmacedadev-blip/flowstudioph.git
cd flowstudioph
npm install
npm run dev
```

Open **http://localhost:5173**, then:

1. **Add Claude API key** (top right). It's saved only on this computer, in `data/settings.json`.
2. **Connect Google Flow** (top right). A separate Chrome window opens; sign in to Google there yourself, once.
   That Chrome profile lives in `data/chrome-profile` and is separate from your everyday Chrome. Keep the window
   open (it can sit behind other windows) while renders run.
3. **+ New project**, paste your script, and click **Generate storyboard**.

## Credits and safety

- Before every render the app reads Flow's own price. If it's above your **credit limit per render** (Settings,
  default 20), the render is skipped and nothing is spent. Stills are 0 credits; an 8-second 720p clip with
  Omni 1.1 Flash is about 12.
- Renders run one at a time with a short pause between them.
- Your Google password is never seen or stored by the app; it only uses the Chrome session you signed in to.

## Settings

| Environment variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | | Used if no key is saved in the app |
| `FSPH_API_PORT` | `5174` | API server port (the UI is on 5173) |
| `FSPH_CDP_PORT` | `9335` | Chrome debugging port |
| `FSPH_CHROME` | auto | Path to `chrome.exe` if it isn't found |
| `FSPH_DATA_DIR` | `./data` | Where projects, renders and the Chrome profile live |

## Project layout

```
server/            Express API (port 5174)
  claude.ts        Script -> characters + scenes (Claude, streamed, JSON schema)
  flow/browser.ts  Starts and connects to the Flow Chrome window
  flow/driver.ts   Drives Flow's composer: attach references, set options, generate, download
  jobs.ts          Job queue (Flow renders run one at a time)
web/               React UI (Vite, port 5173)
shared/types.ts    Types used by both
```

## Good to know

This automates Flow's web page, so it can break when Google changes that page. Automated use may also go
against Google's terms of service. Use it with your own account, at your own risk.
