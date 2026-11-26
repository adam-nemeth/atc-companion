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

// Before erasing: seconds to wait so the sensor's next reading isn't due right then (it would be logged
// between the last check for new readings and the erase, and be lost). times: the log's own times
// (sensor clock); sensorNow: the sensor clock now. Readings are logged every `interval` give or take a
// measurement, hence the margin. 0 = go ahead.
function waitForNextLog(times, sensorNow, margin = 15) {
  if (times.length < 3 || sensorNow == null) return 0;
  const s = times.slice().sort((a, b) => a - b), d = [];
  for (let i = 1; i < s.length; i++) { const x = s[i] - s[i - 1]; if (x >= 30 && x <= 7200) d.push(x); }
  if (!d.length) return 0;
  const P = d.sort((a, b) => a - b)[d.length >> 1];
  let next = s[s.length - 1] + P;
  while (next < sensorNow - margin) next += P;  // already logged: then it's in the check, the one after is next
  return next - sensorNow <= margin ? Math.ceil(next - sensorNow + margin) : 0;
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

// Sunrise and sunset ("sunrise equation", as used by NOAA; about a minute off at most, outside the polar
// regions), for the day whose solar noon is nearest to unix time `t`, at latitude `lat`, longitude `lon`
// (degrees, north and east positive). Returns { noon, rise, set } as unix times, with rise and set null and
// `polar` "day" (the sun never sets) or "night" (it never rises).
function sunTimes(t, lat, lon) {
  const rad = Math.PI / 180, J2000 = 2451545, toJd = s => s / 86400 + 2440587.5, toUnix = j => Math.round((j - 2440587.5) * 86400);
  const n = Math.round(toJd(t) - J2000 - 0.0009 + lon / 360), J = n + 0.0009 - lon / 360;
  const M = (357.5291 + 0.98560028 * J) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const lam = (M + C + 180 + 102.9372) % 360;
  const transit = J2000 + J + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * lam * rad);
  const sinD = Math.sin(lam * rad) * Math.sin(23.4397 * rad), cosD = Math.sqrt(1 - sinD * sinD);
  const cosW = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * sinD) / (Math.cos(lat * rad) * cosD);
  const noon = toUnix(transit);
  if (cosW < -1) return { noon, rise: null, set: null, polar: "day" };
  if (cosW > 1) return { noon, rise: null, set: null, polar: "night" };
  const w = Math.acos(cosW) / rad / 360;
  return { noon, rise: toUnix(transit - w), set: toUnix(transit + w), polar: null };
}

// The dark parts (sunset to sunrise) of t0…t1, as [[from, to], …] unix times, joined across midnights.
function darkSpans(t0, t1, lat, lon) {
  const spans = [], add = (a, b) => {
    a = Math.max(a, t0); b = Math.min(b, t1); if (b <= a) return;
    const last = spans[spans.length - 1];
    if (last && a - last[1] < 300) last[1] = Math.max(last[1], b); else spans.push([a, b]);
  };
  // Each solar day runs from 12 hours before its noon to 12 hours after it.
  for (let t = t0 - 86400; t < t1 + 86400; t += 86400) {
    const s = sunTimes(t, lat, lon), a = s.noon - 43200, b = s.noon + 43200;
    if (s.polar === "night") add(a, b);
    else if (!s.polar) { add(a, s.rise); add(s.set, b); }
  }
  return spans;
}

// The place of a time zone (e.g. "Europe/Budapest" → { lat: 47.5, lon: 19.08, place: "Budapest" }), or null
// when the zone has none (e.g. "UTC").
let tzIndex = null;
function tzPlace(zone) {
  if (!tzIndex) {
    tzIndex = new Map(TZ_PLACES.split("|").map(e => { const [z, a, b] = e.split(" "); return [z, { lat: +a, lon: +b }]; }));
    for (const e of TZ_LINKS.split("|")) { const [a, z] = e.split(">"); tzIndex.set(a, Object.assign({ alias: true }, tzIndex.get(z), { zone: z })); }
  }
  const p = tzIndex.get(zone || "");
  if (!p) return null;
  const z = p.zone || zone;
  return { lat: p.lat, lon: p.lon, place: z.slice(z.lastIndexOf("/") + 1).replace(/_/g, " ") };
}

// A typed or pasted location → { lat, lon }, or null. Understands what maps apps give:
//   "47.497913, 19.040236" (Google Maps; also with decimal commas: "47,4979; 19,0402"),
//   "47.49790° N, 19.04021° E" (Apple Maps; also "47° 29′ 52″ N, 19° 2′ 25″ E" and Hungarian É/D/K/Ny),
//   Google plus codes: full ("8FVXF2PR+X6") or short with the area after it ("F2PR+X6 Budapest, Hungary").
// A short plus code only says where inside a small square it is, so it's placed in the square nearest to
// the area named after it when that's a time zone's place (e.g. "Budapest"), or else nearest to `ref`
// ({ lat, lon }); `near` then says which. Without either, a short code gives null.
function parseLocation(s, ref) {
  s = (s || "").trim();
  if (!s) return null;
  const ok = (lat, lon) => isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
  const num = v => parseFloat(v.replace(",", "."));
  // Plain decimal degrees.
  let m = /^(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)$/.exec(s);
  if (m) return ok(num(m[1]), num(m[2]));
  // Degrees (with or without minutes and seconds) and N/S/E/W letters.
  const N = "(\\d+(?:[.,]\\d+)?)", H = "(NY|[NSEWÉDK])";
  const re = new RegExp(`${H}?\\s*(-?)${N}\\s*°\\s*(?:${N}\\s*['′’]\\s*)?(?:${N}\\s*(?:"|″|”|''|′′)\\s*)?${H}?`, "gi");
  const parts = [...s.toUpperCase().matchAll(re)];
  if (parts.length === 2 && s.replace(re, "").replace(/[\s,;]/g, "") === "") {
    const vals = parts.map(p => {
      const h = p[1] || p[6] || "", v = num(p[3]) + (p[4] ? num(p[4]) / 60 : 0) + (p[5] ? num(p[5]) / 3600 : 0);
      return { v: (p[2] || /^[SWD]$|^NY$/.test(h) ? -1 : 1) * v, axis: /^[NSÉD]$/.test(h) ? "lat" : h ? "lon" : "" };
    });
    if (vals[0].axis === "lon" || vals[1].axis === "lat") vals.reverse();
    if (vals[0].axis === "lon" || vals[1].axis === "lat") return null;   // e.g. two latitudes
    return ok(vals[0].v, vals[1].v);
  }
  // Google plus code (Open Location Code).
  m = /^([23456789CFGHJMPQRVWX]{0,8}0*\+[23456789CFGHJMPQRVWX]*)(?:[\s,]+(.*))?$/i.exec(s);
  return m ? plusCode(m[1].toUpperCase(), m[2] || "", ref) : null;
}

// Decodes a plus code (see https://github.com/google/open-location-code) to the middle of its area.
function plusCode(code, area, ref) {
  const A = "23456789CFGHJMPQRVWX", sep = code.indexOf("+");
  if (sep > 8 || sep % 2) return null;
  const digits = code.replace("+", "").replace(/0+$/, "").slice(0, 15);
  if (/0/.test(digits) || (sep < 8 && /0/.test(code))) return null;
  const pad = 8 - sep, cell = Math.pow(20, 2 - pad / 2);   // size of the square the left-out digits stand for
  let lat = 0, lon = 0, latRes = cell, lonRes = cell, i = 0;
  for (; i < digits.length && i < 10 - pad; i += 2) {
    latRes /= 20; lonRes /= 20;
    lat += A.indexOf(digits[i]) * latRes; lon += A.indexOf(digits[i + 1] || "2") * lonRes;
  }
  for (; i < digits.length; i++) {   // past 10 digits: a 4 × 5 grid each
    const d = A.indexOf(digits[i]); latRes /= 5; lonRes /= 4;
    lat += Math.floor(d / 4) * latRes; lon += (d % 4) * lonRes;
  }
  lat += latRes / 2; lon += lonRes / 2;
  let near = null;
  if (pad === 0) { lat -= 90; lon -= 180; }
  else {
    // A short code: put it in the square nearest to the area named after it, or to `ref`.
    for (const w of area.split(/[,;]/)) { const p = tzPlaceNamed(w.trim()); if (p) { ref = p; near = p.place; break; } }
    if (!ref || !isFinite(ref.lat) || !isFinite(ref.lon)) return null;
    lat += Math.floor((ref.lat + 90) / cell) * cell - 90; lon += Math.floor((ref.lon + 180) / cell) * cell - 180;
    if (ref.lat + cell / 2 < lat && lat - cell >= -90) lat -= cell; else if (ref.lat - cell / 2 > lat && lat + cell <= 90) lat += cell;
    if (ref.lon + cell / 2 < lon) lon -= cell; else if (ref.lon - cell / 2 > lon) lon += cell;
    if (lon > 180) lon -= 360; else if (lon < -180) lon += 360;
  }
  if (Math.abs(lat) > 90) return null;
  return Object.assign({ lat, lon }, pad ? { near: near || "ref" } : {});
}

// The time zone place with this name (e.g. "Budapest", "new york"), or null.
function tzPlaceNamed(name) {
  if (!name) return null;
  tzPlace("");   // builds the index
  const key = name.toLowerCase().replace(/_/g, " ");
  for (const [z, p] of tzIndex) if (!p.alias && z.slice(z.lastIndexOf("/") + 1).replace(/_/g, " ").toLowerCase() === key) return tzPlace(z);
  return null;
}

if (typeof module !== "undefined") module.exports = {
  CFG_NEW_LAYOUT_VER, fmtOffset, parseOffset, faceValue, macStr, toDataView, advEntries, parseAdv, le32,
  DRIFT_TOL, DRIFT_MAX_PER_DAY, driftCorrect, fmtDur, LOG_CAPACITY, logIntervalFromCfg, fmtDays,
  decodeCfg, FLG_BITS, FLG2_BITS, byteFromBits, encodeCfg, fmtNum, toCsv, parseCsv, histId,
  timeTicks, utcOffsetMin, dstChanges, sampleKey, missingRecords, makeBackup, parseBackup, mergeClockLog, batteryState, batteryText, spreadLabels, waitForNextLog, sunTimes, darkSpans, tzPlace, parseLocation, crc32, makeZip, readZip, withAtcPrefix, labelFor, downloadLabel,
  sliceWidth, averageSlices, clampWindow,
  PERIODS, WEEK, MONTH, periodLabel, periodStart, periodEnd, periodKey, choosePeriod, periodProblem, closestPeriod, buildCandles,
};

// Time zones and the coordinates of their main place, from the IANA tz database 2024a (zone.tab, public
// domain), and the old names some browsers report ("Asia/Calcutta" → "Asia/Kolkata").
const TZ_PLACES = "Africa/Abidjan 5.32 -4.03|Africa/Accra 5.55 -0.22|Africa/Addis_Ababa 9.03 38.7|Africa/Algiers 36.78 3.05|Africa/Asmara 15.33 38.88|Africa/Bamako 12.65 -8|Africa/Bangui 4.37 18.58|Africa/Banjul 13.47 -16.65|Africa/Bissau 11.85 -15.58|Africa/Blantyre -15.78 35|Africa/Brazzaville -4.27 15.28|Africa/Bujumbura -3.38 29.37|Africa/Cairo 30.05 31.25|Africa/Casablanca 33.65 -7.58|Africa/Ceuta 35.88 -5.32|Africa/Conakry 9.52 -13.72|Africa/Dakar 14.67 -17.43|Africa/Dar_es_Salaam -6.8 39.28|Africa/Djibouti 11.6 43.15|Africa/Douala 4.05 9.7|Africa/El_Aaiun 27.15 -13.2|Africa/Freetown 8.5 -13.25|Africa/Gaborone -24.65 25.92|Africa/Harare -17.83 31.05|Africa/Johannesburg -26.25 28|Africa/Juba 4.85 31.62|Africa/Kampala 0.32 32.42|Africa/Khartoum 15.6 32.53|Africa/Kigali -1.95 30.07|Africa/Kinshasa -4.3 15.3|Africa/Lagos 6.45 3.4|Africa/Libreville 0.38 9.45|Africa/Lome 6.13 1.22|Africa/Luanda -8.8 13.23|Africa/Lubumbashi -11.67 27.47|Africa/Lusaka -15.42 28.28|Africa/Malabo 3.75 8.78|Africa/Maputo -25.97 32.58|Africa/Maseru -29.47 27.5|Africa/Mbabane -26.3 31.1|Africa/Mogadishu 2.07 45.37|Africa/Monrovia 6.3 -10.78|Africa/Nairobi -1.28 36.82|Africa/Ndjamena 12.12 15.05|Africa/Niamey 13.52 2.12|Africa/Nouakchott 18.1 -15.95|Africa/Ouagadougou 12.37 -1.52|Africa/Porto-Novo 6.48 2.62|Africa/Sao_Tome 0.33 6.73|Africa/Tripoli 32.9 13.18|Africa/Tunis 36.8 10.18|Africa/Windhoek -22.57 17.1|America/Adak 51.88 -176.66|America/Anchorage 61.22 -149.9|America/Anguilla 18.2 -63.07|America/Antigua 17.05 -61.8|America/Araguaina -7.2 -48.2|America/Argentina/Buenos_Aires -34.6 -58.45|America/Argentina/Catamarca -28.47 -65.78|America/Argentina/Cordoba -31.4 -64.18|America/Argentina/Jujuy -24.18 -65.3|America/Argentina/La_Rioja -29.43 -66.85|America/Argentina/Mendoza -32.88 -68.82|America/Argentina/Rio_Gallegos -51.63 -69.22|America/Argentina/Salta -24.78 -65.42|America/Argentina/San_Juan -31.53 -68.52|America/Argentina/San_Luis -33.32 -66.35|America/Argentina/Tucuman -26.82 -65.22|America/Argentina/Ushuaia -54.8 -68.3|America/Aruba 12.5 -69.97|America/Asuncion -25.27 -57.67|America/Atikokan 48.76 -91.62|America/Bahia -12.98 -38.52|America/Bahia_Banderas 20.8 -105.25|America/Barbados 13.1 -59.62|America/Belem -1.45 -48.48|America/Belize 17.5 -88.2|America/Blanc-Sablon 51.42 -57.12|America/Boa_Vista 2.82 -60.67|America/Bogota 4.6 -74.08|America/Boise 43.61 -116.2|America/Cambridge_Bay 69.11 -105.05|America/Campo_Grande -20.45 -54.62|America/Cancun 21.08 -86.77|America/Caracas 10.5 -66.93|America/Cayenne 4.93 -52.33|America/Cayman 19.3 -81.38|America/Chicago 41.85 -87.65|America/Chihuahua 28.63 -106.08|America/Ciudad_Juarez 31.73 -106.48|America/Costa_Rica 9.93 -84.08|America/Creston 49.1 -116.52|America/Cuiaba -15.58 -56.08|America/Curacao 12.18 -69|America/Danmarkshavn 76.77 -18.67|America/Dawson 64.07 -139.42|America/Dawson_Creek 55.77 -120.23|America/Denver 39.74 -104.98|America/Detroit 42.33 -83.05|America/Dominica 15.3 -61.4|America/Edmonton 53.55 -113.47|America/Eirunepe -6.67 -69.87|America/El_Salvador 13.7 -89.2|America/Fort_Nelson 58.8 -122.7|America/Fortaleza -3.72 -38.5|America/Glace_Bay 46.2 -59.95|America/Goose_Bay 53.33 -60.42|America/Grand_Turk 21.47 -71.13|America/Grenada 12.05 -61.75|America/Guadeloupe 16.23 -61.53|America/Guatemala 14.63 -90.52|America/Guayaquil -2.17 -79.83|America/Guyana 6.8 -58.17|America/Halifax 44.65 -63.6|America/Havana 23.13 -82.37|America/Hermosillo 29.07 -110.97|America/Indiana/Indianapolis 39.77 -86.16|America/Indiana/Knox 41.3 -86.62|America/Indiana/Marengo 38.38 -86.34|America/Indiana/Petersburg 38.49 -87.28|America/Indiana/Tell_City 37.95 -86.76|America/Indiana/Vevay 38.75 -85.07|America/Indiana/Vincennes 38.68 -87.53|America/Indiana/Winamac 41.05 -86.6|America/Inuvik 68.35 -133.72|America/Iqaluit 63.73 -68.47|America/Jamaica 17.97 -76.79|America/Juneau 58.3 -134.42|America/Kentucky/Louisville 38.25 -85.76|America/Kentucky/Monticello 36.83 -84.85|America/Kralendijk 12.15 -68.28|America/La_Paz -16.5 -68.15|America/Lima -12.05 -77.05|America/Los_Angeles 34.05 -118.24|America/Lower_Princes 18.05 -63.05|America/Maceio -9.67 -35.72|America/Managua 12.15 -86.28|America/Manaus -3.13 -60.02|America/Marigot 18.07 -63.08|America/Martinique 14.6 -61.08|America/Matamoros 25.83 -97.5|America/Mazatlan 23.22 -106.42|America/Menominee 45.11 -87.61|America/Merida 20.97 -89.62|America/Metlakatla 55.13 -131.58|America/Mexico_City 19.4 -99.15|America/Miquelon 47.05 -56.33|America/Moncton 46.1 -64.78|America/Monterrey 25.67 -100.32|America/Montevideo -34.91 -56.21|America/Montserrat 16.72 -62.22|America/Nassau 25.08 -77.35|America/New_York 40.71 -74.01|America/Nome 64.5 -165.41|America/Noronha -3.85 -32.42|America/North_Dakota/Beulah 47.26 -101.78|America/North_Dakota/Center 47.12 -101.3|America/North_Dakota/New_Salem 46.84 -101.41|America/Nuuk 64.18 -51.73|America/Ojinaga 29.57 -104.42|America/Panama 8.97 -79.53|America/Paramaribo 5.83 -55.17|America/Phoenix 33.45 -112.07|America/Port-au-Prince 18.53 -72.33|America/Port_of_Spain 10.65 -61.52|America/Porto_Velho -8.77 -63.9|America/Puerto_Rico 18.47 -66.11|America/Punta_Arenas -53.15 -70.92|America/Rankin_Inlet 62.82 -92.08|America/Recife -8.05 -34.9|America/Regina 50.4 -104.65|America/Resolute 74.7 -94.83|America/Rio_Branco -9.97 -67.8|America/Santarem -2.43 -54.87|America/Santiago -33.45 -70.67|America/Santo_Domingo 18.47 -69.9|America/Sao_Paulo -23.53 -46.62|America/Scoresbysund 70.48 -21.97|America/Sitka 57.18 -135.3|America/St_Barthelemy 17.88 -62.85|America/St_Johns 47.57 -52.72|America/St_Kitts 17.3 -62.72|America/St_Lucia 14.02 -61|America/St_Thomas 18.35 -64.93|America/St_Vincent 13.15 -61.23|America/Swift_Current 50.28 -107.83|America/Tegucigalpa 14.1 -87.22|America/Thule 76.57 -68.78|America/Tijuana 32.53 -117.02|America/Toronto 43.65 -79.38|America/Tortola 18.45 -64.62|America/Vancouver 49.27 -123.12|America/Whitehorse 60.72 -135.05|America/Winnipeg 49.88 -97.15|America/Yakutat 59.55 -139.73|Antarctica/Casey -66.28 110.52|Antarctica/Davis -68.58 77.97|Antarctica/DumontDUrville -66.67 140.02|Antarctica/Macquarie -54.5 158.95|Antarctica/Mawson -67.6 62.88|Antarctica/McMurdo -77.83 166.6|Antarctica/Palmer -64.8 -64.1|Antarctica/Rothera -67.57 -68.13|Antarctica/Syowa -69.01 39.59|Antarctica/Troll -72.01 2.53|Antarctica/Vostok -78.4 106.9|Arctic/Longyearbyen 78 16|Asia/Aden 12.75 45.2|Asia/Almaty 43.25 76.95|Asia/Amman 31.95 35.93|Asia/Anadyr 64.75 177.48|Asia/Aqtau 44.52 50.27|Asia/Aqtobe 50.28 57.17|Asia/Ashgabat 37.95 58.38|Asia/Atyrau 47.12 51.93|Asia/Baghdad 33.35 44.42|Asia/Bahrain 26.38 50.58|Asia/Baku 40.38 49.85|Asia/Bangkok 13.75 100.52|Asia/Barnaul 53.37 83.75|Asia/Beirut 33.88 35.5|Asia/Bishkek 42.9 74.6|Asia/Brunei 4.93 114.92|Asia/Chita 52.05 113.47|Asia/Choibalsan 48.07 114.5|Asia/Colombo 6.93 79.85|Asia/Damascus 33.5 36.3|Asia/Dhaka 23.72 90.42|Asia/Dili -8.55 125.58|Asia/Dubai 25.3 55.3|Asia/Dushanbe 38.58 68.8|Asia/Famagusta 35.12 33.95|Asia/Gaza 31.5 34.47|Asia/Hebron 31.53 35.09|Asia/Ho_Chi_Minh 10.75 106.67|Asia/Hong_Kong 22.28 114.15|Asia/Hovd 48.02 91.65|Asia/Irkutsk 52.27 104.33|Asia/Jakarta -6.17 106.8|Asia/Jayapura -2.53 140.7|Asia/Jerusalem 31.78 35.22|Asia/Kabul 34.52 69.2|Asia/Kamchatka 53.02 158.65|Asia/Karachi 24.87 67.05|Asia/Kathmandu 27.72 85.32|Asia/Khandyga 62.66 135.55|Asia/Kolkata 22.53 88.37|Asia/Krasnoyarsk 56.02 92.83|Asia/Kuala_Lumpur 3.17 101.7|Asia/Kuching 1.55 110.33|Asia/Kuwait 29.33 47.98|Asia/Macau 22.2 113.54|Asia/Magadan 59.57 150.8|Asia/Makassar -5.12 119.4|Asia/Manila 14.58 121|Asia/Muscat 23.6 58.58|Asia/Nicosia 35.17 33.37|Asia/Novokuznetsk 53.75 87.12|Asia/Novosibirsk 55.03 82.92|Asia/Omsk 55 73.4|Asia/Oral 51.22 51.35|Asia/Phnom_Penh 11.55 104.92|Asia/Pontianak -0.03 109.33|Asia/Pyongyang 39.02 125.75|Asia/Qatar 25.28 51.53|Asia/Qostanay 53.2 63.62|Asia/Qyzylorda 44.8 65.47|Asia/Riyadh 24.63 46.72|Asia/Sakhalin 46.97 142.7|Asia/Samarkand 39.67 66.8|Asia/Seoul 37.55 126.97|Asia/Shanghai 31.23 121.47|Asia/Singapore 1.28 103.85|Asia/Srednekolymsk 67.47 153.72|Asia/Taipei 25.05 121.5|Asia/Tashkent 41.33 69.3|Asia/Tbilisi 41.72 44.82|Asia/Tehran 35.67 51.43|Asia/Thimphu 27.47 89.65|Asia/Tokyo 35.65 139.74|Asia/Tomsk 56.5 84.97|Asia/Ulaanbaatar 47.92 106.88|Asia/Urumqi 43.8 87.58|Asia/Ust-Nera 64.56 143.23|Asia/Vientiane 17.97 102.6|Asia/Vladivostok 43.17 131.93|Asia/Yakutsk 62 129.67|Asia/Yangon 16.78 96.17|Asia/Yekaterinburg 56.85 60.6|Asia/Yerevan 40.18 44.5|Atlantic/Azores 37.73 -25.67|Atlantic/Bermuda 32.28 -64.77|Atlantic/Canary 28.1 -15.4|Atlantic/Cape_Verde 14.92 -23.52|Atlantic/Faroe 62.02 -6.77|Atlantic/Madeira 32.63 -16.9|Atlantic/Reykjavik 64.15 -21.85|Atlantic/South_Georgia -54.27 -36.53|Atlantic/St_Helena -15.92 -5.7|Atlantic/Stanley -51.7 -57.85|Australia/Adelaide -34.92 138.58|Australia/Brisbane -27.47 153.03|Australia/Broken_Hill -31.95 141.45|Australia/Darwin -12.47 130.83|Australia/Eucla -31.72 128.87|Australia/Hobart -42.88 147.32|Australia/Lindeman -20.27 149|Australia/Lord_Howe -31.55 159.08|Australia/Melbourne -37.82 144.97|Australia/Perth -31.95 115.85|Australia/Sydney -33.87 151.22|Europe/Amsterdam 52.37 4.9|Europe/Andorra 42.5 1.52|Europe/Astrakhan 46.35 48.05|Europe/Athens 37.97 23.72|Europe/Belgrade 44.83 20.5|Europe/Berlin 52.5 13.37|Europe/Bratislava 48.15 17.12|Europe/Brussels 50.83 4.33|Europe/Bucharest 44.43 26.1|Europe/Budapest 47.5 19.08|Europe/Busingen 47.7 8.68|Europe/Chisinau 47 28.83|Europe/Copenhagen 55.67 12.58|Europe/Dublin 53.33 -6.25|Europe/Gibraltar 36.13 -5.35|Europe/Guernsey 49.45 -2.54|Europe/Helsinki 60.17 24.97|Europe/Isle_of_Man 54.15 -4.47|Europe/Istanbul 41.02 28.97|Europe/Jersey 49.18 -2.11|Europe/Kaliningrad 54.72 20.5|Europe/Kirov 58.6 49.65|Europe/Kyiv 50.43 30.52|Europe/Lisbon 38.72 -9.13|Europe/Ljubljana 46.05 14.52|Europe/London 51.51 -0.13|Europe/Luxembourg 49.6 6.15|Europe/Madrid 40.4 -3.68|Europe/Malta 35.9 14.52|Europe/Mariehamn 60.1 19.95|Europe/Minsk 53.9 27.57|Europe/Monaco 43.7 7.38|Europe/Moscow 55.76 37.62|Europe/Oslo 59.92 10.75|Europe/Paris 48.87 2.33|Europe/Podgorica 42.43 19.27|Europe/Prague 50.08 14.43|Europe/Riga 56.95 24.1|Europe/Rome 41.9 12.48|Europe/Samara 53.2 50.15|Europe/San_Marino 43.92 12.47|Europe/Sarajevo 43.87 18.42|Europe/Saratov 51.57 46.03|Europe/Simferopol 44.95 34.1|Europe/Skopje 41.98 21.43|Europe/Sofia 42.68 23.32|Europe/Stockholm 59.33 18.05|Europe/Tallinn 59.42 24.75|Europe/Tirane 41.33 19.83|Europe/Ulyanovsk 54.33 48.4|Europe/Vaduz 47.15 9.52|Europe/Vatican 41.9 12.45|Europe/Vienna 48.22 16.33|Europe/Vilnius 54.68 25.32|Europe/Volgograd 48.73 44.42|Europe/Warsaw 52.25 21|Europe/Zagreb 45.8 15.97|Europe/Zurich 47.38 8.53|Indian/Antananarivo -18.92 47.52|Indian/Chagos -7.33 72.42|Indian/Christmas -10.42 105.72|Indian/Cocos -12.17 96.92|Indian/Comoro -11.68 43.27|Indian/Kerguelen -49.35 70.22|Indian/Mahe -4.67 55.47|Indian/Maldives 4.17 73.5|Indian/Mauritius -20.17 57.5|Indian/Mayotte -12.78 45.23|Indian/Reunion -20.87 55.47|Pacific/Apia -13.83 -171.73|Pacific/Auckland -36.87 174.77|Pacific/Bougainville -6.22 155.57|Pacific/Chatham -43.95 -176.55|Pacific/Chuuk 7.42 151.78|Pacific/Easter -27.15 -109.43|Pacific/Efate -17.67 168.42|Pacific/Fakaofo -9.37 -171.23|Pacific/Fiji -18.13 178.42|Pacific/Funafuti -8.52 179.22|Pacific/Galapagos -0.9 -89.6|Pacific/Gambier -23.13 -134.95|Pacific/Guadalcanal -9.53 160.2|Pacific/Guam 13.47 144.75|Pacific/Honolulu 21.31 -157.86|Pacific/Kanton -2.78 -171.72|Pacific/Kiritimati 1.87 -157.33|Pacific/Kosrae 5.32 162.98|Pacific/Kwajalein 9.08 167.33|Pacific/Majuro 7.15 171.2|Pacific/Marquesas -9 -139.5|Pacific/Midway 28.22 -177.37|Pacific/Nauru -0.52 166.92|Pacific/Niue -19.02 -169.92|Pacific/Norfolk -29.05 167.97|Pacific/Noumea -22.27 166.45|Pacific/Pago_Pago -14.27 -170.7|Pacific/Palau 7.33 134.48|Pacific/Pitcairn -25.07 -130.08|Pacific/Pohnpei 6.97 158.22|Pacific/Port_Moresby -9.5 147.17|Pacific/Rarotonga -21.23 -159.77|Pacific/Saipan 15.2 145.75|Pacific/Tahiti -17.53 -149.57|Pacific/Tarawa 1.42 173|Pacific/Tongatapu -21.13 -175.2|Pacific/Wake 19.28 166.62|Pacific/Wallis -13.3 -176.17";
const TZ_LINKS = "Africa/Asmera>Africa/Nairobi|Africa/Timbuktu>Africa/Abidjan|America/Argentina/ComodRivadavia>America/Argentina/Catamarca|America/Atka>America/Adak|America/Buenos_Aires>America/Argentina/Buenos_Aires|America/Catamarca>America/Argentina/Catamarca|America/Coral_Harbour>America/Panama|America/Cordoba>America/Argentina/Cordoba|America/Ensenada>America/Tijuana|America/Fort_Wayne>America/Indiana/Indianapolis|America/Godthab>America/Nuuk|America/Indianapolis>America/Indiana/Indianapolis|America/Jujuy>America/Argentina/Jujuy|America/Knox_IN>America/Indiana/Knox|America/Louisville>America/Kentucky/Louisville|America/Mendoza>America/Argentina/Mendoza|America/Montreal>America/Toronto|America/Nipigon>America/Toronto|America/Pangnirtung>America/Iqaluit|America/Porto_Acre>America/Rio_Branco|America/Rainy_River>America/Winnipeg|America/Rosario>America/Argentina/Cordoba|America/Santa_Isabel>America/Tijuana|America/Shiprock>America/Denver|America/Thunder_Bay>America/Toronto|America/Virgin>America/Puerto_Rico|America/Yellowknife>America/Edmonton|Antarctica/South_Pole>Pacific/Auckland|Asia/Ashkhabad>Asia/Ashgabat|Asia/Calcutta>Asia/Kolkata|Asia/Chongqing>Asia/Shanghai|Asia/Chungking>Asia/Shanghai|Asia/Dacca>Asia/Dhaka|Asia/Harbin>Asia/Shanghai|Asia/Istanbul>Europe/Istanbul|Asia/Kashgar>Asia/Urumqi|Asia/Katmandu>Asia/Kathmandu|Asia/Macao>Asia/Macau|Asia/Rangoon>Asia/Yangon|Asia/Saigon>Asia/Ho_Chi_Minh|Asia/Tel_Aviv>Asia/Jerusalem|Asia/Thimbu>Asia/Thimphu|Asia/Ujung_Pandang>Asia/Makassar|Asia/Ulan_Bator>Asia/Ulaanbaatar|Atlantic/Faeroe>Atlantic/Faroe|Atlantic/Jan_Mayen>Europe/Berlin|Australia/ACT>Australia/Sydney|Australia/Canberra>Australia/Sydney|Australia/Currie>Australia/Hobart|Australia/LHI>Australia/Lord_Howe|Australia/NSW>Australia/Sydney|Australia/North>Australia/Darwin|Australia/Queensland>Australia/Brisbane|Australia/South>Australia/Adelaide|Australia/Tasmania>Australia/Hobart|Australia/Victoria>Australia/Melbourne|Australia/West>Australia/Perth|Australia/Yancowinna>Australia/Broken_Hill|Brazil/Acre>America/Rio_Branco|Brazil/DeNoronha>America/Noronha|Brazil/East>America/Sao_Paulo|Brazil/West>America/Manaus|Canada/Atlantic>America/Halifax|Canada/Central>America/Winnipeg|Canada/Eastern>America/Toronto|Canada/Mountain>America/Edmonton|Canada/Newfoundland>America/St_Johns|Canada/Pacific>America/Vancouver|Canada/Saskatchewan>America/Regina|Canada/Yukon>America/Whitehorse|Chile/Continental>America/Santiago|Chile/EasterIsland>Pacific/Easter|Cuba>America/Havana|Egypt>Africa/Cairo|Eire>Europe/Dublin|Europe/Belfast>Europe/London|Europe/Kiev>Europe/Kyiv|Europe/Nicosia>Asia/Nicosia|Europe/Tiraspol>Europe/Chisinau|Europe/Uzhgorod>Europe/Kyiv|Europe/Zaporozhye>Europe/Kyiv|GB>Europe/London|GB-Eire>Europe/London|Hongkong>Asia/Hong_Kong|Iceland>Africa/Abidjan|Iran>Asia/Tehran|Israel>Asia/Jerusalem|Jamaica>America/Jamaica|Japan>Asia/Tokyo|Kwajalein>Pacific/Kwajalein|Libya>Africa/Tripoli|Mexico/BajaNorte>America/Tijuana|Mexico/BajaSur>America/Mazatlan|Mexico/General>America/Mexico_City|NZ>Pacific/Auckland|NZ-CHAT>Pacific/Chatham|Navajo>America/Denver|PRC>Asia/Shanghai|Pacific/Enderbury>Pacific/Kanton|Pacific/Johnston>Pacific/Honolulu|Pacific/Ponape>Pacific/Guadalcanal|Pacific/Samoa>Pacific/Pago_Pago|Pacific/Truk>Pacific/Port_Moresby|Pacific/Yap>Pacific/Port_Moresby|Poland>Europe/Warsaw|Portugal>Europe/Lisbon|ROC>Asia/Taipei|ROK>Asia/Seoul|Singapore>Asia/Singapore|Turkey>Europe/Istanbul|US/Alaska>America/Anchorage|US/Aleutian>America/Adak|US/Arizona>America/Phoenix|US/Central>America/Chicago|US/East-Indiana>America/Indiana/Indianapolis|US/Eastern>America/New_York|US/Hawaii>Pacific/Honolulu|US/Indiana-Starke>America/Indiana/Knox|US/Michigan>America/Detroit|US/Mountain>America/Denver|US/Pacific>America/Los_Angeles|US/Samoa>Pacific/Pago_Pago|W-SU>Europe/Moscow";
