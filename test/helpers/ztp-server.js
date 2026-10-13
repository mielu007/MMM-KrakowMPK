"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const FIXTURES = path.join(__dirname, "..", "fixtures");
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));

/**
 * A stand-in for https://gtfs.ztp.krakow.pl serving the test fixtures
 * (feeds A and T; M answers 404, as if it was unavailable).
 *
 * Knobs on `server.state`:
 *   version[group]      change it to publish a "new" timetable (new ETag)
 *   validators          false = send neither ETag nor Last-Modified
 *   zipGate             a promise; zip responses wait for it
 *   emptyRealtime       how many real-time requests get an empty feed before real data
 *   realtimeStatus      HTTP status of real-time requests (200 = ok)
 */
async function startZtpServer() {
  const state = {
    version: { A: 1, T: 1 },
    validators: true,
    zipGate: null,
    emptyRealtime: 0,
    realtimeStatus: 200,
    requests: []
  };

  const server = http.createServer(async (req, res) => {
    state.requests.push({ url: req.url, ifNoneMatch: req.headers["if-none-match"] });
    const match = /^\/GTFS_KRK_([AMT])\.zip$/.exec(req.url);
    const realtime = /^\/TripUpdates_([AMT])\.pb$/.exec(req.url);

    if (match && state.version[match[1]]) {
      const group = match[1];
      const etag = `"v${state.version[group]}"`;
      const headers = { "Content-Type": "application/zip" };
      if (state.validators) {
        headers.ETag = etag;
        headers["Last-Modified"] = "Mon, 12 Oct 2026 09:49:01 GMT";
      }

      if (state.validators && req.headers["if-none-match"] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      if (state.zipGate) {
        await state.zipGate;
      }
      const body = fixture(`GTFS_KRK_${group}.zip`);
      res.writeHead(200, { ...headers, "Content-Length": body.length });
      return res.end(body);
    }

    if (realtime && state.version[realtime[1]]) {
      if (state.realtimeStatus !== 200) {
        res.writeHead(state.realtimeStatus);
        return res.end();
      }
      if (state.emptyRealtime > 0) {
        state.emptyRealtime -= 1;
        res.writeHead(200, { "Content-Length": 0 });
        return res.end();
      }
      const body = fixture(`TripUpdates_${realtime[1]}.pb`);
      res.writeHead(200, { "Content-Length": body.length });
      return res.end(body);
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.state = state;
  server.baseUrl = `http://127.0.0.1:${server.address().port}`;
  server.zipDownloads = () => state.requests.filter((r) => r.url.endsWith(".zip"));
  server.stop = () => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  };
  return server;
}

module.exports = { startZtpServer, FIXTURES, fixture };
