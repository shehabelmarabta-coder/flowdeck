'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const runtimeMessaging = require('../extension/runtime-message');

test('runtime messaging converts a synchronous invalidated-context throw into a result', async () => {
  let invalidations = 0;
  const runtime = {
    id: 'flowdeck-test',
    sendMessage() { throw new Error('Extension context invalidated.'); }
  };

  const result = await runtimeMessaging.send({ type: 'test' }, {
    runtime,
    onInvalidated: () => { invalidations += 1; }
  });

  assert.equal(result.ok, false);
  assert.equal(result.contextInvalidated, true);
  assert.equal(invalidations, 1);
});

test('runtime messaging consumes chrome.runtime.lastError from the callback', async () => {
  const runtime = {
    id: 'flowdeck-test',
    lastError: { message: 'Could not establish connection. Receiving end does not exist.' },
    sendMessage(_message, callback) { callback(); }
  };

  const result = await runtimeMessaging.send({ type: 'test' }, { runtime });

  assert.equal(result.ok, false);
  assert.equal(result.contextInvalidated, false);
  assert.match(result.error, /receiving end/i);
});

test('runtime messaging returns a valid service-worker response unchanged', async () => {
  const expected = { ok: true, status: 200, data: { ok: true } };
  const runtime = {
    id: 'flowdeck-test',
    lastError: null,
    sendMessage(_message, callback) { callback(expected); }
  };

  assert.equal(await runtimeMessaging.send({ type: 'test' }, { runtime }), expected);
});

test('friendly runtime errors identify an offline local server', () => {
  assert.equal(
    runtimeMessaging.friendlyError({ ok: false, status: 0, error: 'Failed to fetch' }),
    'Local FlowDeck server is offline. Run npm start, then retry.'
  );
});
