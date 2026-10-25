// Regenerates the README screenshots in docs/ using headless Chrome.
//
//   node devtap.js 3000 -u 9095 -- node demo/server.js    # terminal 1
//   ./demo/traffic.sh && node scripts/screenshots.mjs      # terminal 2
//
// Env: CHROME (browser binary), DEVTAP_UI (default http://localhost:9095).

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UI = process.env.DEVTAP_UI || 'http://localhost:9095';
const OUT = path.join(import.meta.dirname, '..', 'docs');
const WIDTH = 1440, HEIGHT = 860, SCALE = 2;

const SHOTS = [
  { name: 'overview', theme: 'dark', pick: "i.method === 'POST' && i.status === 201", tab: 'response' },
  { name: 'request', theme: 'dark', pick: "i.method === 'POST' && i.status === 201", tab: 'request' },
  { name: 'websocket', theme: 'dark', pick: "i.kind === 'ws'", tab: 'messages', expand: 1 },
  { name: 'light', theme: 'light', pick: "i.method === 'GET' && i.url.startsWith('/api/users')", tab: 'response' },
];

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const c of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    try { return execFileSync('which', [c], { encoding: 'utf8' }).trim(); } catch {}
  }
  throw new Error('No Chrome/Chromium found; set CHROME=/path/to/chrome');
}

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'devtap-shots-'));
  const chrome = spawn(findChrome(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    chrome.stderr.on('data', (d) => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) resolve(m[1]); });
    chrome.on('exit', () => reject(new Error(`Chrome exited:\n${buf}`)));
  });
  const port = new URL(wsUrl).port;
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const close = () => { ws.close(); chrome.kill(); fs.rmSync(profile, { recursive: true, force: true }); };
  return { send, close };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { send, close } = await launch();
  try {
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false });
    for (const shot of SHOTS) {
      await send('Page.navigate', { url: UI });
      await sleep(1200);
      const { result } = await send('Runtime.evaluate', {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
          setTheme(${JSON.stringify(shot.theme)});
          const it = [...S.items.values()].find((i) => ${shot.pick});
          if (!it) return 'no item matches ${shot.pick.replace(/'/g, '')}';
          select(it.id);
          for (let n = 0; n < 50 && S.detail?.id !== it.id; n++) await new Promise((r) => setTimeout(r, 50));
          document.querySelector('[data-tab="${shot.tab}"]')?.click();
          ${shot.expand != null ? `document.querySelectorAll('.msg-h')[${shot.expand}]?.click();` : ''}
          document.activeElement?.blur();
          await new Promise((r) => setTimeout(r, 300));
          return 'ok';
        })()`,
      });
      if (result.value !== 'ok') throw new Error(`${shot.name}: ${result.value}`);
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, `${shot.name}.png`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`wrote ${path.relative(process.cwd(), file)}`);
    }
  } finally {
    close();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
