// EXPERIMENT: can nano-banana2 (gemini-3-pro-image) turn a detail texture
// into a usable normal map (or height map)? Sends the existing texture as
// image input and writes candidates NEXT TO the tool (tools/nmap-test/),
// not into public/textures/.
//
//   node tools/gen-normalmap-test.mjs [texture-name]   (default: cliff)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'tools', 'nmap-test');
const MODEL = 'gemini-3-pro-image';

const env = readFileSync(join(root, '.env.local'), 'utf8');
const key = env.match(/VITE_NANOBANANA_KEY=(\S+)/)?.[1];
if (!key) throw new Error('VITE_NANOBANANA_KEY not found in .env.local');

const name = process.argv[2] ?? 'cliff';
const srcPath = join(root, 'public', 'textures', `${name}.jpg`);
const srcB64 = readFileSync(srcPath).toString('base64');

const PROMPTS = {
  normal:
    'Convert this texture photo into its tangent-space NORMAL MAP for 3D ' +
    'rendering (OpenGL convention: red = surface slope toward +X/right, ' +
    'green = slope toward +Y/up in the image, flat areas exactly RGB ' +
    '(128,128,255)). Preserve the exact layout and scale of every feature ' +
    'in the source pixel-for-pixel — same cracks, same strata lines, same ' +
    'position. Output ONLY the normal map, mostly lavender-blue, no ' +
    'lighting, no shadows, no text, seamless tileable like the source.',
  height:
    'Convert this texture photo into its grayscale HEIGHT MAP ' +
    '(displacement map) for 3D rendering: white = highest surface points, ' +
    'black = deepest cracks and recesses, mid-gray = average surface. ' +
    'Preserve the exact layout and scale of every feature in the source ' +
    'pixel-for-pixel — same cracks, same strata lines, same positions. ' +
    'Output ONLY the grayscale height map, no lighting or shading effects, ' +
    'no text, seamless tileable like the source.',
};

async function generate(kind, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: srcB64 } },
            { text: prompt },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
      },
    }),
  });
  if (!res.ok) throw new Error(`${kind}: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) throw new Error(`${kind}: no image: ${JSON.stringify(json).slice(0, 300)}`);
  const file = join(outDir, `${name}-${kind}.png`);
  writeFileSync(file, Buffer.from(part.inlineData.data, 'base64'));
  console.log(`wrote ${file}`);
}

mkdirSync(outDir, { recursive: true });
await generate('normal', PROMPTS.normal);
await generate('height', PROMPTS.height);
