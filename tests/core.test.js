// Tests for core.js (the app's pure logic). Run from the repository root:  node --test tests/
// Needs Node 18+; nothing to install.
process.env.TZ = "Europe/Budapest";  // a zone with daylight saving, for the time-axis tests

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../core.js");

const bytes = a => new DataView(Uint8Array.from(a).buffer);
// A pvvx "custom" broadcast payload: MAC A4:C1:38:7F:60:5A (reversed), 22.44 °C, 56.48 %, 2950 mV, 80 %.
const PVVX = [0x5A, 0x60, 0x7F, 0x38, 0xC1, 0xA4, 0xC4, 0x08, 0x10, 0x16, 0x86, 0x0B, 80, 1, 4];
const MAC = "A4:C1:38:7F:60:5A";

test("clock drift: shared cases (same file as the Python tests)", () => {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "drift_cases.json"), "utf8"));
  const problems = [];
  for (const c of cases) {
    const r = core.driftCorrect(c.ts, { nowSensor: c.now_sensor, nowTrue: c.now_true });
    if (c.expect === "corrected") {
      const worst = Math.max(...r.corr.map((v, i) => Math.abs(v - c.true[i])));
      if (!(worst <= c.tolerance)) problems.push(`${c.name}: off by up to ${worst.toFixed(1)} s (allowed ${c.tolerance})`);
    } else if (r.corr.some((v, i) => v !== c.ts[i])) problems.push(`${c.name}: times changed`);
  }
  assert.deepEqual(problems, []);
});

test("clock drift: recorded clock set gives the error exactly", () => {
  // 3 days at 600 s, then the clock was set back by 100 s (recorded), then 1 day more.
  const t0 = 1790000000, ts = [];
  for (let i = 0; i < 432; i++) ts.push(t0 + i * 600);
  const setAt = ts[431] + 500, before = setAt + 100;  // sensor read 100 s fast just before the set
  for (let i = 1; i <= 144; i++) ts.push(setAt + i * 600 - 500 + 100 - 100);
  const r = core.driftCorrect(ts, { sets: [{ before, at: setAt }] });
  assert.equal(Math.round(r.stretches[0].E), 100);
  assert.equal(r.stretches[0].applied, true);
});

test("broadcasts: pvvx custom and ATC1441 formats", () => {
  assert.deepEqual(core.parseAdv(bytes(PVVX)), { mac: MAC, t: 22.44, h: 56.48, mv: 2950, b: 80 });
  // ATC1441: MAC in order, temp int16 BE ×0.1, hum %, batt %, mV BE, counter
  const atc = [0xA4, 0xC1, 0x38, 0x7F, 0x60, 0x5A, 0x00, 0xE1, 57, 81, 0x0B, 0x86, 9];
  assert.deepEqual(core.parseAdv(bytes(atc)), { mac: MAC, t: 22.5, h: 57, b: 81, mv: 2950 });
  assert.equal(core.parseAdv(bytes([1, 2, 3])), null);
});

test("broadcasts: every service-data shape browsers hand over", () => {
  const pick = sd => { const e = core.advEntries(sd).find(([k, dv]) => dv && (k.startsWith("0000181a") || k === "181a")); return e && core.parseAdv(e[1]); };
  const full = "0000181a-0000-1000-8000-00805f9b34fb";
  const hex = PVVX.map(b => b.toString(16).padStart(2, "0")).join("");
  for (const [label, sd] of [
    ["standard Map", new Map([[full, bytes(PVVX)]])],
    ["object with ArrayBuffer", { [full]: Uint8Array.from(PVVX).buffer }],
    ["object with byte array", { [full]: PVVX }],
    ["object with hex text", { "181A": hex }],
    ["object with base64 text", { "181a": Buffer.from(PVVX).toString("base64") }],
    ["bare DataView: raw advertising structures", bytes([0x02, 0x01, 0x06, 0x12, 0x16, 0x1A, 0x18, ...PVVX])],
    ["bare DataView: UUID + payload", bytes([0x1A, 0x18, ...PVVX])],
  ]) assert.equal(pick(sd) && pick(sd).mac, MAC, label);
  // Bluefy 3.9 sends 9E E9 65 (base64 "null") for "no data": nothing may be read from it.
  assert.deepEqual(core.advEntries(bytes([0x9E, 0xE9, 0x65])), []);
  assert.deepEqual(core.advEntries({}), []);
  assert.deepEqual(core.advEntries(null), []);
});

test("sensor config: decode then encode gives the same bytes", () => {
  const reply = [0x55, 88, 133, 16, 10, 6, 40, 4, 169, 49, 49, 0, 60];  // a real LYWSD03MMC reply
  const cfg = core.decodeCfg(Uint8Array.from(reply));
  assert.equal(cfg.advertising_interval_ms_info, 2500);
  assert.equal(cfg.flg.bits.advertising_type, 1);
  assert.deepEqual(core.encodeCfg(cfg), reply.slice(2));
  assert.equal(core.logIntervalFromCfg(cfg), 600);           // 2.5 s × 4 × 60
  assert.equal(core.logIntervalFromCfg({ ...cfg, av_meas_mem_raw: 0 }), 0);  // logging off
  assert.throws(() => core.decodeCfg(Uint8Array.from([0x55, 1, 2])));
});

test("CSV: write and read back, both formats, with sensor time", () => {
  const rows = [["2026-11-22 10:00:00", "+00:00", 21.5, 55.25, 2990, "2026-11-22 10:00:42"],
                ["2026-11-22 10:10:00", "+01:00", -3.25, 80, 3001, ""]];
  for (const loc of ["en", "hu"]) {
    const back = core.parseCsv(core.toCsv(rows, loc));
    assert.deepEqual(back[0], [Date.UTC(2026, 10, 22, 10) / 1000, 21.5, 55.25, 2990, Date.UTC(2026, 10, 22, 10, 0, 42) / 1000], loc);
    assert.deepEqual(back[1], [Date.UTC(2026, 10, 22, 9, 10) / 1000, -3.25, 80, 3001], loc);  // +01:00 → UTC
  }
  assert.match(core.toCsv(rows, "hu").split("\r\n")[1], /;21,50;55,25;/);
  // Older files: no utc_offset or sensor_timestamp column
  assert.deepEqual(core.parseCsv("timestamp,temperature_c,humidity_pct,battery_mv\n2026-01-01 00:00:00,20.00,50.00,3000\n"),
    [[Date.UTC(2026, 0, 1) / 1000, 20, 50, 3000]]);
});

test("merging: a re-download with corrected time replaces the old copy", () => {
  const old = [1790000000, 21.5, 55.25, 2990];                    // stored before drift correction
  const again = [1790000000 - 37, 21.5, 55.25, 2990, 1790000000];  // same reading, corrected
  const other = [1790000000, 21.6, 55.25, 2990];                   // another reading at the same time
  assert.equal(core.sampleKey(old), core.sampleKey(again));
  assert.notEqual(core.sampleKey(old), core.sampleKey(other));
});

test("sensor IDs from file names and old store keys", () => {
  assert.equal(core.histId("ATC_7f605a"), "ATC_7F605A");
  assert.equal(core.histId("ATC_7F605A__Kitchen"), "ATC_7F605A");
  assert.equal(core.histId("something else"), "something else");
});

test("time axis: round local times, midnight-aligned, across a DST change", () => {
  const a = Date.UTC(2026, 9, 24, 22) / 1000, b = Date.UTC(2026, 9, 25, 22) / 1000;  // 25 Oct: clocks back
  const { ticks, unit } = core.timeTicks(a, b, 10);
  assert.equal(unit, "subday");
  assert.deepEqual(ticks.map(t => new Date(t * 1000).getHours()), [0, 3, 6, 9, 12, 15, 18, 21]);
  const week = core.timeTicks(Date.UTC(2026, 10, 1) / 1000, Date.UTC(2026, 11, 1) / 1000, 6, 6);
  assert.equal(week.unit, "week");
  assert.ok(week.ticks.every(t => new Date(t * 1000).getDay() === 1), "weekly ticks on Mondays");
});

test("daylight-saving changes are found to the minute", () => {
  const year = core.dstChanges(Date.UTC(2026, 0, 1) / 1000, Date.UTC(2027, 0, 1) / 1000);
  assert.deepEqual(year, [{ t: Date.UTC(2026, 2, 29, 1) / 1000, delta: 60 }, { t: Date.UTC(2026, 9, 25, 1) / 1000, delta: -60 }]);
});

test("renaming: ATC_ is added in front when it's missing", () => {
  assert.equal(core.withAtcPrefix("Kitchen"), "ATC_Kitchen");
  assert.equal(core.withAtcPrefix("ATC_Kitchen"), "ATC_Kitchen");
  assert.equal(core.withAtcPrefix("  atc_Kitchen "), "ATC_Kitchen");
  assert.equal(core.withAtcPrefix("  "), "");
});

test("download buttons say what they do", () => {
  const label = (count, sync, erase) => core.downloadLabel({ count, sync, erase });
  assert.equal(label(0xffff, true, true), "Download, set clock & erase…");
  assert.equal(label(0xffff, true, false), "Download & set clock");
  assert.equal(label(0xffff, false, true), "Download & erase…");
  assert.equal(label(0xffff, false, false), "Download");
  assert.equal(label(100, true, true), "Download last 100 & set clock");  // a partial download never erases
  assert.equal(label(100, false, false), "Download last 100");
});

test("chart averages don't change when the chart is dragged", () => {
  const readings = [];
  for (let i = 0; i < 4000; i++) readings.push([1790000100 + i * 600 + i % 3, 20 + (i * 7919 % 50) / 10, 50 + (i * 104729 % 80) / 10, 3000]);
  const span = 7 * 86400, w = core.sliceWidth(span, 156, 600);
  assert.equal(w % 60, 0);
  assert.equal(core.sliceWidth(span + 1e-7, 156, 600), w);   // rounding in the span must not matter
  const slicesFor = a => {                                    // whole slices around the window, as the chart does
    const lo = Math.floor(a / w) * w, hi = Math.ceil((a + span) / w) * w;
    return new Map(core.averageSlices(readings.filter(s => s[0] >= lo && s[0] < hi), w).map(p => [Math.floor(p[0] / w), p]));
  };
  const base = slicesFor(1790300000);
  for (const shift of [1, 37, 1000, 5003, 40000]) {
    let shared = 0;
    for (const [k, p] of slicesFor(1790300000 + shift)) if (base.has(k)) { assert.deepEqual(p, base.get(k)); shared++; }
    assert.ok(shared > 100, `only ${shared} slices in common`);
  }
});

test("chart averaging: widths and contents", () => {
  assert.equal(core.sliceWidth(86400, 156, 600), 0);          // 24 h of 10-minute readings: no averaging
  assert.equal(core.sliceWidth(7 * 86400, 156, 600), 4800);   // 80 min
  assert.ok(core.sliceWidth(2000 * 86400, 100, 600) >= 2000 * 86400 / 100);
  assert.deepEqual(core.averageSlices([[1200, 20, 50], [1800, 22, 54], [2400, 30, 60]], 1200),
    [[1500, 21, 52, 2, 20, 22, 50, 54, 1200, 1800], [2400, 30, 60, 1, 30, 30, 60, 60, 2400, 2400]]);
});

test("dragging the chart stops at the ends of the data", () => {
  assert.deepEqual(core.clampWindow(100, 900, 100, 1000), { a: 100, b: 1000 });   // All: can't move
  assert.deepEqual(core.clampWindow(50, 900, 100, 1000), { a: 100, b: 1000 });
  assert.deepEqual(core.clampWindow(400, 900, 100, 1000), { a: 100, b: 1000 });
  assert.deepEqual(core.clampWindow(500, 200, 100, 1000), { a: 500, b: 700 });
  assert.deepEqual(core.clampWindow(950, 200, 100, 1000), { a: 800, b: 1000 });
  assert.deepEqual(core.clampWindow(-50, 200, 100, 1000), { a: 100, b: 300 });
});

test("chart resolution: calendar periods, also on days with a clock change", () => {
  const t = (...a) => new Date(...a).getTime() / 1000, D = 86400;
  assert.equal(core.periodStart(t(2026, 10, 18, 15, 20), D), t(2026, 10, 18));
  assert.equal(core.periodStart(t(2026, 10, 18, 15, 20), core.WEEK), t(2026, 10, 16));   // Monday
  assert.equal(core.periodStart(t(2026, 10, 18, 15, 20), core.MONTH), t(2026, 10, 1));
  assert.equal(core.periodStart(t(2026, 10, 18, 15, 20), 10800), t(2026, 10, 18, 15));
  for (const [y, m, d, hours] of [[2026, 9, 25, 25], [2026, 2, 29, 23], [2026, 10, 18, 24]]) {
    const s = core.periodStart(t(y, m, d, 12), D), e = core.periodEnd(s, D);
    assert.equal((e - s) / 3600, hours);
    assert.equal(core.periodStart(e - 1, D), s);                    // the last hour still belongs to the day
    for (const p of [3600, 10800, 21600, 43200]) {                  // shorter periods cover the day without gaps
      let x = s; while (x < e) { assert.equal(core.periodStart(x, p), x); x = core.periodEnd(x, p); }
      assert.equal(x, e);
    }
  }
  assert.equal(core.choosePeriod(7 * D, 37), 21600);
  assert.equal(core.periodProblem(D, 7 * D, 80), "");
  assert.equal(core.periodProblem(600, 7 * D, 80), "fine");
  assert.equal(core.periodProblem(core.WEEK, D, 80), "coarse");
  assert.equal(core.periodProblem(core.MONTH, 30 * D, 80), "");
  assert.equal(core.periodProblem(core.MONTH, 30 * D, 80, 2), "coarse");              // a line needs two points
});

test("candles: one per day, the same however much of the range is loaded", () => {
  const s = [], t0 = new Date(2026, 9, 23).getTime() / 1000;        // across the 25 Oct clock change
  for (let i = 0; i < 144 * 5; i++) s.push([t0 + i * 600, 20 + (i * 7919 % 37) / 10, 50, 3000]);
  const c = core.buildCandles(s, 86400);
  assert.deepEqual(c.map(x => x.n), [144, 144, 150, 144, 138]);
  assert.deepEqual(c[0].t, [s[0][1], Math.max(...s.slice(0, 144).map(r => r[1])), Math.min(...s.slice(0, 144).map(r => r[1])), s[143][1]]);
  assert.deepEqual(core.buildCandles(s.slice(144), 86400), c.slice(1));
});

test("sensor label: description, else Bluetooth name, else ID", () => {
  assert.equal(core.labelFor("Kitchen", "ATC_Kitchen", "ATC_A1B2C3"), "Kitchen");
  assert.equal(core.labelFor("", "ATC_Kitchen", "ATC_A1B2C3"), "ATC_Kitchen");
  assert.equal(core.labelFor("  ", undefined, "ATC_A1B2C3"), "ATC_A1B2C3");
  assert.equal(core.labelFor(undefined, "", "ATC_A1B2C3"), "ATC_A1B2C3");
});

test("chart resolution: closest one that fits the range", () => {
  const D = 86400, H = 3600;
  assert.equal(core.closestPeriod(D, 7 * D, 80, 0.9), D);             // fits: unchanged
  assert.equal(core.closestPeriod(H, 30 * D, 80, 0.9), 12 * H);       // too fine: the finest that fits
  assert.equal(core.closestPeriod(core.WEEK, D, 80, 0.9), D);         // too coarse: the coarsest that fits
  assert.equal(core.closestPeriod(core.MONTH, 7 * D, 1000, 2), D);
  assert.equal(core.closestPeriod(H, 120, 80, 0.9), 0);               // nothing fits a 2-minute view
});

test("readings lost during a download are noticed", () => {
  assert.equal(core.missingRecords([]), 0);
  assert.equal(core.missingRecords([1, 2, 3]), 0);
  assert.equal(core.missingRecords([3, 2, 1, 0]), 0);       // any order, from 0 or 1
  assert.equal(core.missingRecords([1, 2, 5]), 2);
  assert.equal(core.missingRecords([2, 3]), 1);             // the newest one
  assert.equal(core.missingRecords([1, 2, 2, 4]), 1);       // one arrived twice in place of another
});

test("small helpers", () => {
  assert.equal(core.fmtOffset(3600), "+01:00");
  assert.equal(core.fmtOffset(-16200), "-04:30");
  assert.equal(core.parseOffset("-04:30"), -16200);
  assert.equal(core.parseOffset("garbage"), 0);
  assert.equal(core.faceValue(1790000000), "2026-09-21 14:13:20");
  assert.deepEqual(core.le32(0x12345678), [0x78, 0x56, 0x34, 0x12]);
  assert.equal(core.fmtDur(3725), "1 h 2 min");
  assert.equal(core.fmtDays(0.5), "12 h");
});
