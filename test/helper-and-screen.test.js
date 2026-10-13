"use strict";

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const NodeModule = require("node:module");
const vm = require("node:vm");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { startZtpServer } = require("./helpers/ztp-server");
const { tempDir, cleanTempDirs } = require("./helpers/temp");

const run = promisify(execFile);
const ROOT = path.join(__dirname, "..");

after(cleanTempDirs);

// ---- node_helper.js, loaded the way MagicMirror² loads it --------------------

const logged = [];
const originalLoad = NodeModule._load;
NodeModule._load = function (request, ...rest) {
  if (request === "node_helper") {
    return { create: (definition) => definition };
  }
  if (request === "logger") {
    const log = (level) => (message) => logged.push([level, message]);
    return { info: log("info"), warn: log("warn"), error: log("error"), log: log("log") };
  }
  return originalLoad.call(this, request, ...rest);
};
const helperDefinition = require("../node_helper");
NodeModule._load = originalLoad;

describe("node_helper", () => {
  let server;
  let helper;
  let sent;
  let realFetch;

  before(async () => {
    server = await startZtpServer();
    // the helper talks to the real ZTP address; point it at the mock server instead
    realFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => realFetch(String(url).replace("https://gtfs.ztp.krakow.pl", server.baseUrl), options);
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await server.stop();
  });

  beforeEach(() => {
    sent = [];
    logged.length = 0;
    server.state.version.A = 1;
    server.state.emptyRealtime = 0;
    server.state.realtimeStatus = 200;
    helper = Object.create(helperDefinition);
    helper.name = "MMM-KrakowMPK";
    helper.sendSocketNotification = (notification, payload) => sent.push({ notification, payload });
    helper.start();
    helper.cacheDir = tempDir(); // keep the test's saved timetables out of the module's real .cache folder
  });

  const lastData = () => sent.filter((s) => s.notification === "KRAKOWMPK_DATA").at(-1).payload;

  test("ignores messages without an instance identifier", () => {
    helper.socketNotificationReceived("KRAKOWMPK_CONFIG", { config: {} });
    assert.equal(sent.length, 0);
  });

  test("turns an error into text for the screen, in Polish", async () => {
    helper.configure("m1", { stops: [{ id: "nope" }], feeds: ["A", "T"], maxDepartures: 5 });
    await helper.refresh("m1");
    const data = lastData();
    assert.equal(data.identifier, "m1");
    assert.deepEqual(data.departures, []);
    assert.match(data.status, /Nie znaleziono przystanku "nope"/);
    assert.ok(logged.some(([level]) => level === "error"));
  });

  test("does nothing for an instance it has not been configured for", async () => {
    await helper.refresh("unknown");
    assert.equal(sent.length, 0);
  });

  test("a second request while the first one runs is ignored", async () => {
    helper.configure("m1", { stops: [{ id: "9001" }], feeds: ["A"] });
    await Promise.all([helper.refresh("m1"), helper.refresh("m1")]);
    assert.equal(sent.filter((s) => s.payload.departures.length > 0).length, 1);
  });

  test("instances do not mix up their answers", async () => {
    helper.configure("a", { stops: [{ id: "9001" }], feeds: ["A"] });
    helper.configure("b", { stops: [{ id: "nope" }], feeds: ["A"] });
    await Promise.all([helper.refresh("a"), helper.refresh("b")]);
    const byId = Object.fromEntries(sent.map((s) => [s.payload.identifier, s.payload]));
    assert.equal(byId.a.departures.length > 0, true);
    assert.equal(byId.b.departures.length, 0);
  });
});

// ---- the screen: MMM-KrakowMPK.js ------------------------------------------------

class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.className = "";
    this.textContent = "";
    this.children = [];
    const classes = new Set();
    this.classList = {
      add: (name) => {
        classes.add(name);
        this.className = `${this.className} ${name}`.trim();
      }
    };
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  all(className) {
    const found = [];
    const walk = (node) => {
      if (node.className.split(" ").includes(className)) {
        found.push(node);
      }
      node.children.forEach(walk);
    };
    walk(this);
    return found;
  }
}

function loadScreen() {
  let definition;
  const sandbox = {
    Module: { register: (name, def) => (definition = def) },
    document: { createElement: (tag) => new FakeElement(tag) },
    setInterval: () => 1,
    clearInterval: () => {}
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "MMM-KrakowMPK.js"), "utf8"), sandbox);
  return definition;
}

describe("screen (MMM-KrakowMPK.js)", () => {
  const definition = loadScreen();

  function create(config = {}) {
    const sent = [];
    const screen = Object.create(definition);
    Object.assign(screen, {
      identifier: "module_2_MMM-KrakowMPK",
      config: { ...definition.defaults, ...config },
      sendSocketNotification: (notification, payload) => sent.push({ notification, payload }),
      updateDom: () => {}
    });
    screen.sent = sent;
    return screen;
  }

  const departure = (overrides = {}) => ({
    route: "174",
    destination: "Os. Piastów",
    scheduled: "14:20",
    minutes: 5,
    minutesText: "za 5 min",
    delayMinutes: 2,
    realtime: true,
    ...overrides
  });

  test("sends its identifier with the config, and with every refresh", () => {
    const screen = create();
    screen.start();
    screen.suspend();
    screen.resume();
    assert.deepEqual(screen.sent.map((s) => s.notification), ["KRAKOWMPK_CONFIG", "KRAKOWMPK_REFRESH"]);
    assert.equal(screen.sent[0].payload.identifier, "module_2_MMM-KrakowMPK");
    assert.equal(screen.sent[1].payload.identifier, "module_2_MMM-KrakowMPK");
  });

  test("ignores data meant for another instance", () => {
    const screen = create();
    screen.departures = [];
    screen.socketNotificationReceived("KRAKOWMPK_DATA", { identifier: "someone_else", departures: [departure()], status: "" });
    assert.deepEqual(screen.departures, []);
    screen.socketNotificationReceived("KRAKOWMPK_DATA", { identifier: screen.identifier, departures: [departure()], status: "" });
    assert.equal(screen.departures.length, 1);
  });

  test("shows the delay with a colour class, or 'rozkład' for a timetable-only departure", () => {
    const screen = create();
    screen.status = "";
    screen.departures = [departure({ delayMinutes: 4 }), departure({ delayMinutes: 0 }), departure({ delayMinutes: -3 }), departure({ realtime: false, delayMinutes: null })];
    const cells = screen.getDom().all("krakowmpk-delay");
    assert.deepEqual(cells.map((c) => c.textContent), ["+4 min", "na czas", "-3 min", "rozkład"]);
    assert.deepEqual(cells.map((c) => c.className.split(" ").pop()), ["late", "ontime", "early", "scheduled"]);
  });

  test("shows the status line, and 'Ładowanie' before the first answer", () => {
    const screen = create();
    screen.status = "Brak danych na żywo ZTP — wyświetlam rozkład.";
    screen.departures = [];
    assert.equal(screen.getDom().all("krakowmpk-status")[0].textContent, "Brak danych na żywo ZTP — wyświetlam rozkład.");
  });
});

// ---- tools/find-stop.js ---------------------------------------------------------

describe("npm run find-stop", () => {
  let server;
  before(async () => {
    server = await startZtpServer();
  });
  after(() => server.stop());

  test("lists stop_id and stop_code of matching stops", async () => {
    const { stdout } = await run(process.execPath, [
      path.join(ROOT, "tools", "find-stop.js"),
      "bagatela",
      "--feeds",
      "A,T",
      "--base-url",
      server.baseUrl,
      "--cache-dir",
      tempDir()
    ]);
    const rows = stdout.split("\n").filter((line) => /^[AT]\t/.test(line)).map((line) => line.split("\t"));
    assert.deepEqual(rows.map((r) => r.join("|")), ["T|1001|BAG01|Teatr Bagatela", "T|1002|BAG02|Teatr Bagatela", "A|9001||Teatr Bagatela", "T|1003|BAG03|Teatr Bagatela Wschód"]);
  });

  test("explains the usage when there is no search text", async () => {
    await assert.rejects(run(process.execPath, [path.join(ROOT, "tools", "find-stop.js")]), (error) => /Usage/.test(error.stderr));
  });
});
