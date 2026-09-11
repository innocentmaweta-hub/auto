const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { chromium } = require('playwright');

let win;
let browser;
let context;
let page;
let recording = false;
let workflow = [];

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function selectorFor(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
  const aria = el.getAttribute('aria-label');
  if (aria) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria)}"]`;
  const test = el.getAttribute('data-testid');
  if (test) return `[data-testid="${CSS.escape(test)}"]`;
  return null;
}

async function injectRecorder() {
  if (!page) return;
  await page.exposeFunction('autoRecordEvent', event => {
    if (!recording) return;
    workflow.push(event);
    send('recorded-step', event);
  });

  await page.addInitScript(() => {
    const getSelector = el => {
      if (!el || !(el instanceof Element)) return null;
      if (el.id) return `#${CSS.escape(el.id)}`;
      if (el.name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
      const aria = el.getAttribute('aria-label');
      if (aria) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria)}"]`;
      const test = el.getAttribute('data-testid');
      if (test) return `[data-testid="${CSS.escape(test)}"]`;
      return null;
    };
    const emit = event => window.autoRecordEvent?.({ ...event, url: location.href, at: Date.now() });
    document.addEventListener('click', e => {
      const el = e.target?.closest?.('button,a,input,textarea,select,[role="button"]');
      const selector = getSelector(el);
      if (selector) emit({ type: 'click', selector, text: (el.innerText || el.value || '').trim().slice(0, 120) });
    }, true);
    const input = e => {
      const el = e.target;
      const selector = getSelector(el);
      if (!selector || !['INPUT','TEXTAREA'].includes(el.tagName)) return;
      if (el.type === 'password') return;
      emit({ type: 'fill', selector, value: el.value });
    };
    document.addEventListener('change', input, true);
    document.addEventListener('blur', input, true);
    document.addEventListener('change', e => {
      const el = e.target;
      const selector = getSelector(el);
      if (selector && el.tagName === 'SELECT') emit({ type: 'select', selector, value: el.value });
    }, true);
    let scrollTimer;
    document.addEventListener('scroll', () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => emit({ type: 'scroll', x: window.scrollX, y: window.scrollY }), 250);
    }, { passive: true });
  });
}

async function startBrowser(url) {
  if (browser) await browser.close().catch(() => {});
  browser = await chromium.launch({ headless: false });
  context = await browser.newContext();
  page = await context.newPage();
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame() && recording) {
      const event = { type: 'navigate', url: frame.url(), at: Date.now() };
      workflow.push(event);
      send('recorded-step', event);
    }
  });
  await injectRecorder();
  await page.goto(url || 'https://example.com', { waitUntil: 'domcontentloaded' });
  send('browser-status', 'Browser ready');
}

async function runStep(step) {
  if (!page) throw new Error('Browser is not running');
  if (step.type === 'navigate') return page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (step.type === 'click') return page.locator(step.selector).first().click({ timeout: 15000 });
  if (step.type === 'fill') return page.locator(step.selector).first().fill(step.value ?? '', { timeout: 15000 });
  if (step.type === 'select') return page.locator(step.selector).first().selectOption(step.value, { timeout: 15000 });
  if (step.type === 'scroll') return page.evaluate(({x,y}) => window.scrollTo(x,y), { x: step.x || 0, y: step.y || 0 });
  if (step.type === 'wait') return new Promise(r => setTimeout(r, step.ms || 1000));
}

async function replay(repeats) {
  if (!workflow.length) throw new Error('Record at least one step first');
  if (!page) await startBrowser(workflow.find(s => s.type === 'navigate')?.url);
  const count = repeats === 'continuous' ? Number.MAX_SAFE_INTEGER : Math.max(1, Number(repeats) || 1);
  send('run-status', { running: true, iteration: 0, total: repeats });
  for (let i = 1; i <= count; i++) {
    for (const step of workflow) {
      if (step.type === 'navigate' && i === 1 && step.url === page.url()) continue;
      await runStep(step);
      await new Promise(r => setTimeout(r, 150));
    }
    send('run-status', { running: true, iteration: i, total: repeats });
    if (i === count) break;
  }
  send('run-status', { running: false, iteration: repeats === 'continuous' ? 0 : Number(repeats) || 1, total: repeats });
}

ipcMain.handle('start-recording', async (_, url) => {
  workflow = [];
  recording = true;
  await startBrowser(url);
  send('recording-state', true);
  return true;
});

ipcMain.handle('stop-recording', async () => {
  recording = false;
  send('recording-state', false);
  return workflow;
});

ipcMain.handle('run-workflow', async (_, repeats) => {
  try { await replay(repeats); return { ok: true }; }
  catch (e) { send('automation-error', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('stop-browser', async () => {
  recording = false;
  if (browser) await browser.close().catch(() => {});
  browser = context = page = null;
  send('browser-status', 'Browser stopped');
});

ipcMain.handle('get-workflow', () => workflow);
ipcMain.handle('save-workflow', async (_, data) => {
  const result = await dialog.showSaveDialog(win, { defaultPath: 'workflow.json', filters: [{ name: 'Auto Workflow', extensions: ['json'] }] });
  if (!result.canceled) require('fs').writeFileSync(result.filePath, JSON.stringify(data, null, 2));
  return result;
});

app.whenReady().then(createWindow);
app.on('window-all-closed', async () => {
  if (browser) await browser.close().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});
