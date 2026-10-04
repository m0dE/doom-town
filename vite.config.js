import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from './tools/mods/markdown.mjs';

let rev = 'dev';
try { rev = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* not a checkout */ }

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const REPO = 'https://github.com/m0dE/doom-town/blob/main/';

/**
 * /modding.html is docs/MODDING.md rendered into the page shell at build (and dev) time,
 * so the guide has one source. Images under docs/ are bundled by Vite; relative links
 * to repository files point at GitHub.
 */
function moddingGuide() {
  return {
    name: 'modding-guide',
    configureServer(server) {
      server.watcher.add(here('./docs/MODDING.md'));
      server.watcher.on('change', (f) => { if (f.endsWith('MODDING.md')) server.ws.send({ type: 'full-reload' }); });
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (!ctx.filename.endsWith('modding.html')) return html;
        const md = readFileSync(here('./docs/MODDING.md'), 'utf8');
        const { html: body, toc } = renderMarkdown(md, {
          image: (src) => (/^(https?:|\/|data:)/.test(src) ? src : `./docs/${src}`),
          link: (href) => {
            if (/^(https?:|#|mailto:)/.test(href)) return href;
            const path = new URL(href, 'https://x/docs/').pathname.slice(1);
            return REPO + path;
          },
        });
        const nav = `<ol>${toc.filter((t) => t.id !== 'contents').map((t) => `<li><a href="#${t.id}">${t.html}</a></li>`).join('')}</ol>`;
        // the page has its own sidebar contents: drop the markdown's inline list
        const doc = body.replace(/<h2 id="contents">[\s\S]*?<\/ol>/, '');
        return html.replace('<!--MODDING_TOC-->', nav).replace('<!--MODDING_BODY-->', doc);
      },
    },
  };
}

export default defineConfig({
  base: './',
  define: { __BUILD_REV__: JSON.stringify(rev) },
  server: { port: 5190 },
  plugins: [moddingGuide()],
  build: {
    target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 2000,
    rollupOptions: { input: { main: here('./index.html'), modding: here('./modding.html') } },
  },
});
