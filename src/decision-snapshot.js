'use strict';

const { createHash } = require('node:crypto');

function canonical(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function stableJson(value) { return JSON.stringify(canonical(value)); }
function sha256(value) { return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex'); }

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function immutableSnapshot(input) {
  const cloned = JSON.parse(stableJson(input));
  const snapshotId = input.snapshot_id || `snapshot_${sha256(cloned).slice(0, 24)}`;
  const withId = { ...cloned, snapshot_id: snapshotId };
  return deepFreeze(withId);
}

function configHash(config) {
  const safe = {
    paper: config.paper,
    bot: { exit: config.bot?.exit, paperAggressive: config.bot?.paperAggressive, brain: config.bot?.brain },
    jupiter: config.jupiter,
    rpc: { commitment: config.rpc?.commitment, processedCommitment: config.rpc?.processedCommitment }
  };
  return sha256(safe);
}

module.exports = { canonical, configHash, deepFreeze, immutableSnapshot, sha256, stableJson };
