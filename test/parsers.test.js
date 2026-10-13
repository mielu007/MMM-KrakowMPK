"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");

const { readCsv, parseLine } = require("../lib/csv");
const { ZipArchive } = require("../lib/zip");
const { decodeTripUpdates } = require("../lib/gtfs-rt");
const { FIXTURES } = require("./helpers/ztp-server");

const collect = async (readable, options = {}) => {
  const rows = [];
  await readCsv(readable, options, (row, columns) => rows.push({ row, columns }));
  return rows;
};

describe("csv", () => {
  test("parseLine handles quotes, doubled quotes and empty fields", () => {
    assert.deepEqual(parseLine('a,"b, c","say ""hi""",,e'), ["a", "b, c", 'say "hi"', "", "e"]);
  });

  test("handles a BOM, CRLF and a final line without a newline", async () => {
    const rows = await collect(Readable.from(["\ufeffa,b\r\n1,2\r\n3,4"]));
    assert.deepEqual(rows.map((r) => r.row), [["1", "2"], ["3", "4"]]);
    assert.deepEqual(rows[0].columns, { a: 0, b: 1 });
  });

  test("keeps a line break inside quotes in one field", async () => {
    const rows = await collect(Readable.from(['id,name\n1,"two\nlines"\n2,plain\n']));
    assert.deepEqual(rows.map((r) => r.row), [["1", "two\nlines"], ["2", "plain"]]);
  });

  test("copes with chunks that end in the middle of a line or of a character", async () => {
    const bytes = Buffer.from("id,name\n1,Łobzów\n2,Dworzec Główny\n", "utf8");
    // 0xC5 0x81 is "Ł": cut between the two bytes
    const chunks = [bytes.subarray(0, 10), bytes.subarray(10, 11), bytes.subarray(11, 25), bytes.subarray(25)];
    const rows = await collect(Readable.from(chunks));
    assert.deepEqual(rows.map((r) => r.row), [["1", "Łobzów"], ["2", "Dworzec Główny"]]);
  });

  test("skips blank lines", async () => {
    const rows = await collect(Readable.from(["a\n\n1\n\n"]));
    assert.equal(rows.length, 1);
  });

  test("reports a missing required column by name", async () => {
    await assert.rejects(collect(Readable.from(["a,b\n1,2\n"]), { name: "stops.txt", required: ["stop_id"] }), /stops\.txt.*stop_id/);
  });
});

describe("zip", () => {
  test("reads deflated entries made by Python's zipfile", async () => {
    const archive = await ZipArchive.open(path.join(FIXTURES, "GTFS_KRK_T.zip"));
    const rows = await collect(await archive.read("stops.txt"));
    assert.equal(rows.length, 8);
    assert.equal(rows[0].row[2], "Teatr Bagatela");
  });

  test("reads stored entries and finds files inside a folder", async () => {
    const archive = await ZipArchive.open(path.join(FIXTURES, "GTFS_KRK_A.zip"));
    assert.equal(archive.has("calendar.txt"), true);
    const rows = await collect(await archive.read("calendar.txt"));
    assert.equal(rows.length, 2);
  });

  test("knows when a file is missing", async () => {
    const archive = await ZipArchive.open(path.join(FIXTURES, "GTFS_KRK_A.zip"));
    assert.equal(archive.has("calendar_dates.txt"), false);
    await assert.rejects(archive.read("calendar_dates.txt"), /not found/);
  });

  test("rejects a file that is not a zip", async () => {
    const file = path.join(FIXTURES, "generate.py");
    await assert.rejects(ZipArchive.open(file), /not a zip/);
  });
});

describe("GTFS-Realtime decoder (data written by the official protobuf library)", () => {
  const load = (name) => decodeTripUpdates(fs.readFileSync(path.join(FIXTURES, name)));

  test("reads the header and counts every entity, also the ones it does not use", () => {
    const feed = load("TripUpdates_T.pb");
    assert.equal(feed.timestamp, 1791893670);
    assert.equal(feed.entityCount, 4); // a vehicle-position entity and three trip updates
    assert.equal(feed.tripUpdates.length, 3);
  });

  test("reads delays, cancellations and skipped stops", () => {
    const [t1, t7, t8] = load("TripUpdates_T.pb").tripUpdates;
    assert.equal(t1.stopTimeUpdates[0].departure.delay, 120);
    assert.equal(t1.stopTimeUpdates[0].stopId, "1001");
    assert.equal(t7.canceled, true);
    assert.equal(t8.stopTimeUpdates[0].skipped, true);
  });

  test("reads absolute times, negative delays and trip-level delays", () => {
    const updates = load("TripUpdates_A.pb").tripUpdates;
    const byTrip = (id, date) => updates.find((u) => u.tripId === id && (date === undefined || u.startDate === date));
    assert.equal(byTrip("B1", "20261013").stopTimeUpdates[0].departure.time, 1791893970);
    assert.equal(byTrip("B3").stopTimeUpdates[0].departure.delay, -90);
    assert.equal(byTrip("B4").delay, 300);
    assert.equal(byTrip("B2").startDate, null);
  });

  test("an empty answer is a feed with nothing in it, not an error", () => {
    const feed = decodeTripUpdates(Buffer.alloc(0));
    assert.deepEqual([feed.entityCount, feed.timestamp, feed.tripUpdates.length], [0, null, 0]);
  });

  test("garbage is reported as BAD_RESPONSE", () => {
    assert.throws(() => decodeTripUpdates(Buffer.from([0x12, 0x7f, 0x01])), { code: "BAD_RESPONSE" });
  });
});
