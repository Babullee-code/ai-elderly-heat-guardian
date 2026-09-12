/**
 * Static build for GitHub Pages.
 *
 * Sets the two environment variables the static demo needs and then copies
 * index.html to 404.html.
 *
 * The 404 copy is the standard GitHub Pages workaround for a single-page app:
 * Pages serves 404.html for any path it does not recognise, and because that
 * file is the app shell, React Router reads the real pathname and routes
 * correctly. Without it, refreshing on /admin/users would show a GitHub 404.
 *
 * Cross-platform by design — it runs identically on Windows, macOS and CI,
 * which a shell one-liner with inline env vars would not.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Base path. GitHub Pages serves a project site from /<repo>/, so the bundle
 * must be built with that prefix. Passed in by CI; defaults to '/' so a local
 * `npm run build:static` is still browsable.
 */
const base = process.env.VITE_BASE_PATH ?? '/';

console.log(`[build:static] base path: ${base}`);

const result = spawnSync('npx', ['vite', 'build'], {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    VITE_STATIC_DEMO: 'true',
    VITE_BASE_PATH: base,
  },
});

if (result.status !== 0) {
  console.error('[build:static] vite build failed');
  process.exit(result.status ?? 1);
}

const dist = join(process.cwd(), 'dist');
const indexHtml = join(dist, 'index.html');

if (!existsSync(indexHtml)) {
  console.error('[build:static] dist/index.html not found');
  process.exit(1);
}

copyFileSync(indexHtml, join(dist, '404.html'));
console.log('[build:static] wrote dist/404.html (SPA deep-link fallback)');

// Tells GitHub Pages not to run the output through Jekyll, which would
// otherwise ignore files and folders beginning with an underscore.
const { writeFileSync } = await import('node:fs');
writeFileSync(join(dist, '.nojekyll'), '');
console.log('[build:static] wrote dist/.nojekyll');

console.log('[build:static] done');
