---
name: storyboard
description: Write the storyboard (characters, scenes, frame and clip prompts) for a Flow Studio PH project and load it into the app. Use when the user asks to storyboard, break down, write scenes or characters for, or "load into Flow Studio" a project or script, or picks the "Claude Code" engine in the app.
---

# Storyboard a Flow Studio PH project

You write the storyboard here, in this chat, and load it into the running app. No API key is involved.
The app then renders frames and clips in the user's Google Flow account as usual.

## 1. Find the project

The app must be running (`npm run dev`). If it isn't, start it and wait for it to come up.

```bash
npm run -s storyboard -- list
npm run -s storyboard -- show "<project name or id>"
```

`show` prints the settings (aspect ratio, seconds per scene, style), the full script, the reference images with
their file paths, and any existing cast. If the user didn't say which project, use the one they just mentioned,
or ask. If the project already has scenes, confirm before replacing them.

**Look at every reference image** (Read the file path) before writing. Characters with a reference image must be
described from what the image actually shows (age, face, hair, skin, build, clothing), and that reference's label
goes in their `reference_labels`, so the app attaches the image when it renders. A product, place or style
reference is described the same way in every prompt that uses it.

## 2. Write the breakdown

Follow the rules in `server/storyboard.ts` exactly. Read `RULES` and `SHAPE` there first; they are the same
rules the app's other engines use. In short:

- One scene = one continuous shot = one clip. Keep everything the source asks for, in order. If the source
  already lists scenes, shots or timings, follow them; don't merge, drop or reorder.
- `duration_seconds`: the project's seconds per scene (4, 6, 8 or 10), or choose per scene if it's "auto".
  Each scene's action must fit that time; split long beats into more scenes.
- Clips have no memory: every `image_prompt` and `video_prompt` repeats each character's full look, the
  location's full description and the style. Never "the same man" / "as before".
- `image_prompt` = the opening still. `video_prompt` = subject and action, then shot size and one camera
  move, then location, style, lighting and sound. Spoken lines in quotes with who says them.
- Prompts in English; dialogue in the source's language.
- Continuity: stay in one location unless the source moves; one fixed name and description per location,
  repeated word for word; `continues_previous: true` when a scene picks up in the same place and moment.
- Respect anything the source says about style, wardrobe, product placement, aspect ratio or format.

Write the JSON (the exact `SHAPE` object) to a file in your scratchpad, not in the repo.

## 3. Load it

```bash
npm run -s storyboard -- load "<project name or id>" "<path to the json file>"
```

It prints each scene. The app shows the new storyboard straight away (Storyboard tab). Tell the user how many
characters and scenes were loaded, anything you had to interpret, and that they can render frames for free
before rendering clips.
