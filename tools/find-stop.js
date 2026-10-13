#!/usr/bin/env node
"use strict";

/**
 * Looks a stop up in the ZTP timetables and prints its stop_id and stop_code,
 * which is what the "stops" option of the module needs.
 *
 *   npm run find-stop -- Beskidzka
 *   node tools/find-stop.js Beskidzka --feeds A,M
 */

const path = require("node:path");

const { ALL_GROUPS, ensureFeed, readStops, normalizeName } = require("../lib/gtfs-static");

function parseArguments(argv) {
  const options = { query: "", feeds: ALL_GROUPS, baseUrl: "https://gtfs.ztp.krakow.pl/", cacheDir: path.join(__dirname, "..", ".cache") };
  const words = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--feeds") {
      options.feeds = String(argv[++i] || "").split(",").map((group) => group.trim().toUpperCase()).filter(Boolean);
    } else if (argv[i] === "--base-url") {
      options.baseUrl = argv[++i];
    } else if (argv[i] === "--cache-dir") {
      options.cacheDir = argv[++i];
    } else {
      words.push(argv[i]);
    }
  }
  options.query = words.join(" ").trim();
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.query === "") {
    console.error('Usage: npm run find-stop -- "part of the stop name" [--feeds A,M,T]');
    process.exitCode = 1;
    return;
  }

  const query = normalizeName(options.query);
  const rows = [];

  for (const group of options.feeds) {
    process.stderr.write(`Timetable ${group}… `);
    try {
      const feed = await ensureFeed({ baseUrl: options.baseUrl, group, cacheDir: options.cacheDir, checkIntervalMs: 6 * 60 * 60 * 1000 });
      for (const stop of await readStops(feed.file)) {
        if (normalizeName(stop.name).includes(query)) {
          rows.push({ feed: group, id: stop.id, code: stop.code, name: stop.name });
        }
      }
      process.stderr.write("ok\n");
    } catch (error) {
      process.stderr.write(`failed: ${error.message}\n`);
    }
  }

  if (rows.length === 0) {
    console.log(`No stop matches "${options.query}".`);
    return;
  }

  rows.sort((a, b) => a.name.localeCompare(b.name, "pl") || a.id.localeCompare(b.id));
  console.log(["feed", "stop_id", "stop_code", "name"].join("\t"));
  for (const row of rows) {
    console.log([row.feed, row.id, row.code, row.name].join("\t"));
  }
  console.log('\nUse the stop_id (or stop_code) as: stops: [{ id: "<stop_id>", name: "<name>" }]');
}

main();
