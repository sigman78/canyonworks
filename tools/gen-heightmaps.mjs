// Generate (fake) HEIGHT maps for the top-projection detail textures with
// nano-banana2 (image-to-image from public/textures/<name>.jpg). Writes
// public/textures/<name>_h.png — used for height-priority layer blending
// (stones poke through sand in transition zones). The app falls back to
// albedo luminance for any missing file.
//
//   node tools/gen-heightmaps.mjs [name ...]   (default: all top layers)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const texDir = join(root, 'public', 'textures');
const MODEL = 'gemini-3-pro-image';

const env = readFileSync(join(root, '.env.local'), 'utf8');
const key = env.match(/VITE_NANOBANANA_KEY=(\S+)/)?.[1];
if (!key) throw new Error('VITE_NANOBANANA_KEY not found in .env.local');

// what should read high (white) vs low (black) per texture
const HINTS = {
  sand:
    'The source is fine desert sand with faint ripples and tiny pebbles. ' +
    'Height: near-uniform mid-gray, ripple crests barely lighter, pebbles ' +
    'as small bright dots. Low overall contrast.',
  dunes:
    'The source is wind-rippled sand with dense parallel ripple crests. ' +
    'Height: each ripple crest bright, troughs dark, smooth gradients ' +
    'between — strong regular relief.',
  gravel:
    'The source is desert pavement: angular stones half-embedded in dust. ' +
    'Height: every stone bright white (protruding), the dust between them ' +
    'dark — high contrast, crisp stone outlines.',
  crater:
    'The source is powdery crater-floor dust with hairline cracks and tiny ' +
    'ejecta fragments. Height: flat mid-gray dust, cracks slightly darker, ' +
    'fragments as small bright specks.',
  mesa:
    'The source is slickrock plateau with mud-crack fracture lines dividing ' +
    'stone plates. Height: plates bright and gently domed, fracture lines ' +
    'sharply dark, potholes as dark round depressions.',
  drift:
    'The source is thin rippled drift sand over bedrock. Height: ripple ' +
    'ridges slightly bright, bare rock patches flat mid-gray.',
  rubble:
    'The source is scattered stone chips on bedrock. Height: each chip ' +
    'bright (raised), the bedrock between flat mid-gray to dark.',
};
const ALL = Object.keys(HINTS);

const PROMPT =
  'Convert this texture into its grayscale HEIGHT MAP (displacement map) ' +
  'for 3D rendering: white = highest surface points, black = deepest ' +
  'recesses, mid-gray = average level. CRITICAL: keep the EXACT same ' +
  'layout, position and scale of every feature as the source image, ' +
  'pixel-aligned — do not redraw or rearrange anything. Smooth continuous ' +
  'gradients, no lighting or shading effects, no cast shadows, no text. ' +
  'Seamless tileable like the source. ';

async function generate(name) {
  const src = join(texDir, `${name}.jpg`);
  if (!existsSync(src)) throw new Error(`missing source texture: ${src}`);
  // send a 1K copy — the model outputs 1K anyway, no point shipping 2K up
  const srcB64 = (
    await sharp(src).resize(1024, 1024, { fit: 'fill' }).jpeg({ quality: 90 }).toBuffer()
  ).toString('base64');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: srcB64 } },
            { text: PROMPT + HINTS[name] },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
      },
    }),
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) throw new Error(`${name}: no image in response`);
  const file = join(texDir, `${name}_h.png`);
  writeFileSync(file, Buffer.from(part.inlineData.data, 'base64'));
  console.log(`wrote ${file}`);
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
for (const name of names) await generate(name);
