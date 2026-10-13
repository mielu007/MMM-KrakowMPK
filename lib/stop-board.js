"use strict";

const { decodeTripUpdates } = require("./gtfs-rt");
const { computeDepartures } = require("./departures");
const {
  ALL_GROUPS,
  ensureFeed,
  readStops,
  matchStops,
  buildSchedule,
  normalizeName,
  stopKey,
  loadStopIndex,
  saveStopIndex
} = require("./gtfs-static");
const { GtfsError } = require("./errors");

const HOUR_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_DEPARTURES = 40;

// Real-time answers shared by all instances: several mirrors modules for the same feed make one request.
const realtimeCache = new Map();

const typeOfGroup = (group) => (group === "T" ? "tram" : "bus");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Everything needed to answer "what leaves this stop next" for one module instance.
 *
 * The timetable is downloaded once and kept on disk; the part for the chosen
 * stop is saved too, so a restart is instant. It is checked for a newer version
 * every `scheduleCheckMs` and refreshed in the background while the old one is
 * still being shown. Real-time data is fetched on every update.
 */
class StopBoard {
  /**
   * @param {object} options
   * @param {string} options.baseUrl where ZTP publishes the files, e.g. https://gtfs.ztp.krakow.pl
   * @param {string} options.cacheDir folder for the downloaded timetables
   * @param {string[]} [options.groups] feeds to search: "A" (MPK buses), "M" (Mobilis buses), "T" (trams)
   * @param {string[]} [options.stopIds] stop_id or stop_code values
   * @param {string} [options.stopName] used when there are no stopIds
   * @param {number} [options.lookaheadMinutes]
   * @param {number} [options.scheduleCheckMs] how often to look for a newer timetable
   * @param {(message: string) => void} [options.onProgress] told what is going on during the first load
   */
  constructor({
    baseUrl,
    cacheDir,
    groups = ALL_GROUPS,
    stopIds = [],
    stopName = "",
    lookaheadMinutes = 180,
    scheduleCheckMs = 6 * HOUR_MS,
    realtimeTtlMs = 10_000,
    realtimeAttempts = 3,
    realtimeRetryDelayMs = 2000,
    onProgress = () => {},
    fetchImpl = globalThis.fetch,
    clock = Date.now
  }) {
    Object.assign(this, {
      baseUrl,
      cacheDir,
      groups,
      stopIds,
      stopName,
      lookaheadMinutes,
      scheduleCheckMs,
      realtimeTtlMs,
      realtimeAttempts,
      realtimeRetryDelayMs,
      onProgress,
      fetchImpl,
      clock
    });
    this.sources = []; // { type, group, schedule }
    this.preparedAt = 0;
    this.refreshing = null;
    this.pendingWarnings = [];
    this.error = null; // a configuration problem that will not fix itself
    this.stopTitle = "";
  }

  /**
   * @returns {Promise<{
   *   stopName: string,
   *   departures: object[],
   *   warnings: string[],
   *   realtime: {available: boolean, ageSeconds: number|null}
   * }>}
   */
  async update() {
    const warnings = this.pendingWarnings.splice(0);

    if (this.error) {
      throw this.error;
    }

    if (this.sources.length === 0) {
      await this.prepare(warnings, this.onProgress); // the very first load: nothing to show yet
    } else if (!this.refreshing && this.clock() - this.preparedAt > this.scheduleCheckMs) {
      // Keep showing the current timetable while a newer one is prepared.
      const background = [];
      this.refreshing = this.prepare(background, () => {})
        .catch((error) => {
          background.push(`Could not refresh the timetable, using the previous one: ${error.message}`);
          this.preparedAt = this.clock() - this.scheduleCheckMs + HOUR_MS; // try again in an hour
        })
        .finally(() => {
          this.pendingWarnings.push(...background);
          this.refreshing = null;
        });
    }

    const results = await Promise.all(
      this.sources.map(async (source) => {
        try {
          return await this.getRealtime(source.group);
        } catch (error) {
          warnings.push(`No real-time data for ${source.group}, showing the timetable: ${error.message}`);
          return null;
        }
      })
    );

    const departures = computeDepartures(
      this.sources.map((source, index) => ({
        type: source.type,
        schedule: source.schedule,
        tripUpdates: results[index] ? results[index].tripUpdates : null
      })),
      this.clock(),
      this.lookaheadMinutes
    );

    const timestamps = results.filter(Boolean).map((result) => result.timestamp);
    return {
      stopName: this.stopTitle,
      departures: departures.slice(0, MAX_DEPARTURES),
      warnings,
      realtime: {
        available: results.some(Boolean),
        ageSeconds: timestamps.length > 0 ? Math.max(0, Math.round(this.clock() / 1000 - Math.max(...timestamps))) : null
      }
    };
  }

  getRealtime(group) {
    const key = `${this.baseUrl}|${group}`;
    const cached = realtimeCache.get(key);
    // An entry "from the future" (the clock was corrected, e.g. by NTP after boot) is not fresh.
    const age = cached ? this.clock() - cached.at : -1;
    if (cached && age >= 0 && age < this.realtimeTtlMs) {
      return cached.promise;
    }

    const promise = this.fetchRealtime(group);
    realtimeCache.set(key, { at: this.clock(), promise });
    promise.catch(() => realtimeCache.delete(key)); // do not remember failures
    return promise;
  }

  /** The ZTP server sometimes answers with an empty feed, so an empty answer is fetched again. */
  async fetchRealtime(group) {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/TripUpdates_${group}.pb`;
    let lastProblem = "no data";

    for (let attempt = 1; attempt <= this.realtimeAttempts; attempt++) {
      if (attempt > 1) {
        await sleep(this.realtimeRetryDelayMs);
      }

      let response;
      try {
        response = await this.fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (error) {
        lastProblem = `request failed: ${error.message}`;
        continue;
      }
      if (!response.ok) {
        lastProblem = `HTTP ${response.status}`;
        continue;
      }

      const feed = decodeTripUpdates(Buffer.from(await response.arrayBuffer()));
      if (feed.entityCount > 0 && feed.timestamp !== null) {
        return feed;
      }
      lastProblem = "the feed is empty";
    }

    throw new GtfsError("CONNECTION", `${url}: ${lastProblem} (tried ${this.realtimeAttempts} times)`);
  }

  /** Looks the stop up in one feed: from the saved result when the archive is unchanged, otherwise by reading the archive. */
  async loadGroup(group, report, warnings) {
    const query = { stopName: this.stopName, stopIds: this.stopIds };
    const key = stopKey(query);

    report(`Sprawdzanie rozkładu ZTP (${group})…`);
    const feed = await ensureFeed({
      baseUrl: this.baseUrl,
      group,
      cacheDir: this.cacheDir,
      checkIntervalMs: this.scheduleCheckMs,
      fetchImpl: this.fetchImpl,
      now: this.clock()
    });
    if (feed.warning) {
      warnings.push(feed.warning);
    }

    const saved = await loadStopIndex(this.cacheDir, group, key, feed.fingerprint);
    if (saved) {
      return saved;
    }

    report(`Przetwarzanie rozkładu ${group} (jednorazowo, potrwa chwilę)…`);
    const match = matchStops(await readStops(feed.file), query);
    const outcome = { match, schedule: match.status === "ok" ? await buildSchedule(feed.file, match.stopIds) : undefined };
    await saveStopIndex(this.cacheDir, group, key, feed.fingerprint, outcome);
    return outcome;
  }

  /** Reads the timetable of the stop and replaces `this.sources` when done. */
  async prepare(warnings, report) {
    const outcomes = await Promise.all(
      this.groups.map(async (group) => {
        try {
          return { group, ...(await this.loadGroup(group, report, warnings)) };
        } catch (error) {
          return { group, failure: error };
        }
      })
    );

    const ready = outcomes.filter((outcome) => outcome.schedule);

    if (ready.length === 0) {
      const failure = outcomes.find((outcome) => outcome.failure);
      if (failure) {
        throw failure.failure instanceof GtfsError
          ? failure.failure
          : new GtfsError("SCHEDULE_UNAVAILABLE", `Cannot read the timetable ${failure.group}: ${failure.failure.message}`, { cause: failure.failure });
      }

      const ambiguous = outcomes.find((outcome) => outcome.match.status === "ambiguous");
      const wanted = this.stopIds.length > 0 ? `stop_id/stop_code ${this.stopIds.join(", ")}` : `"${this.stopName}"`;
      const error = ambiguous
        ? new GtfsError("STOP_AMBIGUOUS", `Several stops match ${wanted}: ${ambiguous.match.names.join("; ")}. Use a stop_id (see "npm run find-stop").`)
        : new GtfsError("STOP_NOT_FOUND", `No stop matches ${wanted} in the timetables ${this.groups.join(", ")}. Run "npm run find-stop" to look it up.`);
      if (this.sources.length === 0) {
        this.error = error; // a wrong id will not fix itself, so it is not searched for again
      }
      throw error;
    }

    for (const outcome of outcomes) {
      if (outcome.failure) {
        warnings.push(`Timetable ${outcome.group} is not available: ${outcome.failure.message}`);
      }
    }

    this.sources = ready.map(({ group, schedule }) => ({ type: typeOfGroup(group), group, schedule }));
    this.stopTitle =
      this.stopName && ready.some((r) => normalizeName(r.match.name) === normalizeName(this.stopName)) ? this.stopName : ready[0].match.name;
    this.preparedAt = this.clock();
  }
}

module.exports = { StopBoard, realtimeCache };
