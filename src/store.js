// Tiny JSON persistence for settings, bookmarks, history and session state.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

function fileFor(name) {
  return path.join(app.getPath('userData'), name + '.json');
}

function load(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function save(name, data) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(fileFor(name), JSON.stringify(data));
  } catch (err) {
    console.warn('store: could not save', name, err.message);
  }
}

const timers = new Map();
function saveDebounced(name, data, ms = 800) {
  clearTimeout(timers.get(name));
  timers.set(name, setTimeout(() => save(name, data), ms));
}

module.exports = { load, save, saveDebounced };
