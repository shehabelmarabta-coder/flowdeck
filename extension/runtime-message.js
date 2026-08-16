(function installFlowDeckRuntime(root, factory) {
  'use strict';

  const runtimeApi = factory();
  root.FlowDeckRuntime = runtimeApi;
  if (typeof module === 'object' && module.exports) module.exports = runtimeApi;
})(typeof globalThis === 'object' ? globalThis : this, function createFlowDeckRuntime() {
  'use strict';

  const CONTEXT_INVALIDATED = /extension context invalidated/i;

  function errorMessage(error) {
    return typeof error === 'string' ? error : String(error?.message || error || 'Unknown extension error');
  }

  function hasContext(runtime) {
    try {
      return Boolean(runtime?.id && typeof runtime.sendMessage === 'function');
    } catch {
      return false;
    }
  }

  function isContextInvalidated(error, runtime) {
    return CONTEXT_INVALIDATED.test(errorMessage(error)) || !hasContext(runtime);
  }

  function resultForError(error, runtime) {
    const message = errorMessage(error);
    return {
      ok: false,
      status: 0,
      error: message,
      contextInvalidated: isContextInvalidated(message, runtime)
    };
  }

  function send(message, options = {}) {
    const runtime = options.runtime === undefined ? globalThis.chrome?.runtime : options.runtime;
    const onInvalidated = typeof options.onInvalidated === 'function' ? options.onInvalidated : () => {};

    if (!hasContext(runtime)) {
      const result = resultForError('Extension context invalidated.', runtime);
      try { onInvalidated(result); } catch { /* UI teardown must not break the response contract. */ }
      return Promise.resolve(result);
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (result.contextInvalidated) {
          try { onInvalidated(result); } catch { /* UI teardown must not break the response contract. */ }
        }
        resolve(result);
      };

      try {
        runtime.sendMessage(message, (response) => {
          let runtimeError = '';
          try {
            runtimeError = runtime.lastError?.message || '';
          } catch (error) {
            runtimeError = errorMessage(error);
          }
          if (runtimeError) finish(resultForError(runtimeError, runtime));
          else finish(response || { ok: false, status: 0, error: 'No response from the extension service worker.' });
        });
      } catch (error) {
        finish(resultForError(error, runtime));
      }
    });
  }

  function friendlyError(response, fallback = 'Command failed') {
    const serverReason = response?.data?.reason || response?.data?.error;
    if (serverReason) return String(serverReason);
    if (response?.contextInvalidated || CONTEXT_INVALIDATED.test(String(response?.error || ''))) {
      return 'Extension updated. Refresh this GMGN tab to reconnect.';
    }
    const transport = String(response?.error || '');
    if (/failed to fetch|networkerror|load failed/i.test(transport)) {
      return 'Local FlowDeck server is offline. Run npm start, then retry.';
    }
    if (/abort|timed?\s*out/i.test(transport)) {
      return 'Local FlowDeck server timed out. Check its terminal, then retry.';
    }
    if (/receiving end does not exist|message port closed|service worker/i.test(transport)) {
      return 'FlowDeck service worker is unavailable. Reload the extension and refresh this tab.';
    }
    return transport || fallback;
  }

  return { send, hasContext, isContextInvalidated, friendlyError };
});
