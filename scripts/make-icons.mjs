// Renders the PWA icons from src/web/public/icon.svg. Run after changing the logo:
//   node scripts/make-icons.mjs
import { readFileSync } from 'node:fs';
import sharp from 'sharp';

const out = 'src/web/public';
const svg = readFileSync(`${out}/icon.svg`);

// "maskable" icons are cropped to a circle or squircle by Android: the mark must sit inside
// the central 80% safe zone, on a full-bleed background.
const maskable = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#111214"/>
  <circle cx="256" cy="256" r="118" fill="#f6f2e6"/>
  <circle cx="256" cy="256" r="56" fill="#e8b84a"/>
</svg>`);

await sharp(svg).resize(192, 192).png().toFile(`${out}/icon-192.png`);
await sharp(svg).resize(512, 512).png().toFile(`${out}/icon-512.png`);
await sharp(maskable).resize(512, 512).png().toFile(`${out}/icon-maskable-512.png`);
await sharp(maskable).resize(180, 180).png().toFile(`${out}/apple-touch-icon.png`);
console.log('icons written');
