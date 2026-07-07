// Generate normal maps for the detail textures with nano-banana2
// (image-to-image from public/textures/<name>.jpg). Writes
// public/textures/<name>_n.png — the app prefers these over the runtime
// Sobel bake (src/viewer/normalMaps.ts); delete a file to fall back.
//
// The written files are CANONICAL (no app-side channel flips needed):
// after generation each channel's sign is calibrated against the ground
// truth relief — the gradient of <name>_h.png if present (white = high
// by construction of gen-heightmaps.mjs), else albedo luminance — and
// flipped in the file itself if the model inverted it. The v1 set relied
// on an AUTHORED_FLIP_R loader hack instead; run gen-heightmaps first
// so calibration uses real heights.
//
//   node tools/gen-normalmaps.mjs [name ...]   (default: all)

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
  'OpenGL convention: base color RGB(128,128,255) lavender for flat areas. ' +
  'Channel directions, follow EXACTLY: where the surface tilts to face the ' +
  'RIGHT edge of the image (a slope rising toward the left), the red channel ' +
  'is brighter than 128; where it faces the LEFT edge, darker than 128. ' +
  'Where the surface tilts to face the TOP edge (a slope rising toward the ' +
  'bottom), the green channel is brighter than 128; where it faces the ' +
  'BOTTOM edge, darker. Example: a round bump is red on its right side, ' +
  'green on its upper side. CRITICAL: keep the EXACT same layout, position ' +
  'and scale of every feature as the source image, pixel-aligned — do not ' +
  'redraw or rearrange anything. Use SMOOTH CONTINUOUS gradients over each ' +
  'bump and hollow — soft rounded transitions, absolutely no flat posterized ' +
  'color patches, no outlines, no hard color steps. Gentle relief: colors ' +
  'stay within ±35% of the lavender base. No lighting, no shadows, no text. ' +
  'Seamless tileable like the source. ';

const CAL = 128; // calibration working size — broad forms decide the sign

/** grayscale reference relief, CAL×CAL: height map if present, else albedo luminance */
async function referenceHeight(name) {
  const hFile = join(texDir, `${name}_h.png`);
  const src = existsSync(hFile) ? hFile : join(texDir, `${name}.jpg`);
  const raw = await sharp(src)
    .resize(CAL, CAL, { fit: 'fill' })
    .blur(1.5)
    .grayscale()
    .raw()
    .toBuffer();
  return { data: raw, from: existsSync(hFile) ? 'height map' : 'albedo luminance' };
}

/**
 * Correlate the generated channels with the reference relief gradient and
 * flip any channel the model inverted. Expected signs match the in-app
 * Sobel bake (normalMaps.ts, verified in-engine): R ~ -dh/dx (faces
 * right where height falls to the right), G ~ +dh/dy in row space
 * (uploaded flipY: +v = image top).
 */
async function calibrate(name, pngBuffer) {
  const img = sharp(pngBuffer).resize(1024, 1024, { fit: 'fill' });
  const full = await img.clone().raw().toBuffer({ resolveWithObject: true });
  const smallR = await img
    .clone()
    .resize(CAL, CAL, { fit: 'fill' })
    .blur(1.5)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const small = smallR.data;
  const sch = smallR.info.channels;
  const ch = full.info.channels;
  const { data: href, from } = await referenceHeight(name);

  let cR = 0;
  let cG = 0;
  let nR = 0;
  let nG = 0;
  let nH = 0;
  const at = (x, y) => href[((y + CAL) % CAL) * CAL + ((x + CAL) % CAL)];
  for (let y = 0; y < CAL; y++) {
    for (let x = 0; x < CAL; x++) {
      const dx = at(x + 1, y) - at(x - 1, y);
      const dy = at(x, y + 1) - at(x, y - 1);
      const i = (y * CAL + x) * sch;
      const r = small[i] - 128;
      const g = small[i + 1] - 128;
      cR += r * -dx;
      cG += g * dy;
      nR += r * r;
      nG += g * g;
      nH += dx * dx + dy * dy;
    }
  }
  const norm = Math.sqrt(nH / 2) || 1;
  const corrR = cR / ((Math.sqrt(nR) || 1) * norm);
  const corrG = cG / ((Math.sqrt(nG) || 1) * norm);
  const flipR = cR < 0;
  const flipG = cG < 0;
  console.log(
    `  ${name}: corr vs ${from} R=${corrR.toFixed(3)}${flipR ? ' FLIP' : ''} ` +
      `G=${corrG.toFixed(3)}${flipG ? ' FLIP' : ''}` +
      (Math.abs(corrR) < 0.05 || Math.abs(corrG) < 0.05 ? '  (LOW CONFIDENCE — eyeball it)' : ''),
  );

  if (!flipR && !flipG) return sharp(pngBuffer).resize(1024, 1024, { fit: 'fill' }).png().toBuffer();
  const d = full.data;
  for (let i = 0; i < d.length; i += ch) {
    if (flipR) d[i] = 255 - d[i];
    if (flipG) d[i + 1] = 255 - d[i + 1];
  }
  return sharp(d, { raw: full.info }).png().toBuffer();
}

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
  const calibrated = await calibrate(name, Buffer.from(part.inlineData.data, 'base64'));
  const file = join(texDir, `${name}_n.png`);
  writeFileSync(file, calibrated);
  console.log(`wrote ${file}`);
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
for (const name of names) await generate(name);
