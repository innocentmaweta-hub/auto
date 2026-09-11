const $ = id => document.getElementById(id);
const stepsEl = $('steps');
const logEl = $('log');
const countEl = $('count');
const statusEl = $('status');
let steps = [];
let continuous = false;

function label(step) {
  if (step.type === 'navigate') return `Open ${step.url}`;
  if (step.type === 'click') return `Click ${step.text || step.selector}`;
  if (step.type === 'fill') return `Type into ${step.selector}`;
  if (step.type === 'select') return `Select ${step.value} in ${step.selector}`;
  if (step.type === 'scroll') return `Scroll to ${step.y}px`;
  if (step.type === 'wait') return `Wait ${step.ms}ms`;
  return step.type;
}

function render() {
  countEl.textContent = `${steps.length} step${steps.length === 1 ? '' : 's'}`;
  stepsEl.innerHTML = '';
  if (!steps.length) {
    stepsEl.innerHTML = '<div class="empty">No steps recorded yet. Click Record, then use the browser normally.</div>';
    return;
  }
  steps.forEach((step, i) => {
    const row = document.createElement('div');
    row.className = 'step';
    row.innerHTML = `<span class="num">${i + 1}</span><span class="type">${step.type}</span><span class="desc"></span>`;
    row.querySelector('.desc').textContent = label(step);
    stepsEl.appendChild(row);
  });
}

function log(message) {
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()} — ${message}`;
  logEl.prepend(line);
}

$('record').onclick = async () => {
  steps = [];
  render();
  const url = $('url').value.trim() || 'https://example.com';
  try {
    await window.auto.startRecording(url);
    statusEl.textContent = 'Recording';
    statusEl.className = 'status recording';
    log('Recording started. Use the browser window that opened.');
  } catch (e) { log(`Could not start: ${e.message}`); }
};

$('stop').onclick = async () => {
  await window.auto.stopRecording();
  statusEl.textContent = 'Ready';
  statusEl.className = 'status';
  log('Recording stopped.');
};

$('continuous').onclick = () => {
  continuous = !continuous;
  $('continuous').textContent = continuous ? 'Continuous: ON' : 'Until stopped';
};

$('run').onclick = async () => {
  if (!steps.length) return log('Nothing to run. Record a workflow first.');
  const repeats = continuous ? 'continuous' : Math.max(1, Number($('repeats').value));
  log(repeats === 'continuous' ? 'Running continuously. Press Stop to close the browser.' : `Running ${repeats} time(s).`);
  await window.auto.runWorkflow(repeats);
};

$('save').onclick = async () => {
  if (!steps.length) return log('Nothing to save.');
  const result = await window.auto.saveWorkflow({ version: 1, name: 'Auto workflow', steps });
  if (!result.canceled) log(`Workflow saved to ${result.filePath}`);
};

window.auto.on('recorded-step', step => {
  steps.push(step);
  render();
  log(`${step.type}: ${label(step)}`);
});
window.auto.on('recording-state', active => {
  statusEl.textContent = active ? 'Recording' : 'Ready';
  statusEl.className = active ? 'status recording' : 'status';
});
window.auto.on('browser-status', message => log(message));
window.auto.on('automation-error', message => {
  statusEl.textContent = 'Error';
  statusEl.className = 'status error';
  log(`Automation error: ${message}`);
});
window.auto.on('run-status', data => {
  if (data.running) statusEl.textContent = data.total === 'continuous' ? `Running #${data.iteration}` : `Running ${data.iteration}/${data.total}`;
  else { statusEl.textContent = 'Ready'; statusEl.className = 'status'; log('Run finished.'); }
});

render();
