// Generate tileable terrain detail textures with nano-banana2
// (gemini-3-pro-image). Reads the API key from .env.local
// (VITE_NANOBANANA_KEY), writes PNGs to public/textures/.
//
//   node tools/gen-textures.mjs [name ...]   (default: all)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'textures');
const MODEL = 'gemini-3-pro-image';

const env = readFileSync(join(root, '.env.local'), 'utf8');
const key = env.match(/VITE_NANOBANANA_KEY=(\S+)/)?.[1];
if (!key) throw new Error('VITE_NANOBANANA_KEY not found in .env.local');

const COMMON =
  'Perfectly seamless tileable texture, photographed orthogonally (straight on), ' +
  'perfectly even diffuse lighting, NO shadows, NO highlights, NO vignetting, ' +
  'uniform brightness across the whole image, edges must wrap seamlessly. ' +
  'Stylized painterly game texture, mid-contrast, no text, no watermark.';

const TEXTURES = {
  cliff:
    'Sedona Arizona red sandstone cliff face with clearly layered horizontal ' +
    'strata bands, alternating rust-orange and darker red-brown sediment layers, ' +
    'slightly eroded rough surface, small cracks along the bedding planes. ' +
    COMMON,
  sand:
    'Warm desert floor of fine rust-orange sand and dust with sparse tiny ' +
    'embedded pebbles and faint wind ripples, subtle patchy tonal variation. ' +
    COMMON,
  rock:
    'Rough weathered red-brown rock surface, granular pitted stone with ' +
    'small chips and fractures, uniform overall tone. ' +
    COMMON,
  dunes:
    'Fine wind-rippled desert sand seen from directly above, dense small ' +
    'parallel ripple crests like miniature dunes, warm rust-orange sand, ' +
    'soft painted form shading along the ripple crests only (no cast ' +
    'shadows). ' +
    COMMON,
  gravel:
    'Rocky desert pavement: scattered small angular stones and pebbles of ' +
    'varied size half-embedded in rust-orange dust, patchy density, some ' +
    'bare dust areas between stone clusters. ' +
    COMMON,
  mesa:
    'Weathered sandstone slickrock plateau surface seen from directly ' +
    'above, network of dried mud-crack style fracture lines dividing the ' +
    'pale rust-tan stone into irregular plates, a few shallow rounded ' +
    'potholes and small dark rock pools with sediment, subtle painted ' +
    'depth in the cracks (no cast shadows). ' +
    COMMON,
  // ---- mesa-top specific layers (v0.12b) ----
  drift:
    'Thin sheet of pale wind-blown sand drifted over pale rust-tan ' +
    'slickrock bedrock seen from directly above, delicate wind ripples in ' +
    'the sand, patches of smooth bare rock showing through the thin drift, ' +
    'soft painted form shading along ripple crests only (no cast shadows). ' +
    COMMON,
  rubble:
    'Sparse lag of small angular dark-varnished stone chips and weathered ' +
    'caprock fragments scattered over pale rust-tan slickrock bedrock seen ' +
    'from directly above, chips half-embedded, wide bare bedrock areas ' +
    'between loose stone clusters. ' +
    COMMON,
  crater:
    'Fine powdery impact-crater floor of cool ash-taupe dust seen from ' +
    'directly above, hairline desiccation cracks, scattered tiny sharp ' +
    'ejecta fragments and small glassy pebbles half-buried in the dust, ' +
    'subtle patchy tonal variation between grey-taupe and dusty rose. ' +
    COMMON,
};

async function generate(name, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
      },
    }),
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) throw new Error(`${name}: no image in response: ${JSON.stringify(json).slice(0, 400)}`);
  const file = join(outDir, `${name}.png`);
  writeFileSync(file, Buffer.from(part.inlineData.data, 'base64'));
  console.log(`wrote ${file} (${part.inlineData.mimeType})`);
}

mkdirSync(outDir, { recursive: true });
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TEXTURES);
for (const name of names) {
  if (!TEXTURES[name]) throw new Error(`unknown texture: ${name}`);
  await generate(name, TEXTURES[name]);
}
