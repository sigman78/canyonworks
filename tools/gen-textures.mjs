// Generate tileable terrain detail textures with nano-banana2
// (gemini-3-pro-image). Reads the API key from .env.local
// (VITE_NANOBANANA_KEY), writes PNGs to public/textures/.
//
//   node tools/gen-textures.mjs [name ...]   (default: all)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'textures');
const MODEL = 'gemini-3-pro-image';

const env = readFileSync(join(root, '.env.local'), 'utf8');
const key = env.match(/VITE_NANOBANANA_KEY=(\S+)/)?.[1];
if (!key) throw new Error('VITE_NANOBANANA_KEY not found in .env.local');

// v2 set: same materials, RICHER COLOR — every prompt names 3-5 distinct
// hues so the texture carries real chroma variation (the shader's hue
// bleed / tex albedo blends pull color from here; the v1 set was
// near-monochrome per texture and read as tinted grayscale). Brightness
// must stay even (tiling + the shader treats ~0.5 as neutral) — richness
// comes from HUE shifts, not value swings.
const COMMON =
  'Perfectly seamless tileable texture, photographed orthogonally (straight on), ' +
  'perfectly even diffuse lighting, NO shadows, NO highlights, NO vignetting, ' +
  'uniform brightness across the whole image, edges must wrap seamlessly. ' +
  'Stylized painterly game texture with rich varied hues — visible hand-painted ' +
  'color variation between neighboring features, medium value contrast. ' +
  'No text, no watermark.';

const TEXTURES = {
  cliff:
    'Sedona Arizona red sandstone cliff face with clearly layered horizontal ' +
    'strata bands: alternating vermilion, burnt-sienna and plum-brown sediment ' +
    'layers, occasional pale cream and ochre caprock bands, thin blue-grey ' +
    'desert-varnish streaks running down some layers, slightly eroded rough ' +
    'surface, small cracks along the bedding planes with dusty violet shade ' +
    'inside them. ' +
    COMMON,
  sand:
    'Warm desert floor of fine sand and dust, patchy hand-painted color drifts ' +
    'between rust-orange, dusty rose, pale apricot and soft ochre, sparse tiny ' +
    'embedded pebbles in terracotta and plum-grey, faint wind ripples. ' +
    COMMON,
  rock:
    'Rough weathered rock surface, granular pitted stone, hand-painted mineral ' +
    'color variation: red-brown base with patches of purple-taupe, rust-orange ' +
    'iron staining, faint sage-grey lichen speckle on some grains, small chips ' +
    'and fractures. ' +
    COMMON,
  dunes:
    'Fine wind-rippled desert sand seen from directly above, dense small ' +
    'parallel ripple crests like miniature dunes, warm apricot-orange crests ' +
    'with dusty mauve and soft coral in the troughs, soft painted form shading ' +
    'along the ripple crests only (no cast shadows). ' +
    COMMON,
  gravel:
    'Rocky desert pavement: scattered small angular stones and pebbles of ' +
    'varied size half-embedded in rust-orange dust — the stones in clearly ' +
    'different hand-painted hues: terracotta, plum-grey, pale cream, ochre and ' +
    'a few near-black desert-varnished chips, patchy density, some bare dust ' +
    'areas between stone clusters. ' +
    COMMON,
  mesa:
    'Weathered sandstone slickrock plateau surface seen from directly above, ' +
    'network of dried mud-crack style fracture lines dividing the stone into ' +
    'irregular plates — plates mottled between pale rust-tan, dusty pink and ' +
    'warm cream with ochre staining along the crack edges, a few shallow ' +
    'rounded potholes and small blue-grey rock pools with sediment, subtle ' +
    'painted depth in the cracks (no cast shadows). ' +
    COMMON,
  // ---- mesa-top specific layers (v0.12b) ----
  drift:
    'Thin sheet of pale wind-blown sand drifted over slickrock bedrock seen ' +
    'from directly above, delicate wind ripples in cream and pale apricot ' +
    'sand, patches of smooth bare rock showing through in pinkish-tan and ' +
    'dusty rose, soft painted form shading along ripple crests only (no cast ' +
    'shadows). ' +
    COMMON,
  rubble:
    'Sparse lag of small angular stone chips and weathered caprock fragments ' +
    'scattered over pale pink-tan slickrock bedrock seen from directly above — ' +
    'chips in varied hand-painted hues: dark plum-brown desert varnish, rust-red ' +
    'fracture faces, a few ochre and blue-grey pieces, chips half-embedded, ' +
    'wide bare bedrock areas between loose stone clusters. ' +
    COMMON,
  crater:
    'Fine powdery impact-crater floor of cool dust seen from directly above, ' +
    'patchy hand-painted variation between ash-taupe, dusty rose, pale lilac-grey ' +
    'and faint sage, hairline desiccation cracks, scattered tiny sharp ejecta ' +
    'fragments in dark plum and rust, small glassy blue-black pebbles half-buried ' +
    'in the dust. ' +
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
        // 2K source detail (v2); normals/heights stay 1K — the loader
        // resamples them to its 1024 working size anyway
        imageConfig: { aspectRatio: '1:1', imageSize: '2K' },
      },
    }),
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) throw new Error(`${name}: no image in response: ${JSON.stringify(json).slice(0, 400)}`);
  // the app loads textures/<name>.jpg — re-encode whatever the API returns
  const file = join(outDir, `${name}.jpg`);
  await sharp(Buffer.from(part.inlineData.data, 'base64'))
    .resize(2048, 2048, { fit: 'cover' })
    .jpeg({ quality: 90 })
    .toFile(file);
  await normalizeMean(name);
  console.log(`wrote ${file} (from ${part.inlineData.mimeType})`);
}

/**
 * Rescale the image so its mean luminance sits at 128: the shader treats
 * detail texels as raw values around 0.5 (`detail * 2` over the vertex
 * palette must be brightness-neutral), so a bright-mean texture bleaches
 * every surface it covers map-wide. Multiplicative in linear-ish space —
 * hue ratios survive; only the global level moves.
 */
async function normalizeMean(name) {
  const file = join(outDir, `${name}.jpg`);
  // read into memory first — sharp holds the input handle open, which on
  // Windows blocks writing back to the same path
  const src = readFileSync(file);
  const { channels } = await sharp(src).stats();
  const mean = 0.299 * channels[0].mean + 0.587 * channels[1].mean + 0.114 * channels[2].mean;
  const k = Math.min(1.5, Math.max(0.6, 128 / mean));
  if (Math.abs(k - 1) < 0.02) return;
  const buf = await sharp(src).linear(k, 0).jpeg({ quality: 90 }).toBuffer();
  writeFileSync(file, buf);
  console.log(`  ${name}: mean ${mean.toFixed(1)} -> x${k.toFixed(3)}`);
}

mkdirSync(outDir, { recursive: true });
const args = process.argv.slice(2);
if (args[0] === '--normalize-only') {
  // re-level existing files without hitting the API
  const names = args.slice(1).length ? args.slice(1) : Object.keys(TEXTURES);
  for (const name of names) await normalizeMean(name);
} else {
  const names = args.length ? args : Object.keys(TEXTURES);
  for (const name of names) {
    if (!TEXTURES[name]) throw new Error(`unknown texture: ${name}`);
    await generate(name, TEXTURES[name]);
  }
}
