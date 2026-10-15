/**
 * Renders assets/icon.svg to the PNG sizes the manifests reference.
 * Chromium needs PNGs; Firefox would accept SVG, but one set keeps it simple.
 *
 *   bun scripts/icons.ts
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const root = join(import.meta.dir, '..');
const svg = await readFile(join(root, 'assets/icon.svg'), 'utf8');
const outDir = join(root, 'public/icons');
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 96, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  await page.screenshot({ path: join(outDir, `icon-${size}.png`), omitBackground: true });
}
await browser.close();
console.log('icons written to public/icons');
