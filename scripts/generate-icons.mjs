// Generates all PWA icon PNGs into public/, branded from lib/app-config.ts
// (first letter of APP_SHORT_NAME on the THEME_COLOR background).
// Run with: npm run gen:icons
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = await readFile(join(root, "lib", "app-config.ts"), "utf8");
const letter = (
  (cfg.match(/APP_SHORT_NAME\s*=\s*"([^"]+)"/)?.[1] || "A").trim()[0] || "A"
).toUpperCase();
const color = cfg.match(/THEME_COLOR\s*=\s*"([^"]+)"/)?.[1] || "#4f46e5";

const svg = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" fill="${color}"/>
  <text x="50%" y="50%" dy="0.06em" text-anchor="middle" dominant-baseline="central"
        font-family="Helvetica, Arial, sans-serif" font-size="280" font-weight="700"
        fill="#ffffff">${letter}</text>
</svg>`;
const buf = Buffer.from(svg);

const publicDir = join(root, "public");
await mkdir(publicDir, { recursive: true });

const targets = [
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  { file: "apple-icon.png", size: 180, flatten: color },
  { file: "favicon-32.png", size: 32 },
];

for (const t of targets) {
  let img = sharp(buf).resize(t.size, t.size);
  if (t.flatten) img = img.flatten({ background: t.flatten });
  await writeFile(join(publicDir, t.file), await img.png().toBuffer());
  console.log(`✓ public/${t.file} (${t.size}x${t.size}, "${letter}")`);
}
console.log("Done.");
