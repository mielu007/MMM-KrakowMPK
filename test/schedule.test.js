"use strict";

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { decodeTripUpdates } = require("../lib/gtfs-rt");
const { computeDepartures } = require("../lib/departures");
const {
  ensureFeed,
  readStops,
  matchStops,
  buildSchedule,
  isServiceActive,
  stopKey,
  loadStopIndex,
  saveStopIndex
} = require("../lib/gtfs-static");
const { formatClock, serviceDate, serviceDayStart, shiftDate, weekday } = require("../lib/time");
const { startZtpServer, FIXTURES } = require("./helpers/ztp-server");
const { tempDir, cleanTempDirs } = require("./helpers/temp");

// Tuesday 2026-10-13, 14:15:00 in Kraków (CEST)
const NOW = Date.parse("2026-10-13T12:15:00Z");
const zip = (group) => path.join(FIXTURES, `GTFS_KRK_${group}.zip`);
const updates = (name) => decodeTripUpdates(fs.readFileSync(path.join(FIXTURES, name))).tripUpdates;

after(cleanTempDirs);

describe("time", () => {
  test("a service day is 'noon minus 12 hours', so clock times stay right when the clocks change", () => {
    assert.equal(new Date(serviceDayStart("20261013")).toISOString(), "2026-10-12T22:00:00.000Z"); // an ordinary day: midnight CEST
    assert.equal(new Date(serviceDayStart("20261026")).toISOString(), "2026-10-25T23:00:00.000Z"); // the day after: midnight CET

    // 25 October 2026: the clocks go back at 03:00. The service day starts at 01:00 CEST
    // by definition, and still "08:00:00" must be 08:00 on the wall clock.
    assert.equal(new Date(serviceDayStart("20261025")).toISOString(), "2026-10-24T23:00:00.000Z");
    assert.equal(formatClock(serviceDayStart("20261025") + 8 * 3600_000), "08:00");
    // and on the day the clocks go forward (29 March 2026) as well
    assert.equal(formatClock(serviceDayStart("20260329") + 8 * 3600_000), "08:00");
  });

  test("date helpers", () => {
    assert.equal(serviceDate(Date.parse("2026-10-13T22:30:00Z")), "20261014"); // already after midnight in Kraków
    assert.equal(shiftDate("20261231", 1), "20270101");
    assert.equal(weekday("20261013"), 2);
  });
});

describe("stop matching", () => {
  let stops;
  before(async () => {
    stops = await readStops(zip("T"));
  });

  test("an id is matched against stop_id and against stop_code", () => {
    assert.deepEqual([...matchStops(stops, { stopIds: ["1001"] }).stopIds], ["1001"]);
    assert.deepEqual([...matchStops(stops, { stopIds: ["BAG01"] }).stopIds], ["1001"]);
    assert.deepEqual([...matchStops(stops, { stopIds: [1002] }).stopIds], ["1002"]);
  });

  test("an unknown id is not found", () => {
    assert.equal(matchStops(stops, { stopIds: ["nope"] }).status, "not_found");
  });

  test("a name takes in every platform with that name", () => {
    const match = matchStops(stops, { stopName: "teatr bagatela" });
    assert.deepEqual([...match.stopIds].sort(), ["1001", "1002"]);
  });

  test("a station brings its platforms", () => {
    const match = matchStops(stops, { stopName: "Rondo Mogilskie" });
    assert.deepEqual([...match.stopIds].sort(), ["5000", "5001"]);
  });

  test("a partial name with several candidates is ambiguous and lists them", () => {
    const match = matchStops(stops, { stopName: "Bagatela" });
    assert.equal(match.status, "ambiguous");
    assert.deepEqual(match.names, ["Teatr Bagatela", "Teatr Bagatela Wschód"]);
  });

  test("a name with a comma and Polish letters is read correctly", () => {
    assert.equal(matchStops(stops, { stopName: "Plac Inwalidów, perony" }).status, "ok");
    assert.equal(matchStops(stops, { stopName: "łobzów" }).status, "ok");
  });
});

describe("buildSchedule", () => {
  test("keeps only the calls at the stop, with their trips and routes", async () => {
    const schedule = await buildSchedule(zip("T"), new Set(["1001", "1002"]));
    assert.deepEqual(schedule.stopTimes.map((s) => s.tripId).sort(), ["T1", "T2", "T3", "T5", "T6", "T7", "T8"]);
    assert.equal(schedule.trips.get("T1").headsign, "Czerwone Maki P+R");
    assert.equal(schedule.routes.get("R52").longName, "Salwator - Dworzec Główny"); // line break in the file collapsed
  });

  test("recognises the last stop of a trip, and times after 24:00", async () => {
    const schedule = await buildSchedule(zip("T"), new Set(["1001", "1002"]));
    const by = Object.fromEntries(schedule.stopTimes.map((s) => [s.tripId, s]));
    assert.equal(by.T3.isLast, true);
    assert.equal(by.T1.isLast, false);
    assert.equal(by.T5.seconds, 24 * 3600 + 10 * 60);
  });

  test("falls back to the arrival time when there is no departure time", async () => {
    const schedule = await buildSchedule(zip("T"), new Set(["1001"]));
    assert.equal(schedule.stopTimes.find((s) => s.tripId === "T8").seconds, 14 * 3600 + 45 * 60);
  });

  test("works without calendar_dates.txt", async () => {
    const schedule = await buildSchedule(zip("A"), new Set(["9001"]));
    assert.equal(schedule.exceptions.size, 0);
    assert.equal(schedule.stopTimes.length, 4);
  });
});

describe("isServiceActive", () => {
  let schedule;
  before(async () => {
    schedule = await buildSchedule(zip("T"), new Set(["1001"]));
  });

  test("uses the days of the week and the date range of THAT service", () => {
    assert.equal(isServiceActive(schedule, "WK", "20261013", weekday("20261013")), true); // Tuesday
    assert.equal(isServiceActive(schedule, "WE", "20261013", weekday("20261013")), false); // weekend service on a Tuesday
    assert.equal(isServiceActive(schedule, "WE", "20261017", weekday("20261017")), true); // Saturday
    assert.equal(isServiceActive(schedule, "WK", "20270105", weekday("20270105")), false); // outside the range
  });

  test("exceptions win over the calendar", () => {
    assert.equal(isServiceActive(schedule, "WK", "20261111", weekday("20261111")), false); // a holiday: removed
    assert.equal(isServiceActive(schedule, "WE", "20261111", weekday("20261111")), true); // added
  });
});

describe("departures", () => {
  let tram;
  let bus;
  before(async () => {
    tram = await buildSchedule(zip("T"), new Set(["1001", "1002"]));
    bus = await buildSchedule(zip("A"), new Set(["9001"]));
  });

  const sources = (withRealtime = true) => [
    { type: "tram", schedule: tram, tripUpdates: withRealtime ? updates("TripUpdates_T.pb") : null },
    { type: "bus", schedule: bus, tripUpdates: withRealtime ? updates("TripUpdates_A.pb") : null }
  ];
  const summary = (list) => list.map((d) => `${d.type}:${d.line}:${d.minutes}:${d.realtime ? "rt" : "sched"}`);

  test("combines the timetable with live data, soonest first", () => {
    assert.deepEqual(summary(computeDepartures(sources(), NOW, 120)), [
      "bus:124:4:rt", // an absolute predicted time
      "tram:18:7:rt", // +120 s at the stop
      "bus:124:16:rt", // delay carried over from an earlier stop
      "bus:124:23:rt", // 90 s early
      "tram:52:27:sched", // no live data for this trip
      "bus:124:40:rt" // a delay for the whole trip
    ]);
  });

  test("reports the delay and both times as the screen needs them", () => {
    const [bus1, tram18] = computeDepartures(sources(), NOW, 120);
    assert.deepEqual([bus1.delaySeconds, bus1.scheduledAt, bus1.expectedAt], [90, "14:18", "14:19"]);
    assert.deepEqual([tram18.delaySeconds, tram18.scheduledAt, tram18.expectedAt], [120, "14:20", "14:22"]);
  });

  test("an update for another day's run does not leak into today's", () => {
    // yesterday's run of B1 is 10 minutes late; today's must not show 14:28
    const b1 = computeDepartures(sources(), NOW, 120).find((d) => d.expectedAt === "14:19");
    assert.ok(b1);
    assert.equal(computeDepartures(sources(), NOW, 120).some((d) => d.expectedAt === "14:28"), false);
  });

  test("leaves out cancelled trips, skipped stops, wrong-day services and the end of the line", () => {
    const all = computeDepartures(sources(), NOW, 120);
    const times = all.filter((d) => d.type === "tram").map((d) => d.scheduledAt);
    assert.deepEqual(times, ["14:20", "14:42"]); // not T3 (ends here), T6 (weekends), T7 (cancelled), T8 (skipped)
  });

  test("without live data everything is shown as the timetable says", () => {
    const list = computeDepartures(sources(false), NOW, 120);
    assert.equal(list.every((d) => d.realtime === false && d.delaySeconds === null), true);
    // now the cancelled / skipped trips cannot be known
    assert.deepEqual(list.filter((d) => d.type === "tram").map((d) => d.scheduledAt), ["14:20", "14:35", "14:42", "14:45"]);
  });

  test("the look-ahead limits the list", () => {
    assert.equal(computeDepartures(sources(), NOW, 10).length, 2);
  });

  test("shows a departure that has just left for a few seconds, not longer", () => {
    const justLeft = Date.parse("2026-10-13T12:20:20Z"); // 14:20:20, T1 predicted 14:22 -> still ahead
    assert.equal(computeDepartures(sources(), justLeft, 5).some((d) => d.line === "18"), true);
    const wellAfter = Date.parse("2026-10-13T12:23:30Z"); // 14:23:30, T1 left at 14:22
    assert.equal(computeDepartures(sources(), wellAfter, 5).some((d) => d.line === "18"), false);
  });

  test("a trip running past midnight is found from the previous service day", () => {
    const afterMidnight = Date.parse("2026-10-13T22:05:00Z"); // Wed 2026-10-14 00:05 in Kraków
    const list = computeDepartures([{ type: "tram", schedule: tram, tripUpdates: null }], afterMidnight, 30);
    assert.deepEqual(list.map((d) => [d.line, d.scheduledAt, d.minutes]), [["18", "00:10", 5]]); // T5: "24:10:00" of Tuesday
  });
});

describe("downloading the timetable", () => {
  let server;
  before(async () => {
    server = await startZtpServer();
  });
  after(() => server.stop());
  beforeEach(() => {
    server.state.requests.length = 0;
    server.state.version.A = 1;
    server.state.validators = true;
  });

  const ensure = (cacheDir, now) => ensureFeed({ baseUrl: server.baseUrl, group: "A", cacheDir, checkIntervalMs: 6 * 3600_000, now });

  test("downloads once, then does not ask again within the check interval", async () => {
    const dir = tempDir();
    const first = await ensure(dir, NOW);
    assert.equal(first.changed, true);
    const second = await ensure(dir, NOW + 3600_000);
    assert.equal(second.changed, false);
    assert.equal(server.zipDownloads().length, 1);
    assert.equal(second.fingerprint, first.fingerprint);
  });

  test("after the interval it asks with the ETag and keeps the file on 304", async () => {
    const dir = tempDir();
    await ensure(dir, NOW);
    const later = await ensure(dir, NOW + 7 * 3600_000);
    assert.equal(later.changed, false);
    assert.deepEqual(server.zipDownloads().map((r) => r.ifNoneMatch), [undefined, '"v1"']);
  });

  test("downloads again when the timetable changed, with a new fingerprint", async () => {
    const dir = tempDir();
    const first = await ensure(dir, NOW);
    server.state.version.A = 2;
    const later = await ensure(dir, NOW + 7 * 3600_000);
    assert.equal(later.changed, true);
    assert.notEqual(later.fingerprint, first.fingerprint);
  });

  test("a server without validators is downloaded again, and the content hash tells whether it changed", async () => {
    server.state.validators = false;
    const dir = tempDir();
    const first = await ensure(dir, NOW);
    const later = await ensure(dir, NOW + 7 * 3600_000);
    assert.equal(server.zipDownloads().length, 2);
    assert.equal(later.fingerprint, first.fingerprint); // same bytes, same fingerprint: nothing is parsed again
    assert.match(first.fingerprint, /^sha1:/);
  });

  test("keeps using the cached file when a check fails, and does not retry at once", async () => {
    const dir = tempDir();
    await ensure(dir, NOW);
    server.state.version.A = 0; // the server now answers 404
    server.state.requests.length = 0;

    const failed = await ensure(dir, NOW + 7 * 3600_000);
    assert.match(failed.warning, /Using the cached/);
    const again = await ensure(dir, NOW + 7 * 3600_000 + 60_000);
    assert.equal(again.warning, undefined);
    assert.equal(server.zipDownloads().length, 1);
  });

  test("fails when there is nothing cached and the server is down", async () => {
    server.state.version.A = 0;
    await assert.rejects(ensure(tempDir(), NOW), { code: "CONNECTION" });
  });

  test("a server that never answers is given up on quickly", async () => {
    const hang = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const started = Date.now();
    await assert.rejects(
      ensureFeed({ baseUrl: server.baseUrl, group: "A", cacheDir: tempDir(), checkIntervalMs: 1, fetchImpl: hang, responseTimeoutMs: 100, now: NOW }),
      { code: "CONNECTION" }
    );
    assert.ok(Date.now() - started < 2000);
  });

  test("never replaces a good file with a broken download", async () => {
    const dir = tempDir();
    const broken = async () => new Response("<html>maintenance</html>", { status: 200 });
    await assert.rejects(ensureFeed({ baseUrl: server.baseUrl, group: "A", cacheDir: dir, checkIntervalMs: 1, fetchImpl: broken, now: NOW }), {
      code: "BAD_RESPONSE"
    });
    assert.equal(fs.existsSync(path.join(dir, "GTFS_KRK_A.zip")), false);
    assert.equal(fs.existsSync(path.join(dir, "GTFS_KRK_A.zip.part")), false);
  });
});

describe("saved result for one stop", () => {
  test("is reused for the same archive version and dropped for another", async () => {
    const dir = tempDir();
    const schedule = await buildSchedule(zip("T"), new Set(["1001"]));
    const match = matchStops(await readStops(zip("T")), { stopIds: ["1001"] });
    const key = stopKey({ stopIds: ["1001"] });

    await saveStopIndex(dir, "T", key, "fp-1", { match, schedule });

    const loaded = await loadStopIndex(dir, "T", key, "fp-1");
    assert.deepEqual([...loaded.match.stopIds], ["1001"]);
    assert.equal(loaded.schedule.stopTimes.length, schedule.stopTimes.length);
    assert.equal(isServiceActive(loaded.schedule, "WK", "20261013", 2), true); // the calendar survived the round trip
    assert.equal(loaded.schedule.exceptions.get("WK").get("20261111"), "2");

    assert.equal(await loadStopIndex(dir, "T", key, "fp-2"), null); // the timetable changed
    assert.equal(await loadStopIndex(dir, "T", stopKey({ stopIds: ["1002"] }), "fp-1"), null); // another stop
  });

  test("also remembers that a feed does not have the stop", async () => {
    const dir = tempDir();
    await saveStopIndex(dir, "M", "k", "fp", { match: { status: "not_found" } });
    const loaded = await loadStopIndex(dir, "M", "k", "fp");
    assert.equal(loaded.match.status, "not_found");
    assert.equal(loaded.schedule, undefined);
  });
});
