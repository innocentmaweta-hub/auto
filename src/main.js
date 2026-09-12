const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');
const http = require('http');

let win;
let browser;
let page;
let recording = false;
let running = false;
let stopRequested = false;
let workflow = [];
let recorderTimer;
let browserOwnedByAuto = false;
let torLauncherProcess;

function createWindow() {
  win = new BrowserWindow({ width: 1100, height: 760, minWidth: 900, minHeight: 600, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  win.loadFile(path.join(__dirname, 'index.html'));
}
function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }

function getTorBrowserCandidates() {
  if (process.platform !== 'win32') return [];
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
    path.join(home, 'Desktop', 'Tor Browser', 'Browser', 'firefox.exe'),
    path.join(home, 'Downloads', 'Tor Browser', 'Browser', 'firefox.exe'),
    path.join(home, 'Documents', 'Tor Browser', 'Browser', 'firefox.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Tor Browser', 'Browser', 'firefox.exe'),
    path.join(process.env.APPDATA || '', 'Tor Browser', 'Browser', 'firefox.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tor Browser', 'Browser', 'firefox.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tor Browser', 'Browser', 'firefox.exe'),
    'C:\\Tor Browser\\Browser\\firefox.exe'
  ];
  return [...new Set(candidates.filter(Boolean))];
}

function getTorRoot(executablePath) {
  return path.resolve(path.dirname(executablePath), '..');
}

function getTorProfile(executablePath) {
  const root = getTorRoot(executablePath);
  const profile = path.join(root, 'Browser', 'TorBrowser', 'Data', 'Browser', 'profile.default');
  return fs.existsSync(profile) ? profile : null;
}

function getTorEnvironment(executablePath) {
  const root = getTorRoot(executablePath);
  const browserDir = path.dirname(executablePath);
  const torDir = path.join(root, 'Browser', 'TorBrowser', 'Tor');
  const env = { ...process.env };
  env.PATH = [torDir, browserDir, process.env.PATH || ''].filter(Boolean).join(';');
  env.HOME = root;
  return env;
}

function getTorExecutablePath() {
  return getTorBrowserCandidates().find(p => fs.existsSync(p)) || null;
}

function getTorLauncherCandidates(executablePath) {
  const root = getTorRoot(executablePath);
  return [
    path.join(root, 'Start Tor Browser.exe'),
    path.join(root, 'start-tor-browser.exe'),
    path.join(root, 'Browser', 'start-tor-browser.exe'),
    path.join(root, 'Browser', 'start-tor-browser')
  ];
}

function checkLocalPort(port, timeout = 250) {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/', timeout }, res => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function findExistingTorEndpoint() {
  const ports = [];
  const configured = Number(process.env.AUTO_TOR_DEBUG_PORT || 9222);
  for (let port = configured; port <= configured + 10; port++) ports.push(port);

  for (const port of ports) {
    if (!(await checkLocalPort(port))) continue;
    const endpoints = [
      `ws://127.0.0.1:${port}/session`,
      `ws://localhost:${port}/session`
    ];
    for (const browserWSEndpoint of endpoints) {
      try {
        const connected = await Promise.race([
          puppeteer.connect({ protocol: 'webDriverBiDi', browserWSEndpoint, protocolTimeout: 5000 }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('connection timeout')), 3000))
        ]);
        if (connected) return { browser: connected, port, endpoint: browserWSEndpoint };
      } catch (_) {}
    }
  }
  return null;
}

async function waitForTorEndpoint(timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const existing = await findExistingTorEndpoint();
    if (existing) return existing;
    await new Promise(r => setTimeout(r, 750));
  }
  return null;
}

async function injectRecorder() {
  if (!page) return;
  await page.exposeFunction('autoRecordEvent', event => {
    if (!recording) return;
    workflow.push(event);
    send('recorded-step', event);
  });
  await page.evaluateOnNewDocument(() => {
    const getSelector = el => {
      if (!el || !(el instanceof Element)) return null;
      if (el.id) return `#${CSS.escape(el.id)}`;
      if (el.name) return `${el.tagName.toLowerCase()}[name=\"${CSS.escape(el.name)}\"]`;
      const aria = el.getAttribute('aria-label');
      if (aria) return `${el.tagName.toLowerCase()}[aria-label=\"${CSS.escape(aria)}\"]`;
      const test = el.getAttribute('data-testid');
      if (test) return `[data-testid=\"${CSS.escape(test)}\"]`;
      return null;
    };
    const emit = event => window.autoRecordEvent?.({ ...event, url: location.href, at: Date.now() });
    document.addEventListener('click', e => {
      const el = e.target?.closest?.('button,a,input,textarea,select,[role=\"button\"]');
      const selector = getSelector(el);
      if (selector) emit({ type: 'click', selector, text: (el.innerText || el.value || '').trim().slice(0, 120) });
    }, true);
    const recordInput = e => {
      const el = e.target, selector = getSelector(el);
      if (!selector || !['INPUT','TEXTAREA'].includes(el.tagName) || el.type === 'password') return;
      emit({ type: 'fill', selector, value: el.value });
    };
    document.addEventListener('change', recordInput, true);
    document.addEventListener('blur', recordInput, true);
    document.addEventListener('change', e => {
      const el = e.target, selector = getSelector(el);
      if (selector && el.tagName === 'SELECT') emit({ type: 'select', selector, value: el.value });
    }, true);
    let scrollTimer;
    document.addEventListener('scroll', () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => emit({ type: 'scroll', x: window.scrollX, y: window.scrollY }), 250);
    }, { passive: true });
  });
}

async function launchTorBrowser() {
  const executablePath = getTorExecutablePath();
  if (!executablePath) {
    const result = await dialog.showOpenDialog(win, {
      title: 'Select Tor Browser executable',
      properties: ['openFile'],
      filters: [{ name: 'Tor Browser / Firefox executable', extensions: ['exe'] }]
    });
    if (result.canceled || !result.filePaths?.[0]) throw new Error('Tor Browser executable was not selected.');
  }

  const firefoxPath = getTorExecutablePath() || executablePath;
  const root = getTorRoot(firefoxPath);
  const launcherPath = getTorLauncherCandidates(firefoxPath).find(p => fs.existsSync(p));
  if (!launcherPath) {
    throw new Error(`Could not find the Tor Browser launcher next to ${firefoxPath}. Start Tor Browser normally once and try again.`);
  }

  const debugPort = Number(process.env.AUTO_TOR_DEBUG_PORT || 9222);
  send('browser-status', `Starting Tor Browser through its official launcher: ${launcherPath}`);

  try {
    const env = getTorEnvironment(firefoxPath);
    env.TOR_FORCE_NET_CONFIG = '0';
    torLauncherProcess = spawn(launcherPath, [`--remote-debugging-port=${debugPort}`], {
      cwd: root,
      env,
      windowsHide: false,
      detached: false
    });

    torLauncherProcess.on('error', error => {
      send('browser-status', `Tor launcher error: ${error.message}`);
    });

    const connected = await waitForTorEndpoint(60000);
    if (!connected) {
      throw new Error(`Tor Browser started, but its WebDriver BiDi endpoint did not appear on localhost:${debugPort}. Make sure Tor finishes connecting before recording.`);
    }

    browserOwnedByAuto = true;
    send('browser-status', `Connected to new Tor Browser session on port ${connected.port}`);
    return connected.browser;
  } catch (error) {
    if (torLauncherProcess && !torLauncherProcess.killed) torLauncherProcess.kill();
    torLauncherProcess = null;
    throw new Error(`Could not start Tor Browser. ${error.message}`);
  }
}

async function getOrStartTorBrowser() {
  if (browser) return browser;

  const existing = await findExistingTorEndpoint();
  if (existing) {
    browserOwnedByAuto = false;
    send('browser-status', `Connected to existing Tor Browser on port ${existing.port}`);
    return existing.browser;
  }

  return launchTorBrowser();
}

async function startBrowser(url) {
  if (browser) {
    if (browserOwnedByAuto) await browser.close().catch(() => {});
    else browser.disconnect?.();
  }

  browser = await getOrStartTorBrowser();
  const pages = await browser.pages();
  page = pages.find(p => p.url() && p.url() !== 'about:blank') || pages[0] || await browser.newPage();
  await injectRecorder();
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame() && recording) {
      const event = { type: 'navigate', url: frame.url(), at: Date.now() };
      workflow.push(event);
      send('recorded-step', event);
    }
  });

  if (url && page.url() !== url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } else if (!page.url() || page.url() === 'about:blank') {
    await page.goto(url || 'https://example.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  send('browser-status', browserOwnedByAuto ? 'Tor Browser ready' : 'Existing Tor Browser ready');
}

async function runStep(step) {
  if (!page) throw new Error('Tor Browser is not running');
  if (step.type === 'navigate') return page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (step.type === 'click') return page.locator(step.selector).first().click({ timeout: 15000 });
  if (step.type === 'fill') return page.locator(step.selector).first().fill(step.value ?? '', { timeout: 15000 });
  if (step.type === 'select') return page.locator(step.selector).first().selectOption(step.value, { timeout: 15000 });
  if (step.type === 'scroll') return page.evaluate(({ x, y }) => window.scrollTo(x, y), { x: step.x || 0, y: step.y || 0 });
  if (step.type === 'wait') return new Promise(r => setTimeout(r, step.ms || 1000));
}

async function replay(repeats) {
  if (!workflow.length) throw new Error('Record at least one step first');
  if (!page) await startBrowser(workflow.find(s => s.type === 'navigate')?.url);
  const count = repeats === 'continuous' ? Number.MAX_SAFE_INTEGER : Math.max(1, Number(repeats) || 1);
  running = true;
  stopRequested = false;
  send('run-status', { running: true, iteration: 0, total: repeats });
  for (let i = 1; i <= count && !stopRequested; i++) {
    for (const step of workflow) {
      if (stopRequested) break;
      if (step.type === 'navigate' && i === 1 && step.url === page.url()) continue;
      await runStep(step);
      await new Promise(r => setTimeout(r, 150));
    }
    send('run-status', { running: !stopRequested, iteration: i, total: repeats });
  }
  running = false;
  send('run-status', { running: false, iteration: 0, total: repeats, stopped: stopRequested });
}

ipcMain.handle('start-recording', async (_, url) => {
  try {
    workflow = [];
    recording = true;
    await startBrowser(url);
    send('recording-state', true);
    return true;
  } catch (e) {
    recording = false;
    send('recording-state', false);
    throw e;
  }
});
ipcMain.handle('stop-recording', async () => { recording = false; send('recording-state', false); return workflow; });
ipcMain.handle('run-workflow', async (_, repeats) => { try { await replay(repeats); return { ok: true }; } catch (e) { running = false; send('automation-error', e.message); return { ok: false, error: e.message }; } });
ipcMain.handle('stop-automation', async () => { stopRequested = true; send('run-status', { running: false, stopped: true }); return true; });
ipcMain.handle('stop-browser', async () => {
  recording = false;
  stopRequested = true;
  if (browser) {
    if (browserOwnedByAuto) await browser.close().catch(() => {});
    else browser.disconnect?.();
  }
  browser = page = null;
  browserOwnedByAuto = false;
  torLauncherProcess = null;
  send('browser-status', 'Auto disconnected from Tor Browser');
  return true;
});
ipcMain.handle('get-workflow', () => workflow);
ipcMain.handle('save-workflow', async (_, data) => { const result = await dialog.showSaveDialog(win, { defaultPath: 'workflow.json', filters: [{ name: 'Auto Workflow', extensions: ['json'] }] }); if (!result.canceled) require('fs').writeFileSync(result.filePath, JSON.stringify(data, null, 2)); return result; });

app.whenReady().then(createWindow);
app.on('window-all-closed', async () => {
  if (browser) {
    if (browserOwnedByAuto) await browser.close().catch(() => {});
    else browser.disconnect?.();
  }
  if (process.platform !== 'darwin') app.quit();
});
