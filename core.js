// core.js - the app's pure logic (no page, no Bluetooth): sensor broadcast parsing, config
// encoding, clock-drift correction, CSV, time-axis ticks and daylight-saving changes.
// Loaded by index.html before its main script, and by the tests (tests/core.test.js) in Node.
"use strict";

const CFG_NEW_LAYOUT_VER = 0x47;

function fmtOffset(sec) {
  const m = Math.round(sec / 60), s = m >= 0 ? "+" : "-", a = Math.abs(m);
  return `${s}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
function parseOffset(s) {
  if (!s) return 0; const mm = /^([+-])?(\d{1,2}):(\d{2})$/.exec(s.trim()); if (!mm) return 0;
  return (mm[1] === "-" ? -1 : 1) * (parseInt(mm[2]) * 60 + parseInt(mm[3])) * 60;
}
// Epoch shown "at face value" (calendar fields of the number, no TZ shift) - like utcfromtimestamp()
function faceValue(epoch) {
  const d = new Date(epoch * 1000), p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

const macStr = bytes => [...bytes].map(x => x.toString(16).padStart(2, "0").toUpperCase()).join(":");

// Service data of an advertisement event as [uuid, DataView] pairs. The standard is a Map of
// DataViews; Bluefy hands over a plain object (v67 log: "{} is not iterable"), possibly with
// ArrayBuffers, byte arrays or strings as values - accept all of those.
function toDataView(v) {
  if (v == null) return null;
  if (v instanceof DataView) return v;
  if (v instanceof ArrayBuffer) return new DataView(v);
  if (ArrayBuffer.isView(v)) return new DataView(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return new DataView(Uint8Array.from(v).buffer);
  if (typeof v === "string") {
    const s = v.replace(/[\s:<>-]/g, "");
    if (/^([0-9a-f]{2})+$/i.test(s)) return new DataView(Uint8Array.from(s.match(/../g).map(x => parseInt(x, 16))).buffer);
    try { const b = atob(v); return new DataView(Uint8Array.from(b, c => c.charCodeAt(0)).buffer); } catch {}
  }
  if (typeof v === "object" && v.buffer instanceof ArrayBuffer) return new DataView(v.buffer);
  return null;
}
function advEntries(sd) {
  if (!sd) return [];
  // Bluefy (v68 log): serviceData is one bare DataView, not a Map. It may hold the raw advertising
  // structures ([len][type][data]…, service data = type 0x16 + 16-bit UUID), the 0x181A data with its
  // UUID in front, or just the 0x181A payload - try each; callers check the MAC inside before using it.
  if (sd instanceof DataView || sd instanceof ArrayBuffer || ArrayBuffer.isView(sd)) {
    const dv = toDataView(sd), u = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength), out = [];
    // Bluefy 3.9 (v70 log): always the 3 bytes 9E E9 65 = base64-decoded "null", i.e. no data at all.
    if (u.length === 3 && u[0] === 0x9e && u[1] === 0xe9 && u[2] === 0x65) return [];
    for (let i = 0; i + 1 < u.length;) {
      const len = u[i]; if (!len || i + 1 + len > u.length) break;
      if (u[i + 1] === 0x16 && len >= 3) out.push([`0000${u[i + 3].toString(16).padStart(2, "0")}${u[i + 2].toString(16).padStart(2, "0")}-0000-1000-8000-00805f9b34fb`, new DataView(u.buffer, u.byteOffset + i + 4, len - 3)]);
      i += 1 + len;
    }
    if (out.length) return out.map(([k, v]) => [k, v, v]);
    if (u.length >= 15 && u[0] === 0x1a && u[1] === 0x18) return [["181a", new DataView(u.buffer, u.byteOffset + 2, u.length - 2), sd]];
    return u.length ? [["181a", dv, sd]] : [];
  }
  let pairs = [];
  if (typeof sd.forEach === "function" && typeof sd.get === "function") sd.forEach((v, k) => pairs.push([k, v]));
  else if (typeof sd === "object") pairs = Object.entries(sd);
  return pairs.map(([k, v]) => [String(k).toLowerCase(), toDataView(v), v]);
}

// Parse sensor advertisements. pvvx "custom" format (service data 0x181A, 15+ bytes):
// MAC[6] reversed, temp int16 x0.01, hum uint16 x0.01, batt mV uint16, batt %, counter, flags (all little-endian).
// ATC1441 format (13 bytes): MAC[6] in order, temp int16 BE x0.1, hum %, batt %, batt mV uint16 BE, counter.
function parseAdv(dv) {
  const u = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  if (u.length >= 15) return { mac: macStr(u.slice(0, 6).reverse()), t: dv.getInt16(6, true) / 100, h: dv.getUint16(8, true) / 100, mv: dv.getUint16(10, true), b: u[12] };
  if (u.length === 13) return { mac: macStr(u.slice(0, 6)), t: dv.getInt16(6, false) / 10, h: u[8], b: u[9], mv: dv.getUint16(10, false) };
  return null;
}

const le32 = t => [t & 0xff, (t >>> 8) & 0xff, (t >>> 16) & 0xff, (t >>> 24) & 0xff];

// ===== Clock drift correction =====
// A sensor's clock can gain or lose time steadily (how much, and whether at all, is still being
// measured: Read clock and the clock line on connect show it).
// The sensor doesn't remember when its clock was set, but every clock set shows up in the log: the
// sample after it jumps by (interval − error). Between two sets the error grows linearly from 0, so
// each stretch between sets is corrected linearly. For the stretch still running, the error is
// measured by reading the clock before the download. Same algorithm as drift_correct() in
// ATC_MiThermometer_tools.py - keep the two in step.
// ts: sensor times in LOG order (face values); opts: { nowSensor, nowTrue, sets: [{before, at}], rate }
// Returns { corr: corrected face values (same order), stretches: [...], note }.
const DRIFT_TOL = 20, DRIFT_MAX_PER_DAY = 150;
function driftCorrect(ts, opts = {}) {
  const n = ts.length, corr = ts.slice(), res = { corr, stretches: [], note: "" };
  if (!n) return res;
  if (Math.min(...ts) < 1577836800) { res.note = "sensor clock was reset (dates before 2020) - not corrected"; return res; }
  const sets = opts.sets || [];
  const diffs = []; for (let k = 1; k < n; k++) diffs.push(ts[k] - ts[k - 1]);
  const good = diffs.filter(d => d >= 30 && d <= 7200).sort((a, b) => a - b);
  const P = good.length ? good[good.length >> 1] : 600;
  // Pass 1: steps that are not one interval. A recorded clock set gives the error exactly.
  const ev = [];
  for (let k = 1; k < n; k++) {
    const d = ts[k] - ts[k - 1];
    const rec = sets.find(r => r.before >= ts[k - 1] - 5 && r.before <= ts[k - 1] + 2 * P + 300 && r.at <= ts[k] + 5 && r.at >= ts[k] - 2 * P - 300);
    if (rec) { ev.push({ k, d, E: rec.before - rec.at, known: true }); continue; }
    if (Math.abs(d - P) <= DRIFT_TOL) continue;
    // Several intervals with no clock change = samples missed while connected, not a set.
    const m = Math.max(1, Math.round(d / P));
    if (m > 1 && Math.abs(m * P - d) <= DRIFT_TOL) continue;
    ev.push({ k, d, E: P - d, known: false });
  }
  const bounds = () => { const b = []; let a = 0; for (const e of ev) { b.push([a, e.k - 1, e]); a = e.k; } b.push([a, n - 1, null]); return b; };
  // Pass 2: a step can also hide skipped samples (step back by E plus one missed interval). Use the
  // typical drift rate (other stretches, or this sensor's last known rate) to pick the right count.
  const rates = bounds().filter(([a, b, e]) => e && ts[b] - ts[a] > 86400).map(([a, b, e]) => e.E / (ts[b] - ts[a]));
  if (opts.rate != null) rates.push(opts.rate);
  const rate = rates.length ? rates.slice().sort((x, y) => x - y)[rates.length >> 1] : null;
  if (rate != null) for (const [a, b, e] of bounds()) {
    if (!e || e.known) continue;
    const m = Math.max(1, Math.round((e.d + rate * (ts[b] - ts[a])) / P));
    e.E = m * P - e.d;
  }
  // Apply: error 0 at the start of each stretch, E at its end.
  for (const [a, b, e] of bounds()) {
    let s0 = ts[a];
    if (a === 0) { const r = sets.filter(r => r.at <= ts[0] + 5 && r.at >= ts[0] - 2 * P - 300).pop(); if (r) s0 = r.at; }
    let te, E;
    if (e) { te = ts[b]; E = e.E; }
    else if (opts.nowSensor != null && opts.nowTrue != null) { te = opts.nowSensor; E = opts.nowSensor - opts.nowTrue; }
    else { res.stretches.push({ from: ts[a], to: ts[b], n: b - a + 1, E: null, applied: false, why: "clock not read" }); continue; }
    const span = te - s0, perDay = span > 0 ? E / span * 86400 : 0;
    const st = { from: ts[a], to: ts[b], n: b - a + 1, E, perDay, applied: false, startKnown: a > 0 || s0 !== ts[a] };
    // The clock counts whole seconds and the read has ~1 s of uncertainty: ±2 s is "correct".
    if (span <= 0 || Math.abs(E) <= 2) st.why = "no drift (within 2 s)";
    // More error than drift can build up in that time = the clock was set to another value (or samples
    // were missed), not drift: leave those times alone.
    else if (Math.abs(E) > DRIFT_TOL + DRIFT_MAX_PER_DAY * span / 86400) st.why = "jump, not drift - not corrected";
    else { for (let i = a; i <= b; i++) corr[i] = ts[i] - E * Math.max(0, ts[i] - s0) / span; st.applied = true; }
    res.stretches.push(st);
  }
  return res;
}

const fmtDur = s => { const a = Math.abs(Math.round(s)); return a >= 3600 ? `${Math.floor(a / 3600)} h ${Math.round(a % 3600 / 60)} min` : a >= 60 ? `${Math.floor(a / 60)} min ${a % 60} s` : `${a} s`; };

const LOG_CAPACITY = 51 * 340;

// Seconds between logged samples, from the sensor's config: advertising interval × measurements per
// advertising interval × measurements per logged sample (av_meas_mem; 0 = logging off). These sensors:
// 2.5 s × 4 × 60 = 600 s. null if the config isn't known.
function logIntervalFromCfg(c) {
  if (!c || c.av_meas_mem_raw == null || !c.advertising_interval_ms_info || !c.measure_interval_raw) return null;
  return c.av_meas_mem_raw ? c.advertising_interval_ms_info * c.measure_interval_raw * c.av_meas_mem_raw / 1000 : 0;
}
const fmtDays = d => d >= 2 ? `${Math.round(d)} days` : d >= 1 ? "1 day" : `${Math.max(1, Math.round(d * 24))} h`;

// ===== Config (0x55) =====
function decodeCfg(b) {
  const len = b.length - 1; if (len < 9) throw new Error("config too short");
  const ver = b[1], flg = b[2], flg2 = b[3], to = b[4], ho = b[5];
  const cfg = {
    _note: "Raw sensor config (CMD_ID_CFG 0x55). Fields ending '_raw', and the bit fields under flg/flg2, are what --set-config writes back. Fields ending '_info' or under 'device_info' are read-only / computed for convenience and are ignored on write. Bits labelled 'hardware_specific' mean different things on different screen/model variants of this firmware - leave them alone unless you know what your specific sensor does with them.",
    device_info: { protocol_version_raw: ver, protocol_version_str: `${ver >> 4}.${ver & 15}` },
    flg: { raw: flg, bits: {
      advertising_type: flg & 3, comfort_smiley: !!(flg & 4), hardware_specific_bit3: !!(flg & 8),
      temperature_unit_fahrenheit: !!(flg & 16), hardware_specific_bit5: !!(flg & 32),
      tx_measures_when_connected: !!(flg & 64), low_power_measurements: !!(flg & 128) } },
    flg2: { raw: flg2, bits: {
      smiley_or_screen_type: flg2 & 7, adv_crypto: !!(flg2 & 8), adv_flags: !!(flg2 & 16),
      bt5_phy: !!(flg2 & 32), long_range: !!(flg2 & 64), screen_off: !!(flg2 & 128) } },
    advertising_interval_raw: b[6], advertising_interval_ms_info: Math.round(b[6] * 62.5 * 10) / 10,
    measure_interval_raw: b[7], rf_tx_power_raw: b[8],
    connect_latency_raw: b[9], connect_latency_ms_info: (b[9] + 1) * 20,
  };
  if (len >= 10) { cfg.lcd_tint_raw = b[10]; cfg.lcd_tint_seconds_info = Math.round(b[10] * 5) / 100; }
  if (len >= 11) cfg.hw_ver_raw = b[11];
  if (len >= 12) cfg.av_meas_mem_raw = b[12];
  if (ver < CFG_NEW_LAYOUT_VER) {
    const st = to > 127 ? to - 256 : to, sh = ho > 127 ? ho - 256 : ho;
    Object.assign(cfg, { temp_offset_raw: st, temp_offset_c_info: st / 10, humi_offset_raw: sh, humi_offset_pct_info: sh / 10 });
  } else {
    Object.assign(cfg, { temp_offset_raw: to, adv_interval_delay_raw_info: to & 15, date_display_ddmm_info: !!(to & 64),
      day_of_week_flag_info: !!(to & 128), humi_offset_raw: ho, event_adv_cnt_info: ho });
  }
  return cfg;
}
const FLG_BITS = [["advertising_type", 3, true], ["comfort_smiley", 4], ["hardware_specific_bit3", 8], ["temperature_unit_fahrenheit", 16],
  ["hardware_specific_bit5", 32], ["tx_measures_when_connected", 64], ["low_power_measurements", 128]];
const FLG2_BITS = [["smiley_or_screen_type", 7, true], ["adv_crypto", 8], ["adv_flags", 16], ["bt5_phy", 32], ["long_range", 64], ["screen_off", 128]];
function byteFromBits(obj, map) {
  if (!obj.bits) return obj.raw & 255;
  let v = 0; for (const [k, m, multi] of map) { if (multi) v |= (parseInt(obj.bits[k]) || 0) & m; else if (obj.bits[k]) v |= m; } return v;
}
function encodeCfg(c) {
  const p = [byteFromBits(c.flg, FLG_BITS), byteFromBits(c.flg2, FLG2_BITS), c.temp_offset_raw & 255, c.humi_offset_raw & 255,
    c.advertising_interval_raw & 255, c.measure_interval_raw & 255, c.rf_tx_power_raw & 255, c.connect_latency_raw & 255];
  if (c.lcd_tint_raw != null) {
    p.push(c.lcd_tint_raw & 255);
    if (c.hw_ver_raw != null) { p.push(c.hw_ver_raw & 255); p.push((c.av_meas_mem_raw || 0) & 255); }
  }
  return p;
}

// ===== CSV export / import =====
const fmtNum = (v, loc) => { const s = v.toFixed(2); return loc === "hu" ? s.replace(".", ",") : s; };
// rows: [tsStr, offStr, t, h, v, sensorTsStr]. "timestamp" is drift-corrected; "sensor_timestamp" is
// the sensor's own (uncorrected) time, empty when unknown - same columns as the Python tool.
function toCsv(rows, loc) {
  const d = loc === "hu" ? ";" : ",";
  return ["timestamp", "utc_offset", "temperature_c", "humidity_pct", "battery_mv", "sensor_timestamp"].join(d) + "\r\n" +
    rows.map(r => [r[0], r[1], fmtNum(r[2], loc), fmtNum(r[3], loc), r[4], r[5] || ""].join(d)).join("\r\n") + "\r\n";
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean); if (!lines.length) return [];
  const hu = lines[0].includes(";"), d = hu ? ";" : ",";
  const hdr = lines[0].split(d).map(h => h.trim().toLowerCase());
  const ix = (...n) => { for (const x of n) { const i = hdr.indexOf(x); if (i >= 0) return i; } return -1; };
  const iT = Math.max(0, ix("timestamp", "utc_timestamp", "local_timestamp")), iO = ix("utc_offset");
  const iTm = ix("temperature_c"), iH = ix("humidity_pct"), iV = ix("battery_mv"), iS = ix("sensor_timestamp");
  const out = [];
  const faceOf = s => { const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s || ""); return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 : null; };
  for (const ln of lines.slice(1)) {
    const c = ln.split(d); const num = s => parseFloat(hu ? String(s).replace(",", ".") : s);
    const face = faceOf(c[iT]); if (face == null) continue;
    const off = parseOffset(iO >= 0 ? c[iO] : "+00:00"), t = face - off;
    const sf = iS >= 0 ? faceOf(c[iS]) : null;
    const tm = num(c[iTm < 0 ? 1 : iTm]), hm = num(c[iH < 0 ? 2 : iH]), v = parseInt(c[iV < 0 ? 3 : iV]);
    if (isFinite(tm) && isFinite(hm)) out.push(sf != null && sf - off !== t ? [t, tm, hm, isFinite(v) ? v : 0, sf - off] : [t, tm, hm, isFinite(v) ? v : 0]);
  }
  return out;
}

// History is stored per sensor under its fixed ID (ATC_xxxxxx). Older versions stored it as
// "ATC_xxxxxx__Description", so a sensor whose description changed ended up in several stores.
function histId(key) {
  const id = String(key).split("__")[0];
  return /^ATC_[0-9A-F]{6}$/i.test(id) ? "ATC_" + id.slice(4).toUpperCase() : key;
}

// Time-axis ticks at round local times. Picks the smallest step that gives at most maxTicks ticks:
// 15/30 min, 1/2/3/6/12 h (aligned to local midnight), 1/2 days, weeks (Mondays), 1/3/6 months.
function timeTicks(a, b, maxTicks, maxDateTicks = maxTicks) {
  const span = b - a;
  const steps = [[900, "subday"], [1800, "subday"], [3600, "subday"], [7200, "subday"], [10800, "subday"], [21600, "subday"],
    [43200, "subday"], [86400, "day"], [172800, "day"], [604800, "week"], [2629800, "month"], [7889400, "month"], [15778800, "month"]];
  // Times ("12:00") need more room than dates ("Tue 17"), hence separate limits.
  let [step, unit] = steps.find(([s, u]) => span / s <= (u === "subday" ? maxTicks : maxDateTicks)) || [31557600, "month"];
  const d = new Date(a * 1000); d.setHours(0, 0, 0, 0);
  const monthsPerTick = Math.max(1, Math.round(step / 2629800));
  if (unit === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));   // back to Monday
  if (unit === "month") { d.setDate(1); d.setMonth(Math.floor(d.getMonth() / monthsPerTick) * monthsPerTick); }
  const ticks = [];
  for (let guard = 0; guard < 500 && d.getTime() / 1000 <= b; guard++) {
    const t = d.getTime() / 1000;
    if (t >= a) ticks.push(t);
    if (unit === "subday") d.setMinutes(d.getMinutes() + step / 60);
    else if (unit === "day") d.setDate(d.getDate() + step / 86400);
    else if (unit === "week") d.setDate(d.getDate() + 7);
    else d.setMonth(d.getMonth() + monthsPerTick);
  }
  return { ticks, unit };
}

// ===== Daylight-saving changes (phone's time zone) =====
// The chart's x axis is real time, so local clock labels are uneven on change days and, in autumn, an
// hour of local times happens twice. Changes are marked on the chart, and readout times near a
// change say "summer time" / "winter time" so the two 02:30s can be told apart.
const utcOffsetMin = t => -new Date(t * 1000).getTimezoneOffset();
// Changes between a and b (UTC seconds): [{ t, delta (minutes, + = clocks forward) }].
function dstChanges(a, b) {
  const out = [], step = 6 * 3600;
  for (let s = a; s < b; s += step) {
    const e = Math.min(b, s + step), o1 = utcOffsetMin(s), o2 = utcOffsetMin(e);
    if (o1 === o2) continue;
    let lo = s, hi = e;
    while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (utcOffsetMin(m) === o1) lo = m; else hi = m; }
    out.push({ t: hi, delta: o2 - o1 });
  }
  return out;
}

// What a sensor is called everywhere: its description, else its Bluetooth name, else its fixed ID.
const labelFor = (description, btName, id) => (description || "").trim() || (btName || "").trim() || id;

// A sensor's Bluetooth name must start with "ATC_" (so the Connect picker lists it): added if missing,
// and any other capitalisation of it is corrected.
const withAtcPrefix = name => {
  const s = String(name).trim();
  return !s ? "" : "ATC_" + s.replace(/^ATC_/i, "");
};

// What the download buttons say: exactly what a tap will do. "…" = asks for confirmation first.
// count: 0xffff = the whole log; a partial download never erases.
function downloadLabel({ count, sync, erase }) {
  const all = count === 0xffff, doErase = erase && all;
  const parts = [all ? "Download" : `Download last ${count}`];
  if (sync) parts.push("set clock");
  if (doErase) parts.push("erase");
  const last = parts.length > 1 ? " & " + parts.pop() : "";
  return parts.join(", ") + last + (doErase ? "…" : "");
}

// Slide a window of `span` seconds starting at `a` back inside [lo, hi]. A window as wide as the data
// (the "All" range) can't move at all.
function clampWindow(a, span, lo, hi) {
  if (a + span > hi) a = hi - span;
  if (a < lo) a = lo;
  return { a, b: a + span };
}

// ===== Chart averaging =====
// Long ranges are averaged into slices of time. Slices are fixed to the clock (multiples of their
// width), not to the chart's left edge: otherwise every bit of dragging would regroup the readings
// and the average line would jump. Widths come from a fixed list (in minutes), so they don't change
// with tiny differences in the span either.
const SLICE_MINUTES = [1, 2, 3, 5, 10, 20, 30, 40, 60, 80, 100, 120, 180, 240, 300, 360, 480, 720, 1440, 2880, 4320, 7200, 10080];
// Slice width in seconds for a span shown with at most maxPoints points, or 0 = no averaging needed
// (the readings, one per `interval` seconds, fit as they are).
function sliceWidth(span, maxPoints, interval) {
  const raw = span / maxPoints;
  if (raw <= interval * (1 + 1e-6)) return 0;
  const min = SLICE_MINUTES.find(m => m * 60 >= raw * (1 - 1e-6) && m * 60 >= interval * 2 * (1 - 0.01));
  return (min || Math.ceil(raw / 86400) * 1440) * 60;
}
// Averages [t, v1, v2, …] readings per slice, in order:
// [time avg, v1 avg, v2 avg, n, v1 min, v1 max, v2 min, v2 max, first time, last time].
// by: slice width in seconds, or a function giving the slice of a time (see periodKey).
function averageSlices(samples, by) {
  const acc = new Map(), key = typeof by === "function" ? by : t => Math.floor(t / by);
  for (const s of samples) {
    const k = key(s[0]);
    let a = acc.get(k);
    if (!a) acc.set(k, a = [0, 0, 0, 0, Infinity, -Infinity, Infinity, -Infinity, s[0], s[0]]);
    a[0] += s[0]; a[1] += s[1]; a[2] += s[2]; a[3]++;
    a[4] = Math.min(a[4], s[1]); a[5] = Math.max(a[5], s[1]); a[6] = Math.min(a[6], s[2]); a[7] = Math.max(a[7], s[2]);
    a[8] = Math.min(a[8], s[0]); a[9] = Math.max(a[9], s[0]);
  }
  return [...acc.entries()].sort((p, q) => p[0] - q[0])
    .map(([, a]) => [a[0] / a[3], a[1] / a[3], a[2] / a[3], a[3], ...a.slice(4)]);
}

// Calendar periods (local time) for candles and for a chosen resolution. Days start at midnight, weeks
// on Monday, months on the 1st; shorter periods count from midnight. Days with a clock change have 23
// or 25 hours and stay one period.
const WEEK = 604800, MONTH = 2629800;
const PERIODS = [[600, "10 minutes"], [1800, "30 minutes"], [3600, "1 hour"], [10800, "3 hours"], [21600, "6 hours"],
  [43200, "12 hours"], [86400, "1 day"], [WEEK, "1 week"], [MONTH, "1 month"]];
const periodLabel = p => (PERIODS.find(([s]) => s === p) || [0, ""])[1];
function periodStart(t, period) {
  const d = new Date(t * 1000);
  if (period === MONTH) return new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000;
  d.setHours(0, 0, 0, 0);
  if (period === WEEK) d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const midnight = d.getTime() / 1000;
  return period >= 86400 ? midnight : midnight + Math.floor((t - midnight) / period) * period;
}
function periodEnd(start, period) {
  const d = new Date(start * 1000);
  if (period === MONTH) return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() / 1000;
  if (period === WEEK) { d.setDate(d.getDate() + 7); return d.getTime() / 1000; }
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() / 1000;
  return period >= 86400 ? next : Math.min(start + period, next);
}
// periodStart for times that come in order (only recomputed when the period changes).
function periodKey(period) {
  let s = 1, e = 0;
  return t => { if (t < s || t >= e) { s = periodStart(t, period); e = periodEnd(s, period); } return s; };
}
// The shortest period giving at most maxCount periods over a span.
const choosePeriod = (span, maxCount) => (PERIODS.find(([p]) => span / p <= maxCount) || PERIODS[PERIODS.length - 1])[0];
// Can this period be shown over this span? "" = yes, else why not.
const periodProblem = (period, span, maxCount, minCount = 0.9) => span / period > maxCount ? "fine" : span / period < minCount ? "coarse" : "";
// The period closest to the wanted one that this span can show (the wanted one if it can), 0 = none.
function closestPeriod(wanted, span, maxCount, minCount) {
  let best = 0;
  const dist = p => Math.abs(Math.log(p / wanted));
  for (const [p] of PERIODS) if (!periodProblem(p, span, maxCount, minCount) && (!best || dist(p) < dist(best))) best = p;
  return best;
}
// Candles: [{ start, end, n, t: [open, high, low, close], h: [...] }] per period, from ordered readings.
function buildCandles(samples, period) {
  const list = [], key = periodKey(period); let cur = null;
  for (const [t, tm, hm] of samples) {
    const s = key(t);
    if (!cur || cur.start !== s) { cur = { start: s, end: periodEnd(s, period), n: 0, t: [tm, tm, tm, tm], h: [hm, hm, hm, hm] }; list.push(cur); }
    cur.n++;
    cur.t[1] = Math.max(cur.t[1], tm); cur.t[2] = Math.min(cur.t[2], tm); cur.t[3] = tm;
    cur.h[1] = Math.max(cur.h[1], hm); cur.h[2] = Math.min(cur.h[2], hm); cur.h[3] = hm;
  }
  return list;
}

// How a stored reading is identified when merging: the sensor's own timestamp (element 4; older
// samples have none, and their time IS the sensor's) plus its values. Re-downloads with an updated
// clock correction then replace the earlier copy, and two readings that got the same time after a
// clock set are both kept.
const sampleKey = s => `${s[4] != null ? s[4] : s[0]}|${(+s[1]).toFixed(2)}|${(+s[2]).toFixed(2)}|${s[3]}`;

// How many readings of a download never arrived. The firmware numbers them 1, 2, 3… without gaps
// (1 = the newest), so any number not seen up to the highest one was lost on the way.
function missingRecords(nums) {
  const seen = new Set(nums);
  let max = 0;
  for (const n of seen) if (n > max) max = n;
  return max + (seen.has(0) ? 1 : 0) - seen.size;
}

// ===== Complete backup (one JSON file) =====
const BACKUP_APP = "atc-companion", BACKUP_FORMAT = 1;
// d: { version, created, sensors: { rooms, known, removed, selected }, settings, clockLog, readings }
const makeBackup = d => JSON.stringify(Object.assign({ app: BACKUP_APP, format: BACKUP_FORMAT }, d));
// Reads a backup file. Throws an Error with a message for the user if it isn't one. Only entries that look
// right are kept, so a damaged or edited file can't leave something in the storage that breaks the app.
function parseBackup(text) {
  const isObj = o => !!o && typeof o === "object" && !Array.isArray(o), isNum = Number.isFinite;
  const entries = o => isObj(o) ? Object.entries(o).filter(([k]) => k.length <= 80 && !["__proto__", "constructor", "prototype"].includes(k)) : [];
  let d = null;
  try { d = JSON.parse(text); } catch {}
  if (!isObj(d) || d.app !== BACKUP_APP || !isNum(d.format) || !isObj(d.readings)) throw new Error("This isn't a backup of this app.");
  if (d.format > BACKUP_FORMAT) throw new Error("This backup was made by a newer version of the app. Reload the page and try again.");
  // The app version that made it: a number up to v125, then "2026-11-25.126" (day.build number).
  const version = isNum(d.version) ? String(d.version) : typeof d.version === "string" && /^[0-9][0-9.-]{0,19}$/.test(d.version) ? d.version : "";
  const out = { version, created: Date.parse(d.created) || 0, rooms: {}, known: {}, removed: [], selected: [], settings: {}, clockLog: {}, readings: {}, count: 0, skipped: 0 };
  for (const [key, list] of entries(d.readings)) {
    if (!Array.isArray(list)) continue;
    const id = histId(key), keep = out.readings[id] = out.readings[id] || [];
    for (const s of list) {
      if (!Array.isArray(s) || !isNum(s[0]) || s[0] <= 0 || !isNum(s[1]) || !isNum(s[2])) { out.skipped++; continue; }
      keep.push([s[0], s[1], s[2], isNum(s[3]) ? s[3] : 0, ...(isNum(s[4]) ? [s[4]] : [])]);
    }
    out.count += keep.length;
  }
  for (const id of Object.keys(out.readings)) if (!out.readings[id].length) delete out.readings[id];
  const sensors = isObj(d.sensors) ? d.sensors : {}, isId = n => typeof n === "string" && /^ATC_[0-9A-F]{6}$/.test(n);
  for (const [n, v] of entries(sensors.rooms)) if (isId(n) && typeof v === "string" && v.trim()) out.rooms[n] = v.trim().slice(0, 40);
  for (const [n, v] of entries(sensors.known)) {
    if (!isId(n) || !isObj(v)) continue;
    const k = out.known[n] = {};  // not the browser's own ID of the sensor: it means nothing elsewhere
    if (typeof v.mac === "string" && /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(v.mac)) k.mac = v.mac;
    if (typeof v.btName === "string" && v.btName) k.btName = v.btName.slice(0, 20);
    if (isNum(v.t) && isNum(v.h)) { k.t = v.t; k.h = v.h; for (const f of ["b", "mv", "seen"]) if (isNum(v[f])) k[f] = v[f]; }
    if (isObj(v.log) && isNum(v.log.at) && isNum(v.log.n) && v.log.P > 0) k.log = { at: v.log.at, n: v.log.n, P: v.log.P };
    if (isObj(v.cfg)) try { encodeCfg(v.cfg); k.cfg = v.cfg; if (isNum(v.cfgRead)) k.cfgRead = v.cfgRead; } catch {}
  }
  for (const f of ["removed", "selected"]) if (Array.isArray(sensors[f])) out[f] = sensors[f].filter(isId);
  const flat = v => v === null || ["string", "number", "boolean"].includes(typeof v);
  for (const [k, v] of entries(d.settings))
    if (flat(v) || (isObj(v) && Object.values(v).every(x => flat(x) || (isObj(x) && Object.values(x).every(flat))))) out.settings[k] = v;
  for (const [n, v] of entries(d.clockLog)) if (isObj(v)) out.clockLog[n] = {
    sets: (Array.isArray(v.sets) ? v.sets : []).filter(s => isObj(s) && isNum(s.before) && isNum(s.at)).map(s => ({ before: s.before, at: s.at })),
    rate: isNum(v.rate) ? v.rate : null };
  return out;
}
// Clock sets of both records in order of time; the drift rate of `a` (what's on this phone) goes first.
function mergeClockLog(a, b) {
  const sets = new Map([...(b.sets || []), ...(a.sets || [])].map(s => [s.at, s]));
  return { sets: [...sets.values()].sort((x, y) => x.at - y.at).slice(-40), rate: a.rate != null ? a.rate : b.rate != null ? b.rate : null };
}

// ===== Battery =====
// The sensors' CR2032 stays near 2.9-3.0 V for most of its life (after a quick drop in the first days) and
// then falls faster and faster. So there's no estimate while it's on that plateau, and the time left is
// counted to 2.5 V, well before the sensor stops.
const BATT_PLATEAU = 2850, BATT_LOW = 2700, BATT_EMPTY = 2500;
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
// samples: stored readings in order of time. Returns null without battery values, else { mv: median of the
// last 24 h, at, change: mV over 30 days (null = too few days), days: left until empty (null = no
// estimate), level: "ok" | "low" | "empty" }. Uses the medians of the last 30 days.
function batteryState(samples) {
  let i = samples.length - 1;
  while (i >= 0 && !(samples[i][3] > 0)) i--;
  if (i < 0) return null;
  const at = samples[i][0], byDay = [];
  for (; i >= 0 && at - samples[i][0] < 30 * 86400; i--) {
    const day = Math.floor((at - samples[i][0]) / 86400);
    if (samples[i][3] > 0) (byDay[day] = byDay[day] || []).push(samples[i][3]);
  }
  let days = []; byDay.forEach((v, day) => days.push([-day, median(v)]));  // newest first
  const mv = days[0][1];
  // A jump up = a new battery: only what came after it counts.
  for (let k = 1; k < days.length; k++) if (days[k - 1][1] - days[k][1] > 120) { days = days.slice(0, k); break; }
  // Median of the slopes between all pairs of days: not upset by single odd days.
  const slopes = [];
  if (days.length >= 7 && days[0][0] - days[days.length - 1][0] >= 10)
    for (let a = 0; a < days.length; a++) for (let b = a + 1; b < days.length; b++) slopes.push((days[a][1] - days[b][1]) / (days[a][0] - days[b][0]));
  const perDay = slopes.length ? median(slopes) : null;
  const left = perDay != null && perDay < -0.5 && mv < BATT_PLATEAU ? Math.max(0, (mv - BATT_EMPTY) / -perDay) : null;
  return { mv, at, change: perDay == null ? null : Math.round(perDay * 30), days: left,
    level: mv <= BATT_EMPTY ? "empty" : mv <= BATT_LOW || (left != null && left <= 30) ? "low" : "ok" };
}
function batteryText(b) {
  const left = b.level === "empty" || b.days == null ? "" : b.days < 14 ? `about ${count1(Math.max(1, Math.round(b.days)), "day")} left`
    : b.days < 70 ? `about ${Math.round(b.days / 7)} weeks left` : b.days < 365 ? `about ${Math.round(b.days / 30)} months left` : "";
  const trend = b.change == null ? "" : Math.abs(b.change) < 10 ? "steady" : `${b.change < 0 ? "down" : "up"} ${Math.abs(b.change)} mV in 30 days`;
  return [`${(b.mv / 1000).toFixed(2)} V`, { ok: "good", low: "getting low", empty: "change it now" }[b.level], left, trend].filter(Boolean).join(" · ");
}
const count1 = (n, what) => `${n} ${what}${n === 1 ? "" : "s"}`;

// ===== ZIP files (for exporting several CSV files as one) =====
let crcTable = null;
function crc32(bytes) {
  if (!crcTable) crcTable = Uint32Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xEDB88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
// entries: [{ name, data: Uint8Array, packed?: the same data compressed with raw deflate, crc? }].
function makeZip(entries, date = new Date()) {
  const enc = new TextEncoder(), parts = [], central = [];
  const time = date.getHours() << 11 | date.getMinutes() << 5 | date.getSeconds() >> 1;
  const day = Math.max(0, date.getFullYear() - 1980) << 9 | (date.getMonth() + 1) << 5 | date.getDate();
  const le = (...fields) => { const out = []; for (const [v, n] of fields) for (let i = 0; i < n; i++) out.push(Math.floor(v / 2 ** (8 * i)) & 255); return Uint8Array.from(out); };
  let pos = 0;
  for (const e of entries) {
    const name = enc.encode(e.name), body = e.packed || e.data;
    // version needed, flags (UTF-8 names), method, time, date, CRC, packed size, size, name length, extra length
    const info = [[20, 2], [0x800, 2], [e.packed ? 8 : 0, 2], [time, 2], [day, 2], [e.crc != null ? e.crc : crc32(e.data), 4], [body.length, 4], [e.data.length, 4], [name.length, 2], [0, 2]];
    const head = le([0x04034b50, 4], ...info);
    central.push(le([0x02014b50, 4], [20, 2], ...info, [0, 2], [0, 2], [0, 2], [0, 4], [pos, 4]), name);
    parts.push(head, name, body);
    pos += head.length + name.length + body.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const all = [...parts, ...central, le([0x06054b50, 4], [0, 2], [0, 2], [entries.length, 2], [entries.length, 2], [size, 4], [pos, 4], [0, 2])];
  const out = new Uint8Array(all.reduce((n, a) => n + a.length, 0));
  let o = 0; for (const a of all) { out.set(a, o); o += a.length; }
  return out;
}
// The files in a ZIP: [{ name, method: 0 stored / 8 deflate, body: Uint8Array, size, crc }].
function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), bad = () => new Error("This isn't a ZIP file, or it's damaged.");
  let end = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 66000; i--) if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw bad();
  const out = []; let p = dv.getUint32(end + 16, true);
  for (let n = dv.getUint16(end + 10, true); n > 0; n--) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw bad();
    const nameLen = dv.getUint16(p + 28, true), packed = dv.getUint32(p + 20, true), at = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (at + 30 > bytes.length) throw bad();
    const start = at + 30 + dv.getUint16(at + 26, true) + dv.getUint16(at + 28, true);
    if (start + packed > bytes.length) throw bad();
    out.push({ name, method: dv.getUint16(p + 10, true), body: bytes.subarray(start, start + packed), size: dv.getUint32(p + 24, true), crc: dv.getUint32(p + 16, true) });
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return out;
}

// Moves labels apart: the positions nearest to the wanted ones (ascending) that are at least `gap` apart and
// inside lo…hi. Labels too close together are spread around their common middle.
function spreadLabels(ys, gap, lo, hi) {
  const blocks = [];  // [sum, n] of "position minus i × gap", which must never fall
  ys.forEach((y, i) => {
    blocks.push([y - i * gap, 1]);
    for (let k = blocks.length - 1; k && blocks[k - 1][0] / blocks[k - 1][1] > blocks[k][0] / blocks[k][1]; k--) {
      const [s, n] = blocks.pop(); blocks[k - 1][0] += s; blocks[k - 1][1] += n;
    }
  });
  const top = Math.max(lo, hi - (ys.length - 1) * gap);
  return blocks.flatMap(([s, n]) => Array(n).fill(s / n)).map((v, i) => Math.max(lo, Math.min(top, v)) + i * gap);
}

if (typeof module !== "undefined") module.exports = {
  CFG_NEW_LAYOUT_VER, fmtOffset, parseOffset, faceValue, macStr, toDataView, advEntries, parseAdv, le32,
  DRIFT_TOL, DRIFT_MAX_PER_DAY, driftCorrect, fmtDur, LOG_CAPACITY, logIntervalFromCfg, fmtDays,
  decodeCfg, FLG_BITS, FLG2_BITS, byteFromBits, encodeCfg, fmtNum, toCsv, parseCsv, histId,
  timeTicks, utcOffsetMin, dstChanges, sampleKey, missingRecords, makeBackup, parseBackup, mergeClockLog, batteryState, batteryText, spreadLabels, crc32, makeZip, readZip, withAtcPrefix, labelFor, downloadLabel,
  sliceWidth, averageSlices, clampWindow,
  PERIODS, WEEK, MONTH, periodLabel, periodStart, periodEnd, periodKey, choosePeriod, periodProblem, closestPeriod, buildCandles,
};
