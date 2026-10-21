// TC-11: the app works under the REAL security headers of vercel.json (Content-Security-Policy, X-Frame-Options, …).
// Every request is answered like Vercel would: vercel.json rewrites → the file in public/, plus the headers of the
// matching "headers" rules. Supabase REST is the mock (tests/mock-supabase.cjs); no real data.
// Checked: no CSP violation while signing in, the self-hosted Inter font, supabase-js, the live room with the LiveKit
// SDK (/vendor), the class-document editor (dynamic import), pdf.js + its worker, mammoth, a Realtime websocket to
// *.supabase.co and LiveKit to *.livekit.cloud (allowed), an inline event handler-free framing check, and that
// third-party origins (the old CDNs) are blocked. The class whiteboard (Excalidraw + React, /vendor/whiteboard, lazy chunks,
// its fonts from /vendor/whiteboard/fonts via EXCALIDRAW_ASSET_PATH) opens, draws, saves and exports PNG / SVG under the CSP.
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-csp.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const M = require('./mock-supabase.cjs');
const { handleSupabase, SB } = M;

const ROOT = path.join(__dirname, '..');
const V = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const re = src => new RegExp('^' + src + '$');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json' };
let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log('✓', name); } catch (e) { failed++; console.log('✗', name, '→', String(e.message).split('\n').slice(0, 3).join(' | ')); } };

function headersFor(p) {
  const h = {};
  for (const rule of V.headers || []) if (re(rule.source).test(p)) for (const x of rule.headers) h[x.key] = x.value;
  return h;
}
function fileFor(p) {
  for (const r of V.rewrites || []) {
    const m = re(r.source).exec(p); if (!m) continue;
    if (r.destination.startsWith('/api/')) return null;
    const dest = r.destination.replace(/\$(\d)/g, (_, i) => m[+i] || '');
    return path.join(ROOT, dest);
  }
  return path.join(ROOT, 'public', p);
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  M.resetDb();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const seen = { violations: [], fonts: 0, lk: 0, token: 0, served: new Set(), thirdParty: [] };
  await ctx.route(SB + '/**', handleSupabase);
  await ctx.route('https://cdn.jsdelivr.net/**', r => { seen.thirdParty.push(r.request().url()); return r.abort(); });
  await ctx.route('https://teroclass.test/**', async r => {
    const u = new URL(r.request().url()); const p = u.pathname;
    if (p === '/api/class/config') return r.fulfill({ contentType: 'application/json', headers: headersFor(p), body: '{"configured":true}' });
    if (p === '/api/class/token') { seen.token++; return r.fulfill({ contentType: 'application/json', headers: headersFor(p), body: JSON.stringify({ configured: true, url: 'wss://teroclass-test.livekit.cloud', token: 'a.b.c', identity: 'x', room: 'r', role: 'teacher', recorded: false }) }); }
    if (p.startsWith('/api/')) return r.fulfill({ status: 404, contentType: 'application/json', headers: headersFor(p), body: '{}' });
    const f = fileFor(p);
    if (!f || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.fulfill({ status: 404, body: 'not found' });
    if (p.startsWith('/vendor/fonts/')) seen.fonts++;
    if (p.startsWith('/vendor/livekit-client')) seen.lk++;
    seen.served.add(p);
    return r.fulfill({ status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', headers: headersFor(p), body: fs.readFileSync(f) });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) seen.violations.push(m.text()); });
  await page.addInitScript(() => { document.addEventListener('securitypolicyviolation', e => { (window.__csp = window.__csp || []).push(e.violatedDirective + ' ' + e.blockedURI); }); });
  const base = 'https://teroclass.test';

  await step('TC-11 headers are present on the page (CSP with frame-ancestors, nosniff, referrer, permissions)', async () => {
    const r = await page.goto(base + '/');
    const h = r.headers();
    if (!/frame-ancestors 'none'/.test(h['content-security-policy'] || '')) throw new Error('CSP: ' + h['content-security-policy']);
    if (h['x-frame-options'] !== 'DENY' || h['x-content-type-options'] !== 'nosniff' || !/strict-origin/.test(h['referrer-policy'] || '') || !/camera=\(self\)/.test(h['permissions-policy'] || '')) throw new Error('headers: ' + JSON.stringify(h));
    await page.waitForSelector('#tab-login', { state: 'visible' });
  });

  await step('TC-11 sign-up and the app under the CSP: supabase-js from /vendor, Inter from /vendor/fonts, no violation', async () => {
    await page.click('.auth-tab:nth-child(2)');
    await page.fill('#reg-name', 'Ana CSP'); await page.fill('#reg-email', 'csp@t.com'); await page.fill('#reg-password', 'secreto123');
    await page.click('#tab-register .auth-btn');
    await page.waitForSelector('#screen-app.active');
    await page.evaluate(() => document.fonts.ready);
    if (!(await page.evaluate(() => document.fonts.check('600 14px Inter')))) throw new Error('Inter not loaded');
    if (!seen.fonts) throw new Error('the font was not requested from /vendor/fonts');
    if (!seen.served.has('/vendor/supabase-js-2.116.0.js')) throw new Error('supabase-js not served from /vendor');
  });

  await step('TC-11 live room: the LiveKit SDK (/vendor) loads and a LiveKit / Realtime websocket is allowed', async () => {
    await page.click('#nav-live');
    await page.waitForSelector('#panel-live.active #lc-start-btn');
    await page.click('#lc-start-btn');
    await page.waitForSelector('.lc-lobby');
    await page.waitForSelector('#lc-consent');
    await page.check('#lc-consent');
    await page.click('#lc-join');
    await page.waitForSelector('#lc-room', { timeout: 30000 });
    if (!seen.lk) throw new Error('LiveKit SDK not loaded from /vendor');
    if (!seen.token) throw new Error('no token request');
    const ws = await page.evaluate(async () => {
      const tryWs = url => new Promise(res => { try { const w = new WebSocket(url); w.onerror = () => res('error-ok'); w.onopen = () => { w.close(); res('open'); }; setTimeout(() => res('timeout-ok'), 3000); } catch (e) { res('blocked: ' + e.message); } });
      return [await tryWs('wss://ppvqkjchhejjulrdqkdr.supabase.co/realtime/v1/websocket?vsn=1.0.0'), await tryWs('wss://teroclass-test.livekit.cloud/rtc')];
    });
    if (ws.some(x => /blocked/.test(x))) throw new Error('websocket blocked by the CSP: ' + ws);
  });

  await step('TC-11 on-demand libraries under the CSP: class-document editor (import), pdf.js + worker, mammoth', async () => {
    const r = await page.evaluate(async () => {
      const out = {};
      try { const m = await import('/vendor/classdoc-editor.js'); out.editor = !!(m && (m.Y || m.default || Object.keys(m).length)); } catch (e) { out.editor = 'ERR ' + e.message; }
      try { const pdfjs = await import(VENDOR.pdfjs); pdfjs.GlobalWorkerOptions.workerSrc = VENDOR.pdfWorker;
        // a minimal valid PDF with the text "Hola CSP"
        const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 20 100 Td (Hola CSP) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';
        const doc = await pdfjs.getDocument({ data: new TextEncoder().encode(pdf), isEvalSupported: false }).promise;
        const tc = await (await doc.getPage(1)).getTextContent(); out.pdf = tc.items.map(i => i.str).join('');
      } catch (e) { out.pdf = 'ERR ' + e.message; }
      try { await loadScriptOnce(VENDOR.mammoth); out.mammoth = typeof window.mammoth?.extractRawText === 'function'; } catch (e) { out.mammoth = 'ERR ' + e.message; }
      return out;
    });
    if (r.editor !== true) throw new Error('editor: ' + r.editor);
    if (!/Hola CSP/.test(r.pdf)) throw new Error('pdf.js: ' + r.pdf);
    if (r.mammoth !== true) throw new Error('mammoth: ' + r.mammoth);
  });

  await step('Class whiteboard under the CSP: Excalidraw + React from /vendor/whiteboard, its fonts self-hosted, drawing saved, PNG / SVG export', async () => {
    const db = M.db; const me = db.profiles.find(p => p.email === 'csp@t.com');
    const g = { id: M.uid(), institution_id: me.institution_id, name: 'CSP group', teacher_id: me.id, substitute_id: null, timezone: 'America/Montevideo', created_at: new Date().toISOString() };
    db.class_groups.push(g);
    const s = { id: M.uid(), institution_id: me.institution_id, group_id: g.id, series_id: null, teacher_id: me.id, title: 'CSP board', starts_at: new Date(Date.now() - 5 * 60000).toISOString(), ends_at: new Date(Date.now() + 55 * 60000).toISOString(), timezone: 'America/Montevideo', status: 'scheduled', seq: 0, modified: false };
    db.class_sessions.push(s);
    const txt = { id: 'csp-t1', type: 'text', version: 2, versionNonce: 11, isDeleted: false, x: 60, y: 60, width: 200, height: 25, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
      roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 3, boundElements: null, updated: 1, link: null, locked: false, index: 'a0', text: 'Hola pizarra', originalText: 'Hola pizarra', fontSize: 20, fontFamily: 5,
      textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.25 };
    db.class_boards.push({ session_id: s.id, rev: 1, generation: 1, locked: false, bytes: 600, channel_key: 'c'.repeat(64), updated_at: new Date().toISOString() });
    db.class_board_elements.push({ session_id: s.id, element_id: txt.id, version: 2, nonce: 11, deleted: false, rev: 1, data: txt, bytes: 600 });
    await page.evaluate(id => TCClassBoard.open(id), s.id);
    await page.waitForSelector('#cb-overlay .excalidraw canvas.interactive', { timeout: 30000 });
    await page.waitForFunction(() => TCClassBoard._test.view?.api?.getSceneElements().length === 1, null, { timeout: 15000 });
    await page.click('#cb-overlay label:has([data-testid="toolbar-rectangle"])');
    const box = await page.locator('#cb-overlay canvas.interactive').boundingBox();
    await page.mouse.move(box.x + 400, box.y + 250); await page.mouse.down(); await page.mouse.move(box.x + 600, box.y + 380, { steps: 6 }); await page.mouse.up();
    for (let i = 0; i < 50 && !db.class_board_elements.some(e => e.session_id === s.id && e.data.type === 'rectangle'); i++) await page.waitForTimeout(100);
    if (!db.class_board_elements.some(e => e.session_id === s.id && e.data.type === 'rectangle')) throw new Error('the drawing was not saved');
    const svg = await page.evaluate(async () => { const v = TCClassBoard._test.view; const out = await TCClassBoard.loadLib().then(M => M.exportToSvg({ elements: v.api.getSceneElements(), appState: { exportBackground: true, viewBackgroundColor: '#fff' }, files: null }));
      const png = await TCClassBoard.loadLib().then(M => M.exportToBlob({ elements: v.api.getSceneElements(), appState: { exportBackground: true, viewBackgroundColor: '#fff' }, files: null, mimeType: 'image/png' }));
      return { svg: out.outerHTML.length, font: /@font-face/.test(out.outerHTML), png: png.size }; });
    if (!svg.font || svg.png < 1000) throw new Error('export: ' + JSON.stringify(svg));
    const wb = [...seen.served].filter(p => p.startsWith('/vendor/whiteboard/'));
    if (!wb.includes('/vendor/whiteboard/whiteboard.js') || !wb.includes('/vendor/whiteboard/excalidraw.css') || !wb.some(p => p.startsWith('/vendor/whiteboard/chunks/')) || !wb.some(p => p.startsWith('/vendor/whiteboard/fonts/'))) throw new Error('whiteboard files: ' + wb.join(', '));
    await page.evaluate(() => TCClassBoard.close());
  });

  await step('Plans (2026-10-21): the in-app plans pop-up and sales form, then /planes under the real headers (files from public/, no inline script)', async () => {
    await page.evaluate(() => TCPlans.showPopup('plans'));
    await page.waitForSelector('#tp-overlay:not([hidden]) .tp-card[data-plan="docente"]');
    await page.click('#tp-overlay .tp-card[data-plan="institucion"] [data-tp="sales"]');
    await page.waitForSelector('#tp-form');
    await page.keyboard.press('Escape');
    const r = await page.goto(base + '/planes');
    if (!/frame-ancestors 'none'/.test(r.headers()['content-security-policy'] || '')) throw new Error('no CSP on /planes');
    await page.waitForSelector('.tp-card[data-plan="institucion"]');
    for (const f of ['/plans.js', '/plans.css', '/plans-admin.js']) if (!seen.served.has(f)) throw new Error(f + ' not served from public/');
    if (!(await page.evaluate(() => document.fonts.check('600 14px Inter')))) throw new Error('Inter on /planes');
    await page.click('[data-tp-cur="EUR"]');
    await page.click('.tp-card[data-plan="docente"] [data-tp="docente"]');
    await page.waitForSelector('#tp-form');
    await page.goBack().catch(() => {});
  });

  await step('TC-11 nothing violated the CSP; third-party script origins are blocked', async () => {
    const v = await page.evaluate(() => window.__csp || []);
    const all = [...v, ...seen.violations].filter(x => !/challenges\.cloudflare\.com/.test(x));
    if (all.length) throw new Error('violations: ' + all.join(' | '));
    if (seen.thirdParty.length) throw new Error('third-party requests: ' + seen.thirdParty.join(', '));
    const blocked = await page.evaluate(() => new Promise(res => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/x@1/x.js'; s.onerror = () => res(true); s.onload = () => res(false); document.head.appendChild(s); setTimeout(() => res(true), 3000); }));
    if (!blocked) throw new Error('a CDN script loaded');
    const v2 = await page.evaluate(() => (window.__csp || []).some(x => /script-src/.test(x) && /jsdelivr/.test(x)));
    if (!v2) throw new Error('the CDN script was not stopped by the CSP');
    if (errors.length) throw new Error(errors.join(' | '));
  });

  await browser.close();
  if (failed) { console.log(`${failed} CSP test(s) FAILED`); process.exit(1); }
  console.log('ALL CSP TESTS PASSED');
})();
