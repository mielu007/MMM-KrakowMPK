"use strict";

/**
 * Static GTFS published by ZTP Kraków.
 *
 * - The archives are downloaded once and kept in a cache folder. Later checks
 *   are conditional requests (ETag / Last-Modified), so an unchanged archive is not downloaded again.
 * - Only the data of the chosen stop is read from the big files, streaming.
 * - That small result is saved next to the archive, so a restart does not parse the archive again.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const { readCsv } = require("./csv");
const { GtfsError } = require("./errors");
const { ZipArchive } = require("./zip");
const { parseGtfsTime } = require("./time");

// A server that does not answer at all must not hold things up for long ...
const RESPONSE_TIMEOUT_MS = 30_000;
// ... while a big archive on a slow connection may take a while.
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const RETRY_AFTER_FAILED_CHECK_MS = 10 * 60_000;

/** Feed groups published by ZTP: A = MPK buses, M = Mobilis buses, T = trams. */
const FEEDS = { tram: ["T"], bus: ["A", "M"] };
const ALL_GROUPS = ["A", "M", "T"];

const feedFileName = (group) => `GTFS_KRK_${group}.zip`;

// ---------------------------------------------------------------------------
// Download cache
// ---------------------------------------------------------------------------

const jobs = new Map(); // file -> running check/download (shared by all instances)
const nextTry = new Map(); // file -> earliest time of the next attempt after a failure

const metaPath = (file) => file.replace(/\.zip$/, ".meta.json");

async function readJson(file) {
  try {
    return JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(file, value) {
  const partial = `${file}.${process.pid}.part`;
  await fs.promises.writeFile(partial, JSON.stringify(value));
  await fs.promises.rename(partial, file);
}

async function hashFile(file) {
  const hash = crypto.createHash("sha1");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

/** Changes whenever the archive changes. */
function fingerprintOf(meta) {
  return meta.etag || meta.lastModified ? `${meta.etag}|${meta.lastModified}|${meta.size}` : `sha1:${meta.sha1}`;
}

async function downloadArchive(response, file, url) {
  const partial = `${file}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
    await ZipArchive.open(partial); // never replace a good file with a broken one
    await fs.promises.rename(partial, file);
  } catch (error) {
    await fs.promises.rm(partial, { force: true });
    throw new GtfsError("BAD_RESPONSE", `Downloaded file ${url} is not usable: ${error.message}`, { cause: error });
  }
}

async function checkOrDownload({ url, file, meta, exists, fetchImpl, timeoutMs, responseTimeoutMs, now }) {
  const controller = new AbortController();
  const overall = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await checkOrDownloadWithin({ url, file, meta, exists, fetchImpl, now, controller, responseTimeoutMs });
  } finally {
    clearTimeout(overall);
  }
}

async function checkOrDownloadWithin({ url, file, meta, exists, fetchImpl, now, controller, responseTimeoutMs }) {
  const headers = {};
  if (exists && meta && meta.etag) {
    headers["If-None-Match"] = meta.etag;
  }
  if (exists && meta && meta.lastModified) {
    headers["If-Modified-Since"] = meta.lastModified;
  }

  let response;
  const responseTimer = setTimeout(() => controller.abort(), responseTimeoutMs);
  try {
    response = await fetchImpl(url, { headers, signal: controller.signal });
  } catch (error) {
    throw new GtfsError("CONNECTION", `Download of ${url} failed: ${error.message}`, { cause: error });
  } finally {
    clearTimeout(responseTimer);
  }

  if (response.status === 304 && exists && meta) {
    const checked = { ...meta, checkedAt: now };
    await writeJson(metaPath(file), checked);
    return { meta: checked, changed: false };
  }
  if (!response.ok || !response.body) {
    throw new GtfsError("CONNECTION", `Download of ${url} returned HTTP ${response.status}`);
  }

  const etag = response.headers.get("etag") || "";
  const lastModified = response.headers.get("last-modified") || "";
  const length = Number(response.headers.get("content-length")) || 0;

  // A server that ignores conditional requests still tells us the file is the same one.
  const same =
    exists &&
    meta &&
    (etag ? etag === meta.etag : lastModified && lastModified === meta.lastModified && length > 0 && length === meta.size);
  if (same) {
    await response.body.cancel().catch(() => {});
    const checked = { ...meta, checkedAt: now };
    await writeJson(metaPath(file), checked);
    return { meta: checked, changed: false };
  }

  await downloadArchive(response, file, url);
  const fresh = {
    etag,
    lastModified,
    size: (await fs.promises.stat(file)).size,
    sha1: etag || lastModified ? "" : await hashFile(file),
    downloadedAt: now,
    checkedAt: now
  };
  await writeJson(metaPath(file), fresh);
  return { meta: fresh, changed: true };
}

/**
 * Makes sure a usable copy of a feed is in the cache folder and checks for a
 * newer one at most every `checkIntervalMs`. When a check fails, the copy that
 * is already there is used.
 *
 * @returns {Promise<{file: string, fingerprint: string, changed: boolean, warning?: string}>}
 */
async function ensureFeed({
  baseUrl,
  group,
  cacheDir,
  checkIntervalMs,
  fetchImpl = globalThis.fetch,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
  responseTimeoutMs = RESPONSE_TIMEOUT_MS,
  now = Date.now()
}) {
  const file = path.join(cacheDir, feedFileName(group));

  let size = null;
  try {
    size = (await fs.promises.stat(file)).size;
  } catch {
    // not downloaded yet
  }
  const exists = size !== null;
  const meta = exists ? (await readJson(metaPath(file))) || { etag: "", lastModified: "", size, sha1: await hashFile(file), checkedAt: 0 } : null;

  if (exists && (now - meta.checkedAt < checkIntervalMs || (nextTry.get(file) || 0) > now)) {
    return { file, fingerprint: fingerprintOf(meta), changed: false };
  }

  if (!jobs.has(file)) {
    const url = `${String(baseUrl).replace(/\/+$/, "")}/${feedFileName(group)}`;
    const job = fs.promises
      .mkdir(cacheDir, { recursive: true })
      .then(() => checkOrDownload({ url, file, meta, exists, fetchImpl, timeoutMs, responseTimeoutMs, now }))
      .finally(() => jobs.delete(file));
    jobs.set(file, job);
  }

  try {
    const result = await jobs.get(file);
    nextTry.delete(file);
    return { file, fingerprint: fingerprintOf(result.meta), changed: result.changed };
  } catch (error) {
    if (exists) {
      nextTry.set(file, now + RETRY_AFTER_FAILED_CHECK_MS);
      return { file, fingerprint: fingerprintOf(meta), changed: false, warning: `Using the cached ${feedFileName(group)}: ${error.message}` };
    }
    throw error instanceof GtfsError ? error : new GtfsError("CONNECTION", error.message, { cause: error });
  }
}

// ---------------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------------

function normalizeName(name) {
  return name.normalize("NFC").toLocaleLowerCase("pl").replace(/\s+/g, " ").trim();
}

const stopListCache = new Map();

/** All stops of a feed: `{ id, code, name, parent }`. */
async function readStops(file) {
  const mtime = (await fs.promises.stat(file)).mtimeMs;
  const cached = stopListCache.get(file);
  if (cached && cached.mtime === mtime) {
    return cached.stops;
  }

  const archive = await ZipArchive.open(file);
  const stops = [];
  await readCsv(await archive.read("stops.txt"), { name: "stops.txt", required: ["stop_id", "stop_name"] }, (row, c) => {
    stops.push({
      id: row[c.stop_id],
      code: c.stop_code === undefined ? "" : (row[c.stop_code] || "").trim(),
      name: (row[c.stop_name] || "").trim(),
      parent: c.parent_station === undefined ? "" : row[c.parent_station] || ""
    });
  });

  stopListCache.set(file, { mtime, stops });
  return stops;
}

/**
 * Chooses the stop_ids to show. `stopIds` are matched against stop_id and stop_code,
 * `stopName` (used when there are no ids) against the name: every stop with that
 * name counts, plus the platforms of a station.
 *
 * @returns {{status: "ok", stopIds: Set<string>, name: string} | {status: "not_found"} | {status: "ambiguous", names: string[]}}
 */
function matchStops(stops, { stopName = "", stopIds = [] } = {}) {
  let chosen;
  let name = "";

  if (stopIds.length > 0) {
    const wanted = new Set(stopIds.map(String));
    chosen = stops.filter((stop) => wanted.has(stop.id) || (stop.code !== "" && wanted.has(stop.code)));
    name = chosen[0] ? chosen[0].name : "";
  } else {
    const query = normalizeName(stopName);
    const exact = stops.filter((stop) => normalizeName(stop.name) === query);

    if (exact.length > 0) {
      chosen = exact;
      name = exact[0].name;
    } else {
      const partial = query === "" ? [] : stops.filter((stop) => normalizeName(stop.name).includes(query));
      const names = [...new Set(partial.map((stop) => stop.name))].sort((a, b) => a.localeCompare(b, "pl"));
      if (names.length === 0) {
        return { status: "not_found" };
      }
      if (names.length > 1) {
        return { status: "ambiguous", names };
      }
      chosen = partial;
      name = names[0];
    }
  }

  if (chosen.length === 0) {
    return { status: "not_found" };
  }

  const ids = new Set(chosen.map((stop) => stop.id));
  for (const stop of stops) {
    if (stop.parent && ids.has(stop.parent)) {
      ids.add(stop.id); // a platform of a chosen station
    }
  }
  return { status: "ok", stopIds: ids, name };
}

// ---------------------------------------------------------------------------
// Schedule of one stop
// ---------------------------------------------------------------------------

/**
 * Reads the timetable of the given stops from a feed, streaming the big files.
 *
 * Assumes, as GTFS publishers do, that the rows of one trip in stop_times.txt
 * are next to each other and sorted by stop_sequence; this is how the last
 * stop of a trip is recognised.
 */
async function buildSchedule(file, stopIdSet) {
  const archive = await ZipArchive.open(file);

  const stopTimes = [];
  const tripIds = new Set();
  const lastSequence = new Map();

  await readCsv(
    await archive.read("stop_times.txt"),
    { name: "stop_times.txt", required: ["trip_id", "stop_id", "stop_sequence"] },
    (row, c) => {
      const tripId = row[c.trip_id];
      const sequence = Number(row[c.stop_sequence]);

      if (stopIdSet.has(row[c.stop_id])) {
        const departure = parseGtfsTime(c.departure_time === undefined ? "" : row[c.departure_time]);
        const arrival = parseGtfsTime(c.arrival_time === undefined ? "" : row[c.arrival_time]);
        const seconds = departure ?? arrival;
        tripIds.add(tripId);
        if (seconds !== null) {
          stopTimes.push({ tripId, stopId: row[c.stop_id], sequence, seconds });
        }
      }
      if (tripIds.has(tripId) && !(lastSequence.get(tripId) >= sequence)) {
        lastSequence.set(tripId, sequence);
      }
    }
  );

  const trips = new Map();
  await readCsv(await archive.read("trips.txt"), { name: "trips.txt", required: ["route_id", "service_id", "trip_id"] }, (row, c) => {
    if (tripIds.has(row[c.trip_id])) {
      trips.set(row[c.trip_id], {
        routeId: row[c.route_id],
        serviceId: row[c.service_id],
        headsign: c.trip_headsign === undefined ? "" : (row[c.trip_headsign] || "").trim()
      });
    }
  });

  const routeIds = new Set([...trips.values()].map((trip) => trip.routeId));
  const routes = new Map();
  await readCsv(await archive.read("routes.txt"), { name: "routes.txt", required: ["route_id"] }, (row, c) => {
    if (routeIds.has(row[c.route_id])) {
      routes.set(row[c.route_id], {
        shortName: c.route_short_name === undefined ? "" : (row[c.route_short_name] || "").trim(),
        longName: c.route_long_name === undefined ? "" : (row[c.route_long_name] || "").replace(/\s+/g, " ").trim()
      });
    }
  });

  const serviceIds = new Set([...trips.values()].map((trip) => trip.serviceId));
  const calendar = new Map();
  if (archive.has("calendar.txt")) {
    await readCsv(
      await archive.read("calendar.txt"),
      { name: "calendar.txt", required: ["service_id", "start_date", "end_date"] },
      (row, c) => {
        if (serviceIds.has(row[c.service_id])) {
          calendar.set(row[c.service_id], {
            // index = Date#getUTCDay (0 = Sunday)
            days: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].map((day) => row[c[day]] === "1"),
            start: row[c.start_date],
            end: row[c.end_date]
          });
        }
      }
    );
  }

  const exceptions = new Map();
  if (archive.has("calendar_dates.txt")) {
    await readCsv(
      await archive.read("calendar_dates.txt"),
      { name: "calendar_dates.txt", required: ["service_id", "date", "exception_type"] },
      (row, c) => {
        if (serviceIds.has(row[c.service_id])) {
          if (!exceptions.has(row[c.service_id])) {
            exceptions.set(row[c.service_id], new Map());
          }
          exceptions.get(row[c.service_id]).set(row[c.date], row[c.exception_type]);
        }
      }
    );
  }

  return {
    stopTimes: stopTimes.map((stopTime) => ({ ...stopTime, isLast: stopTime.sequence >= lastSequence.get(stopTime.tripId) })),
    trips,
    routes,
    calendar,
    exceptions
  };
}

/** Does a service run on a day? `date` is "YYYYMMDD", `day` is 0-6 (Sunday = 0). */
function isServiceActive(schedule, serviceId, date, day) {
  const exception = schedule.exceptions.get(serviceId)?.get(date);
  if (exception === "1") {
    return true;
  }
  if (exception === "2") {
    return false;
  }
  const entry = schedule.calendar.get(serviceId);
  return Boolean(entry && date >= entry.start && date <= entry.end && entry.days[day]);
}

// ---------------------------------------------------------------------------
// Saved result for one stop
// ---------------------------------------------------------------------------

function serializeSchedule(schedule) {
  return {
    stopTimes: schedule.stopTimes,
    trips: [...schedule.trips],
    routes: [...schedule.routes],
    calendar: [...schedule.calendar],
    exceptions: [...schedule.exceptions].map(([serviceId, dates]) => [serviceId, [...dates]])
  };
}

function deserializeSchedule(data) {
  return {
    stopTimes: data.stopTimes,
    trips: new Map(data.trips),
    routes: new Map(data.routes),
    calendar: new Map(data.calendar),
    exceptions: new Map(data.exceptions.map(([serviceId, dates]) => [serviceId, new Map(dates)]))
  };
}

const serializeMatch = (match) => (match.stopIds ? { ...match, stopIds: [...match.stopIds] } : match);
const deserializeMatch = (match) => (match.stopIds ? { ...match, stopIds: new Set(match.stopIds) } : match);

/** Identifies which stop was asked for, so a changed config does not reuse a wrong result. */
function stopKey({ stopName = "", stopIds = [] }) {
  const text = JSON.stringify([normalizeName(stopName), stopIds.map(String).sort()]);
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
}

const indexPath = (cacheDir, group, key) => path.join(cacheDir, `stop-${group}-${key}.json`);

/** @returns {Promise<{match: object, schedule?: object} | null>} null when there is no saved result for this archive version */
async function loadStopIndex(cacheDir, group, key, fingerprint) {
  const saved = await readJson(indexPath(cacheDir, group, key));
  if (!saved || saved.fingerprint !== fingerprint || !saved.match) {
    return null;
  }
  return { match: deserializeMatch(saved.match), schedule: saved.schedule ? deserializeSchedule(saved.schedule) : undefined };
}

async function saveStopIndex(cacheDir, group, key, fingerprint, { match, schedule }) {
  await fs.promises.mkdir(cacheDir, { recursive: true });
  await writeJson(indexPath(cacheDir, group, key), {
    fingerprint,
    match: serializeMatch(match),
    schedule: schedule ? serializeSchedule(schedule) : undefined
  });
}

module.exports = {
  FEEDS,
  ALL_GROUPS,
  feedFileName,
  ensureFeed,
  readStops,
  matchStops,
  buildSchedule,
  isServiceActive,
  normalizeName,
  stopKey,
  loadStopIndex,
  saveStopIndex
};
