'use strict';

const API_BASE = 'http://127.0.0.1:17333';
const status = document.getElementById('status');

document.getElementById('health').addEventListener('click', async () => {
  status.textContent = 'Checking local paper engine...';
  try {
    const response = await fetch(`${API_BASE}/api/health`, { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Local server HTTP ${response.status}`);
    status.textContent = `${payload.strategy || 'FLOWDECK_FINAL_V1'}\nMode: ${payload.mode}\nAUTO: ${payload.autoRun ? 'running' : 'paused - no new trades'}\nWallets: ${payload.candidateWalletCount}`;
  } catch (error) {
    status.textContent = `Offline: ${error.message}`;
  }
});
