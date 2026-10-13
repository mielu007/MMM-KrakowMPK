"use strict";

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { StopBoard } = require("../lib/stop-board");
const { startZtpServer } = require("./helpers/ztp-server");
const { tempDir, cleanTempDirs } = require("./helpers/temp");

// Tuesday 2026-10-13, 14:15:00 in Kraków
const START = Date.parse("2026-10-13T12:15:00Z");

describe("StopBoard against a mock ZTP server", () => {
  let server;
  let now;

  before(async () => {
    server = await startZtpServer();
  });
  after(async () => {
    await server.stop();
    cleanTempDirs();
  });
  beforeEach(() => {
    now = START;
    Object.assign(server.state, { zipGate: null, emptyRealtime: 0, realtimeStatus: 200, validators: true });
    server.state.version.A = 1;
    server.state.requests.length = 0;
  });

  const create = (options = {}) =>
    new StopBoard({
      baseUrl: server.baseUrl,
      cacheDir: options.cacheDir || tempDir(),
      stopIds: ["9001"],
      realtimeTtlMs: 0,
      realtimeRetryDelayMs: 0,
      clock: () => now,
      ...options
    });

  const lines = (result) => result.departures.map((d) => `${d.line}:${d.minutes}:${d.realtime ? "rt" : "sched"}`);

  test("cold start: finds the stop in the right feed and shows live data", async () => {
    const progress = [];
    const result = await create({ onProgress: (text) => progress.push(text) }).update();

    assert.equal(result.stopName, "Teatr Bagatela");
    assert.deepEqual(lines(result), ["124:4:rt", "124:16:rt", "124:23:rt", "124:40:rt"]);
    assert.equal(result.realtime.available, true);
    assert.equal(result.realtime.ageSeconds, 30); // the feed is stamped 14:14:30
    assert.ok(progress.some((text) => /Przetwarzanie/.test(text)), "tells the screen what is going on");
    // feed M does not exist on the server: a warning, not a failure
    assert.ok(result.warnings.some((w) => /Timetable M/.test(w)));
  });

  test("warm start (a restart of MagicMirror): no download and the archive is not read at all", async () => {
    const cacheDir = tempDir();
    await create({ cacheDir, groups: ["A", "T"] }).update();

    // If anything opened the archive now, it would choke on this.
    fs.writeFileSync(path.join(cacheDir, "GTFS_KRK_A.zip"), "not a zip any more");
    fs.writeFileSync(path.join(cacheDir, "GTFS_KRK_T.zip"), "not a zip any more");
    server.state.requests.length = 0;
    now += 10 * 60_000; // 14:25, well inside the 6 hour check interval

    const result = await create({ cacheDir, groups: ["A", "T"] }).update();
    assert.deepEqual(lines(result), ["124:6:rt", "124:13:rt", "124:30:rt"]); // B1 has left by now
    assert.deepEqual(server.zipDownloads(), []); // only the live data was requested
  });

  test("every update fetches live data again", async () => {
    const board = create();
    await board.update();
    await board.update();
    const realtime = server.state.requests.filter((r) => r.url === "/TripUpdates_A.pb");
    assert.equal(realtime.length, 2);
  });

  test("an empty live feed is fetched again, as the ZTP server sometimes sends one", async () => {
    server.state.emptyRealtime = 2;
    const result = await create().update();
    assert.equal(result.departures[0].realtime, true);
    assert.equal(server.state.requests.filter((r) => r.url === "/TripUpdates_A.pb").length, 3);
  });

  test("if live data stays unavailable the timetable is shown, with a warning", async () => {
    server.state.emptyRealtime = 99;
    const result = await create().update();
    assert.equal(result.realtime.available, false);
    assert.equal(result.departures.length > 0, true);
    assert.equal(result.departures.every((d) => !d.realtime), true);
    assert.ok(result.warnings.some((w) => /No real-time data/.test(w)));
  });

  test("a live-data server error is also only a warning", async () => {
    server.state.realtimeStatus = 503;
    const result = await create().update();
    assert.equal(result.realtime.available, false);
    assert.equal(result.departures.length > 0, true);
  });

  test("several instances share one live-data request", async () => {
    const first = create({ realtimeTtlMs: 10_000 });
    const second = create({ realtimeTtlMs: 10_000 });
    await Promise.all([first.update(), second.update()]);
    assert.equal(server.state.requests.filter((r) => r.url === "/TripUpdates_A.pb").length, 1);
  });

  test("a stop that does not exist is reported once, and not searched for again", async () => {
    const board = create({ stopIds: ["nope"], groups: ["A", "T"] });
    await assert.rejects(board.update(), { code: "STOP_NOT_FOUND" });
    server.state.requests.length = 0;
    await assert.rejects(board.update(), { code: "STOP_NOT_FOUND" });
    assert.equal(server.state.requests.length, 0);
  });

  test("a stop not found while one feed is unreachable is not a final answer: it may be in that feed", async () => {
    const board = create({ stopIds: ["nope"] }); // feed M is down
    await assert.rejects(board.update(), { code: "CONNECTION" });
    await assert.rejects(board.update(), { code: "CONNECTION" }); // asked again, not remembered
  });

  test("an ambiguous name lists the candidates", async () => {
    const board = create({ stopIds: [], stopName: "Bagatela", groups: ["T"] });
    await assert.rejects(board.update(), (error) => error.code === "STOP_AMBIGUOUS" && /Teatr Bagatela Wschód/.test(error.message));
  });

  test("a stop_code works as well as a stop_id", async () => {
    const result = await create({ stopIds: ["BAG01"], groups: ["T"] }).update();
    assert.deepEqual(lines(result), ["18:7:rt"]);
    assert.equal(result.departures[0].delaySeconds, 120);
  });

  test("with no timetable and no connection the first update fails clearly", async () => {
    server.state.version.A = 0;
    await assert.rejects(create({ groups: ["A"] }).update(), { code: "CONNECTION" });
  });

  describe("when the timetable changes", () => {
    // check for a newer timetable every 5 minutes, so the test stays within the fixtures' hour
    const CHECK = 5 * 60_000;
    const later = () => {
      now += 6 * 60_000; // 14:21
    };
    const make = (options = {}) => create({ groups: ["A"], scheduleCheckMs: CHECK, ...options });

    test("the new one is noticed after the check interval and parsed again", async () => {
      const cacheDir = tempDir();
      const board = make({ cacheDir });
      await board.update();

      server.state.version.A = 2;
      later();
      server.state.requests.length = 0;
      await board.update(); // starts the refresh in the background
      await board.refreshing;

      const saved = JSON.parse(fs.readFileSync(path.join(cacheDir, fs.readdirSync(cacheDir).find((f) => f.startsWith("stop-A-")))));
      assert.match(saved.fingerprint, /v2/);
      assert.equal(server.zipDownloads().length, 1);
    });

    test("an unchanged timetable is only checked (304), never downloaded again", async () => {
      const board = make();
      await board.update();
      later();
      server.state.requests.length = 0;
      await board.update();
      await board.refreshing;

      const zipRequests = server.zipDownloads();
      assert.equal(zipRequests.length, 1);
      assert.equal(zipRequests[0].ifNoneMatch, '"v1"');
    });

    test("the screen keeps working while the new timetable is still being fetched", async () => {
      const board = make();
      await board.update();

      server.state.version.A = 2;
      let open;
      server.state.zipGate = new Promise((resolve) => (open = resolve));
      later();

      const during = await board.update(); // must not wait for the gated download
      assert.equal(during.departures.length > 0, true);
      assert.ok(board.refreshing, "refreshing in the background");

      open();
      await board.refreshing;
      assert.equal(board.refreshing, null);
      assert.equal((await board.update()).departures.length > 0, true);
    });

    test("if the refresh cannot be done, the old timetable stays and the reason is a warning", async () => {
      const board = make();
      await board.update();

      server.state.version.A = 0; // the server now answers 404
      later();
      await board.update();
      await board.refreshing;

      const next = await board.update();
      assert.equal(next.departures.length > 0, true);
      assert.ok(next.warnings.some((w) => /Using the cached/.test(w)));
    });
  });
});
