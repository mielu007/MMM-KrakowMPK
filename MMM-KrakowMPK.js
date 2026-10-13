Module.register("MMM-KrakowMPK", {
  defaults: {
    stops: [{ id: "8616", name: "Beskidzka 02" }],
    maxDepartures: 8,
    updateInterval: 30000,
    showDelay: true,
    showDestination: true,
    showPlatform: false,
    timeFormat: "24",
    fade: false,
    fadePoint: 0.7,
    // Which ZTP timetables to search for the stop: "A" (MPK buses), "M" (Mobilis buses), "T" (trams).
    // Listing only the one you need makes the first start faster.
    feeds: ["A", "M", "T"],
    // How far ahead to look for departures, in minutes.
    lookaheadMinutes: 180
  },

  start() {
    this.departures = [];
    this.status = "Ładowanie danych ZTP…";
    this.lastUpdated = null;
    this.sendSocketNotification("KRAKOWMPK_CONFIG", { identifier: this.identifier, config: this.config });
    this.scheduleUpdate();
  },

  scheduleUpdate() {
    clearInterval(this.updateTimer);
    this.updateTimer = setInterval(() => {
      this.sendSocketNotification("KRAKOWMPK_REFRESH", { identifier: this.identifier });
    }, Math.max(15000, this.config.updateInterval));
  },

  getStyles() {
    return ["MMM-KrakowMPK.css"];
  },

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "krakowmpk";

    const heading = document.createElement("div");
    heading.className = "krakowmpk-header";
    heading.textContent = (this.config.stops[0] && this.config.stops[0].name) || "Kraków MPK";
    wrapper.appendChild(heading);

    if (this.status) {
      const status = document.createElement("div");
      status.className = "krakowmpk-status";
      status.textContent = this.status;
      wrapper.appendChild(status);
    }

    if (!this.departures.length) return wrapper;

    const table = document.createElement("table");
    table.className = "krakowmpk-table";
    const tbody = document.createElement("tbody");

    this.departures.slice(0, this.config.maxDepartures).forEach((dep) => {
      const tr = document.createElement("tr");
      const line = document.createElement("td");
      line.className = "krakowmpk-line";
      line.textContent = dep.route || "?";
      tr.appendChild(line);

      const details = document.createElement("td");
      details.className = "krakowmpk-details";
      const dest = document.createElement("div");
      dest.className = "krakowmpk-destination";
      dest.textContent = this.config.showDestination ? (dep.destination || "Kierunek nieznany") : "";
      details.appendChild(dest);

      const times = document.createElement("div");
      times.className = "krakowmpk-times";
      times.textContent = `${dep.scheduled || "--:--"} · ${dep.minutesText || ""}`;
      details.appendChild(times);
      tr.appendChild(details);

      const delay = document.createElement("td");
      delay.className = "krakowmpk-delay";
      if (this.config.showDelay && dep.delayMinutes !== null && dep.delayMinutes !== undefined) {
        const d = dep.delayMinutes;
        delay.textContent = d > 0 ? `+${d} min` : (d < 0 ? `${d} min` : "na czas");
        delay.classList.add(d > 2 ? "late" : (d < -1 ? "early" : "ontime"));
      } else {
        delay.textContent = dep.realtime ? "RT" : "rozkład";
        delay.classList.add(dep.realtime ? "ontime" : "scheduled");
      }
      tr.appendChild(delay);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrapper.appendChild(table);

    if (this.lastUpdated) {
      const footer = document.createElement("div");
      footer.className = "krakowmpk-footer";
      footer.textContent = `Aktualizacja: ${this.lastUpdated}`;
      wrapper.appendChild(footer);
    }
    return wrapper;
  },

  socketNotificationReceived(notification, payload) {
    // Every instance of the module gets every notification; keep only the answers meant for this one.
    if (notification === "KRAKOWMPK_DATA" && payload.identifier === this.identifier) {
      this.departures = payload.departures || [];
      this.status = payload.status || "";
      this.lastUpdated = payload.lastUpdated || null;
      this.updateDom(300);
    }
  },

  suspend() {
    if (this.updateTimer) clearInterval(this.updateTimer);
  },

  resume() {
    this.scheduleUpdate();
    this.sendSocketNotification("KRAKOWMPK_REFRESH", { identifier: this.identifier });
  }
});
