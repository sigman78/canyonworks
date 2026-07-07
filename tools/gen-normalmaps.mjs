// Generate normal maps for the detail textures with nano-banana2
// (image-to-image from public/textures/<name>.jpg). Writes
// public/textures/<name>_n.png — the app prefers these over the runtime
// Sobel bake (src/viewer/normalMaps.ts); delete a file to fall back.
//
//   node tools/gen-normalmaps.mjs [name ...]   (default: all)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const texDir = join(root, 'public', 'textures');
const MODEL = 'gemini-3-pro-image';

const env = readFileSync(join(root, '.env.local'), 'utf8');
const key = env.match(/VITE_NANOBANANA_KEY=(\S+)/)?.[1];
if (!key) throw new Error('VITE_NANOBANANA_KEY not found in .env.local');

// what each texture depicts + what should read raised vs. recessed
const HINTS = {
  cliff:
    'The source is a red sandstone cliff face with horizontal strata bands. ' +
    'Relief: each stratum is a gently rounded protruding ledge; the thin dark ' +
    'bedding lines between strata are recessed grooves; small cracks are ' +
    'shallow recesses.',
  sand:
    'The source is a desert floor of fine sand with faint wind ripples and a ' +
    'few tiny embedded pebbles. Relief: very gentle — low rounded ripple ' +
    'crests slightly raised, pebbles as small round bumps; mostly near-flat.',
  rock:
    'The source is rough weathered rock. Relief: granular pitted surface — ' +
    'pits and fractures recessed, grains and chips slightly raised; medium ' +
    'roughness everywhere, no large forms.',
  dunes:
    'The source is wind-rippled sand with dense parallel ripple crests. ' +
    'Relief: each ripple crest is a smooth rounded raised ridge, the troughs ' +
    'between them recessed; long smooth gradients across each ripple.',
  gravel:
    'The source is desert pavement: angular stones half-embedded in dust. ' +
    'Relief: every stone is a distinct raised rounded bump, dust between ' +
    'stones is flat; stones protrude clearly.',
  mesa:
    'The source is slickrock plateau with mud-crack style fracture lines ' +
    'dividing the stone into plates. Relief: the plates are gently domed and ' +
    'raised, the fracture lines are sharply recessed narrow grooves, ' +
    'potholes are shallow round depressions.',
  drift:
    'The source is a thin sheet of rippled drift sand over bedrock. Relief: ' +
    'delicate low ripple ridges slightly raised, bare rock patches flat.',
  rubble:
    'The source is scattered stone chips on bedrock. Relief: each chip is a ' +
    'small raised angular bump, bedrock between is flat.',
  crater:
    'The source is powdery crater-floor dust with hairline cracks and tiny ' +
    'ejecta fragments. Relief: near-flat dust, cracks as very shallow ' +
    'recessed lines, fragments as tiny sharp bumps.',
};
const ALL = Object.keys(HINTS);

const PROMPT =
  'Convert this texture into its tangent-space NORMAL MAP for 3D rendering. ' +
  'OpenGL convention: base color RGB(128,128,255) lavender for flat areas; ' +
  'red channel encodes slope toward image right, green channel slope toward ' +
  'image top. CRITICAL: keep the EXACT same layout, position and scale of ' +
  'every feature as the source image, pixel-aligned — do not redraw or ' +
  'rearrange anything. Use SMOOTH CONTINUOUS gradients over each bump and ' +
  'hollow — soft rounded transitions, absolutely no flat posterized color ' +
  'patches, no outlines, no hard color steps. Gentle relief: colors stay ' +
  'within ±35% of the lavender base. No lighting, no shadows, no text. ' +
  'Seamless tileable like the source. ';

async function generate(name) {
  const src = join(texDir, `${name}.jpg`);
  if (!existsSync(src)) throw new Error(`missing source texture: ${src}`);
  const srcB64 = readFileSync(src).toString('base64');
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
  const file = join(texDir, `${name}_n.png`);
  writeFileSync(file, Buffer.from(part.inlineData.data, 'base64'));
  console.log(`wrote ${file}`);
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
for (const name of names) await generate(name);
