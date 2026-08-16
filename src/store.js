'use strict';

const fs = require('node:fs');
const path = require('node:path');

class JsonStore {
  constructor(directory, { stateFilename = 'state.json', eventsFilename = 'events.jsonl', cursorsFilename = 'wallet-cursors.json' } = {}) {
    this.directory = directory;
    this.statePath = path.join(directory, stateFilename);
    this.eventsPath = eventsFilename ? path.join(directory, eventsFilename) : null;
    this.cursorsPath = path.join(directory, cursorsFilename);
    fs.mkdirSync(directory, { recursive: true });
  }

  loadState() {
    if (!fs.existsSync(this.statePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch (error) {
      const backup = `${this.statePath}.invalid-${Date.now()}`;
      fs.copyFileSync(this.statePath, backup);
      return null;
    }
  }

  saveState(state) {
    const temporary = `${this.statePath}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, 'utf8');
    fs.renameSync(temporary, this.statePath);
  }

  appendEvent(event) {
    if (!this.eventsPath) return;
    fs.appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  loadWalletCursors() {
    if (!fs.existsSync(this.cursorsPath)) return {};
    try { return JSON.parse(fs.readFileSync(this.cursorsPath, 'utf8')); } catch { return {}; }
  }

  saveWalletCursors(cursors) {
    const temporary = `${this.cursorsPath}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(cursors, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, this.cursorsPath);
  }
}

module.exports = { JsonStore };
