// Bundles whiteboard.entry.mjs into public/vendor/whiteboard/ (see build-whiteboard.sh). Deterministic: same inputs → same files.
//  · production React (process.env.NODE_ENV = "production"), ESM with code splitting (Excalidraw's lazy parts stay lazy);
//  · only the Spanish and English Excalidraw locales are kept (the app is ES / EN), the others become an empty module;
//  · Mermaid → diagram ("@excalidraw/mermaid-to-excalidraw", several MB) is replaced by a stub that says it is not available;
//  · the font fallback URL (https://esm.sh/…) is pointed at our own copy, so nothing is ever requested from a CDN;
//  · fonts are copied WITHOUT Xiaolai (13 MB of Chinese glyphs): CJK text falls back to the system font;
//  · font SUBSETTING for SVG export (harfbuzz + woff2 compiled to WebAssembly, 1.8 MB, and a worker) is replaced by a stub that
//    embeds the whole font file: WebAssembly would need 'wasm-unsafe-eval' in the CSP, and Excalidraw's fonts are already split
//    by unicode range (each file is 3–80 KB), so an exported SVG only grows a little.
import { build } from 'esbuild';
import { cpSync, rmSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../../../public/vendor/whiteboard');
const pkg = join(here, 'node_modules/@excalidraw/excalidraw/dist/prod');
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });

const KEEP_LOCALE = /\/locales\/(es-ES|en|percentages)-[A-Z0-9]+\.js$/;
const plugin = {
  name: 'teroclass-whiteboard',
  setup(b) {
    b.onResolve({ filter: /^\.\/locales\// }, a => (KEEP_LOCALE.test('/' + a.path.slice(2)) ? undefined : { path: 'empty-locale', namespace: 'tc-empty-locale' }));
    b.onLoad({ filter: /.*/, namespace: 'tc-empty-locale' }, () => ({ contents: 'export default {};', loader: 'js' }));
    b.onResolve({ filter: /^\.\/subset-(shared|worker)\.chunk\.js$/ }, a => ({ path: a.path.includes('worker') ? 'worker' : 'shared', namespace: 'tc-subset' }));
    b.onLoad({ filter: /.*/, namespace: 'tc-subset' }, a => ({ loader: 'js', contents: a.path === 'worker' ? 'export const WorkerUrl = undefined;' : [
      'const toBase64 = async b => { const u = new Uint8Array(b); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return `data:font/woff2;base64,${btoa(s)}`; };',
      'export const Commands = { Subset: "SUBSET" };',
      'export const subsetToBase64 = async buf => toBase64(buf);',
      'export const subsetToBinary = async buf => buf;',
      'export { toBase64 };'].join('\n') }));
    b.onResolve({ filter: /^@excalidraw\/mermaid-to-excalidraw$/ }, () => ({ path: 'mermaid-stub', namespace: 'tc-mermaid' }));
    b.onLoad({ filter: /.*/, namespace: 'tc-mermaid' }, () => ({ loader: 'js',
      contents: 'export const parseMermaidToExcalidraw = async () => { throw new Error("Mermaid is not available in TeroClass"); };' }));
    b.onLoad({ filter: /@excalidraw[\\/]excalidraw[\\/]dist[\\/]prod[\\/].*\.js$/ }, a => {
      let src = readFileSync(a.path, 'utf8');
      src = src.split('`https://esm.sh/${M.PKG_NAME?`${M.PKG_NAME}@${M.PKG_VERSION}`:"@excalidraw/excalidraw"}/dist/prod/`')
        .join('`${(typeof location<"u"?location.origin:"")}/vendor/whiteboard/`');
      if (/esm\.sh/.test(src)) throw new Error('esm.sh fallback still present in ' + a.path);
      if (src.includes('subset-worker.chunk.js')) { // never try a subsetting worker (see the stub above)
        if (!src.includes('Vd=typeof Worker<"u"')) throw new Error('subsetting worker switch not found in ' + a.path);
        src = src.replace('Vd=typeof Worker<"u"', 'Vd=!1');
      }
      return { contents: src, loader: 'js' };
    });
  },
};
const result = await build({
  metafile: true,
  entryPoints: { whiteboard: join(here, 'whiteboard.entry.mjs') },
  bundle: true, format: 'esm', splitting: true, minify: true, target: 'es2020', legalComments: 'eof',
  outdir: out, entryNames: '[name]', chunkNames: 'chunks/[name]-[hash]', assetNames: 'assets/[name]-[hash]',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
  conditions: ['production'], logLevel: 'warning', plugins: [plugin],
  banner: { js: '/* TeroClass vendored whiteboard: React 18.3.1 + ReactDOM 18.3.1 + @excalidraw/excalidraw 0.18.1 (MIT). Built by scripts/vendor/build-whiteboard.sh. Do not edit. */' },
});
cpSync(join(pkg, 'index.css'), join(out, 'excalidraw.css'));
for (const f of readdirSync(join(pkg, 'fonts'))) if (f !== 'Xiaolai') cpSync(join(pkg, 'fonts', f), join(out, 'fonts', f), { recursive: true });
const lic = join(here, '../../../public/vendor/licenses');
const nm = join(here, 'node_modules');
for (const [name, file] of [['react-18.3.1', 'react/LICENSE'], ['react-dom-18.3.1', 'react-dom/LICENSE']]) cpSync(join(nm, file), join(lic, name + '-LICENSE'));
// The npm package of Excalidraw ships no LICENSE file: its MIT license (github.com/excalidraw/excalidraw/blob/master/LICENSE)
const MIT = holder => `MIT License\n\nCopyright (c) ${holder}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n`;
writeFileSync(join(lic, 'excalidraw-excalidraw-0.18.1-LICENSE'), MIT('2020 Excalidraw'));
// every npm package that ended up in the bundle, with its declared license (+ its license text when the package has one)
const pkgs = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.replace(/\\/g, '/')); if (!m) continue;
  if (pkgs.has(m[1])) continue;
  const pj = JSON.parse(readFileSync(join(nm, m[1], 'package.json'), 'utf8'));
  const lf = readdirSync(join(nm, m[1])).find(f => /^(licen[sc]e|copying)(\.|$)/i.test(f));
  pkgs.set(m[1], { v: pj.version, l: typeof pj.license === 'string' ? pj.license : (pj.license?.type || (pj.licenses || []).map(x => x.type || x).join(' OR ') || '?'), text: lf ? readFileSync(join(nm, m[1], lf), 'utf8').trim() : '' });
}
const lines = ['Third-party code inside public/vendor/whiteboard/ (built by scripts/vendor/build-whiteboard.sh).', '',
  'Fonts in public/vendor/whiteboard/fonts (from @excalidraw/excalidraw 0.18.1): Excalifont, Virgil, Nunito, Lilita One, Cascadia Code,',
  'Liberation Sans and Assistant under the SIL Open Font License 1.1; Comic Shanns under the MIT license.', '',
  ...[...pkgs.entries()].sort().map(([n, x]) => `${n}@${x.v} — ${x.l}`), '',
  ...[...pkgs.entries()].sort().filter(([, x]) => x.text).map(([n, x]) => `──────── ${n}@${x.v} ────────\n${x.text}\n`)];
writeFileSync(join(lic, 'excalidraw-0.18.1-THIRD-PARTY.txt'), lines.join('\n'));
writeFileSync(join(out, 'VERSIONS.txt'), 'react 18.3.1\nreact-dom 18.3.1\n@excalidraw/excalidraw 0.18.1\nesbuild 0.25.10\nBuilt by scripts/vendor/build-whiteboard.sh (fonts without Xiaolai; locales es-ES + en only; Mermaid stubbed).\n');
