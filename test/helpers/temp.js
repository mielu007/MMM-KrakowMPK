"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const created = [];

/** A fresh temporary folder, removed by `cleanTempDirs()`. */
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "krakowmpk-test-"));
  created.push(dir);
  return dir;
}

function cleanTempDirs() {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { tempDir, cleanTempDirs };
