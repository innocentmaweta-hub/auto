const $ = id => document.getElementById(id);
const stepsEl = $('steps'), logEl = $('log'), countEl = $('count'), statusEl = $('status');
let steps = [], continuous = false;
function label(s) { if(s.type==='navigate') return `Open ${s.url}`; if(s.type==='click') return `Click ${s.text || s.selector}`; if(s.type==='fill') return `Type into ${s.selector}`; if(s.type==='select') return `Select ${s.value} in ${s.selector}`; if(s.type==='scroll') return `Scroll to ${s.y}px`; return s.type; }
function render() { countEl.textContent=`${steps.length} step${steps.length===1?'':'s'}`; stepsEl.innerHTML=''; if(!steps.length){stepsEl.innerHTML='<div class="empty">No steps recorded yet. Click Record, then use the browser normally.</div>';return;} steps.forEach((s,i)=>{const row=document.createElement('div');row.className='step';row.innerHTML=`<span class="num">${i+1}</span><span class="type">${s.type}</span><span class="desc"></span>`;row.querySelector('.desc').textContent=label(s);stepsEl.appendChild(row);}); }
function log(message){const line=document.createElement('div');line.textContent=`${new Date().toLocaleTimeString()} — ${message}`;logEl.prepend(line);}
$('record').onclick=async()=>{steps=[];render();try{await window.auto.startRecording($('url').value.trim()||'https://example.com');statusEl.textContent='Recording';statusEl.className='status recording';log('Recording started. Use the browser window that opened.');}catch(e){log(`Could not start: ${e.message}`);}};
$('stop-recording').onclick=async()=>{await window.auto.stopRecording();statusEl.textContent='Ready';statusEl.className='status';log('Recording stopped.');};
$('continuous').onclick=()=>{continuous=!continuous;$('continuous').textContent=continuous?'Continuous: ON':'Until stopped';};
$('run').onclick=async()=>{if(!steps.length)return log('Nothing to run. Record a workflow first.');const repeats=continuous?'continuous':Math.max(1,Number($('repeats').value));log(repeats==='continuous'?'Running continuously. Use Stop run to stop it.':`Running ${repeats} time(s).`);await window.auto.runWorkflow(repeats);};
$('stop-run').onclick=async()=>{await window.auto.stopAutomation();statusEl.textContent='Stopping…';log('Stop requested.');};
$('save').onclick=async()=>{if(!steps.length)return log('Nothing to save.');const result=await window.auto.saveWorkflow({version:1,name:'Auto workflow',steps});if(!result.canceled)log(`Workflow saved to ${result.filePath}`);};
window.auto.on('recorded-step',s=>{steps.push(s);render();log(`${s.type}: ${label(s)}`);});
window.auto.on('recording-state',active=>{statusEl.textContent=active?'Recording':'Ready';statusEl.className=active?'status recording':'status';});
window.auto.on('browser-status',message=>log(message));
window.auto.on('automation-error',message=>{statusEl.textContent='Error';statusEl.className='status error';log(`Automation error: ${message}`);});
window.auto.on('run-status',data=>{if(data.running){statusEl.textContent=data.total==='continuous'?`Running #${data.iteration}`:`Running ${data.iteration}/${data.total}`;statusEl.className='status recording';}else{statusEl.textContent='Ready';statusEl.className='status';log(data.stopped?'Run stopped.':'Run finished.');}});
render();
