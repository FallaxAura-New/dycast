// Read-only smoke test: electron scripts/diagnose-live.cjs <room number>
// Uses an isolated, in-memory session. No app settings or audience content are saved.
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
app.whenReady().then(async () => {
  const ids = process.argv.slice(2).filter(value => /^\d+$/.test(value));
  if (!ids.length) throw new Error('Pass at least one numeric room ID');
  process.env.DYCAST_PORT = '0';
  const server = require('../server.cjs');
  const isolatedSession = session.fromPartition(`live-diagnostic-${Date.now()}`);
  server.setElectronNet(isolatedSession, isolatedSession.cookies);
  await server.startup;
  const window = new BrowserWindow({ show: false, webPreferences: {
    session: isolatedSession, nodeIntegration: false, contextIsolation: true, sandbox: true
  } });
  const timeout = setTimeout(() => app.exit(1), ids.length * 45000 + 15000);
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}/storage.html`);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/mssdk.js';
      script.onload = resolve; script.onerror = () => reject(new Error('SDK load failed'));
      document.head.appendChild(script);
    })`);
    const bundle = buildSync({
      stdin: { contents: `export { DyCast } from './src/core/dycast';`, resolveDir: root },
      alias: { '@': path.join(root, 'src') }, bundle: true, write: false,
      format: 'iife', globalName: 'LiveDiagnostic', platform: 'browser', target: 'chrome134'
    }).outputFiles[0].text;
    await window.webContents.executeJavaScript(bundle);
    for (const id of ids) {
      const result = await window.webContents.executeJavaScript(`new Promise(resolve => {
        const client = new LiveDiagnostic.DyCast(${JSON.stringify(id)});
        let opened = false;
        let timer;
        const finish = result => {
          clearTimeout(timer); client.dispose(); resolve(result);
        };
        timer = setTimeout(() => finish({ opened, error: 'Timed out waiting for messages' }), 40000);
        client.on('open', () => { opened = true; });
        client.on('message', messages => {
          if (messages.length) finish({ opened, receivedMessages: messages.length,
            nickname: client.getLiveInfo().nickname });
        });
        client.on('error', error => finish({ opened, error: error.message }));
        client.on('close', (code, reason) => finish({ opened, code, reason }));
        client.connect();
      })`);
      console.log(JSON.stringify({ id, ...result }));
      if (!result.opened || !result.receivedMessages) process.exitCode = 1;
    }
  } finally {
    clearTimeout(timeout);
    window.destroy();
    await new Promise(resolve => server.shutdown(resolve));
  }
}).then(() => app.exit(process.exitCode || 0), error => { console.error(error); app.exit(1); });
