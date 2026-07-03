const { ipcRenderer } = require('electron');

const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const portRow = document.getElementById('portRow');
const ipLink = document.getElementById('ipLink');

const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnDashboard = document.getElementById('btnDashboard');
const toggleAutoStart = document.getElementById('toggleAutoStart');
const btnChangeDir = document.getElementById('btnChangeDir');
const dirPathText = document.getElementById('dirPath');
const btnKillAll = document.getElementById('btnKillAll');
const githubLink = document.getElementById('githubLink');

// Initialization
ipcRenderer.send('get-status');
ipcRenderer.send('get-dir');

// Status Updates from Main Process
ipcRenderer.on('server-status', (event, status) => {
  if (status.running) {
    statusIndicator.className = 'status-indicator running';
    statusText.textContent = 'Server Running';
    statusText.style.color = '#00d26a';
    
    portRow.style.visibility = 'visible';
    ipLink.textContent = `${status.ip}:${status.port}`;
    ipLink.href = `http://${status.ip}:${status.port}`;

    btnStart.disabled = true;
    btnStop.disabled = false;
    btnDashboard.disabled = false;
  } else {
    statusIndicator.className = 'status-indicator stopped';
    statusText.textContent = status.error ? `Error: ${status.error}` : 'Server Stopped';
    statusText.style.color = status.error ? '#ff3b30' : '#ff3b30';
    
    portRow.style.visibility = 'hidden';

    btnStart.disabled = false;
    btnStop.disabled = true;
    btnDashboard.disabled = true;
  }
});

ipcRenderer.on('dir-updated', (event, dir) => {
  dirPathText.textContent = dir;
  dirPathText.title = dir;
});

ipcRenderer.on('login-item-settings', (event, isEnabled) => {
  toggleAutoStart.checked = isEnabled;
});

// Button Actions
btnStart.addEventListener('click', () => {
  btnStart.disabled = true;
  statusText.textContent = 'Starting...';
  statusIndicator.className = 'status-indicator';
  ipcRenderer.send('start-server');
});

btnStop.addEventListener('click', () => {
  btnStop.disabled = true;
  statusText.textContent = 'Stopping...';
  statusIndicator.className = 'status-indicator';
  ipcRenderer.send('stop-server');
});

btnDashboard.addEventListener('click', () => {
  ipcRenderer.send('open-dashboard');
});

ipLink.addEventListener('click', (e) => {
  e.preventDefault();
  ipcRenderer.send('open-link', ipLink.href);
});

toggleAutoStart.addEventListener('change', (e) => {
  ipcRenderer.send('toggle-auto-launch', e.target.checked);
});

btnChangeDir.addEventListener('click', () => {
  ipcRenderer.send('change-dir');
});

githubLink.addEventListener('click', (e) => {
  e.preventDefault();
  ipcRenderer.send('open-link', 'https://github.com/asepsayyad007');
});

btnKillAll.addEventListener('click', () => {
  if (confirm("Are you sure you want to completely force close AiroDrop and all its background processes?")) {
    ipcRenderer.send('force-kill-all');
  }
});
