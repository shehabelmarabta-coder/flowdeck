'use strict';

const API_BASE = 'http://127.0.0.1:17333';

function isGmgnUrl(url = '') {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && (parsed.hostname === 'gmgn.ai' || parsed.hostname.endsWith('.gmgn.ai'));
  } catch {
    return false;
  }
}

async function injectFlowDeck(tab) {
  if (!tab?.id || !isGmgnUrl(tab.url)) {
    if (tab?.id) await chrome.action.setBadgeText({ tabId: tab.id, text: 'GMGN' });
    return { ok: false, reason: 'Open a GMGN page first.' };
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      files: ['shared.js', 'page-bridge.js']
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      files: ['shared.js', 'runtime-message.js', 'content.js']
    });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#0E725F' });
    await chrome.action.setBadgeText({ tabId: tab.id, text: 'ON' });
    setTimeout(() => void chrome.action.setBadgeText({ tabId: tab.id, text: '' }), 1800);
    return { ok: true };
  } catch (error) {
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#A92345' });
    await chrome.action.setBadgeText({ tabId: tab.id, text: 'ERR' });
    console.error('[FlowDeck] injection failed:', error);
    return { ok: false, reason: error.message };
  }
}

chrome.action.onClicked.addListener((tab) => {
  void injectFlowDeck(tab);
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.action.setBadgeBackgroundColor({ color: '#0E725F' });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'flowdeck-open-options') {
    void chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'flowdeck-force-inject') {
    void chrome.tabs.query({ active: true, currentWindow: true })
      .then(([tab]) => injectFlowDeck(tab))
      .then(sendResponse);
    return true;
  }
  if (message?.type !== 'flowdeck-api') return false;
  const path = String(message.path || '');
  const method = String(message.method || 'GET').toUpperCase();
  if (!path.startsWith('/api/') || !['GET', 'POST'].includes(method)) {
    sendResponse({ ok: false, status: 400, error: 'Invalid local API request' });
    return false;
  }

  const controller = new AbortController();
  const isReset = method === 'POST' && path === '/api/command' && message.body?.action === 'reset';
  const timeoutMs = isReset ? 120_000 : method === 'POST' && path === '/api/command' ? 10_000 : 5_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  fetch(`${API_BASE}${path}`, {
    method,
    headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
    body: method === 'POST' ? JSON.stringify(message.body || {}) : undefined,
    cache: 'no-store',
    signal: controller.signal
  })
    .then(async (response) => {
      const data = message.responseType === 'text' ? await response.text() : await response.json();
      sendResponse({ ok: response.ok, status: response.status, data });
    })
    .catch((error) => sendResponse({ ok: false, status: 0, error: error.message }))
    .finally(() => clearTimeout(timeout));
  return true;
});
