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

// How a stored reading is identified when merging: the sensor's own timestamp (element 4; older
// samples have none, and their time IS the sensor's) plus its values. Re-downloads with an updated
// clock correction then replace the earlier copy, and two readings that got the same time after a
// clock set are both kept.
const sampleKey = s => `${s[4] != null ? s[4] : s[0]}|${(+s[1]).toFixed(2)}|${(+s[2]).toFixed(2)}|${s[3]}`;

if (typeof module !== "undefined") module.exports = {
  CFG_NEW_LAYOUT_VER, fmtOffset, parseOffset, faceValue, macStr, toDataView, advEntries, parseAdv, le32,
  DRIFT_TOL, DRIFT_MAX_PER_DAY, driftCorrect, fmtDur, LOG_CAPACITY, logIntervalFromCfg, fmtDays,
  decodeCfg, FLG_BITS, FLG2_BITS, byteFromBits, encodeCfg, fmtNum, toCsv, parseCsv, histId,
  timeTicks, utcOffsetMin, dstChanges, sampleKey, withAtcPrefix, downloadLabel,
};
