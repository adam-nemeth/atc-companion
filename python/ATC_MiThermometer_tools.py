"""
ATC_MiThermometer_tools.py

Tools for a Xiaomi LYWSD03MMC / MHO-C401 / similar sensor running pvvx's
ATC_MiThermometer custom firmware, over BLE, from the command line:

  --scan              find nearby ATC-firmware sensors, live as they're found
                       (optionally --save-sensors; press Enter to stop early)
  --dump               download the recorded temperature/humidity readings to CSV
                       (raw per-import files, plus regenerated aggregate
                       file(s) - see --merge-levels)
  --get-config         read the sensor's live config into a JSON file
  --set-config         write a (possibly edited) config JSON file back to the sensor
  --set-time           set the sensor's clock (UTC unless --time-mode local)
  --delete-log         erase the sensor's log (all its recorded readings)
  --keep-log           (with --dump) only download; by default the sensor's clock
                       is set and its log erased once the whole log is
                       downloaded and saved
  --sensors FILE       run any of the above against a whole list of sensors at
                        once, loaded from a JSON file (see "Batch mode" below)

Run with --help for a full list of examples covering every action, both
single-sensor and batch.

No browser required. Protocol reverse-engineered from pvvx's own sources:
  https://github.com/pvvx/ATC_MiThermometer  (src/cmd_parser.h, src/cmd_parser.c)
  https://github.com/pvvx/pvvx.github.io      (TelinkMiFlasher.html, GraphMemo.html)

All commands go over one GATT characteristic:
  - GATT service        0x1F10
  - GATT characteristic  0x1F1F  (write commands + receive notifications)

Command IDs used here (see src/cmd_parser.h CMD_ID_KEYS):
  0x35  CMD_ID_LOGGER  - read memory measures (--dump)
  0x36  CMD_ID_CLRLOG  - delete memory measures (--delete-log, and --dump unless --keep-log),
                          requires the magic confirmation bytes 0x12 0x34 as a
                          safety check
  0x55  CMD_ID_CFG     - get/set sensor config (--get-config / --set-config)
  0x23  CMD_ID_UTC_TIME- get/set sensor clock (used internally by --dump - see
                          below - and by --set-time)

NOTE ON BLE NOTIFICATION TIMING: right after subscribing to notifications,
some BLE stacks (notably Windows) need a moment before they reliably
deliver a notification for a command sent immediately after - the very
first reply can otherwise get silently dropped, which shows up as a
timeout. pvvx's own web tools work around this by sending a harmless
"get config" request and pausing briefly before sending the command they
actually care about; every command in this script does the same.

NOTE ON --timeout: it's an IDLE timeout, not a fixed overall deadline. The
clock only starts counting from the last message sent or received on the
BLE link, and resets on every one (including --dump's many samples as
they stream in); it only actually fires when the sensor goes quiet for
that long. So a large --dump won't get cut off partway just because the
whole transfer takes longer than --timeout - only if the sensor genuinely
stalls with no new data for that long.

NOTE ON SETTING THE CLOCK AND ERASING (--keep-log): by default, once a
--dump has downloaded the whole log and saved it to its CSV file, this
script sets the sensor's clock and then erases its log, reusing the SAME
already-open connection. Always both or neither, like the iPhone app:
the new log then starts with a correct clock. If setting the clock fails,
nothing is erased. Neither is done after an interrupted download, a partial
one (--count), an empty one, or one with gaps: the firmware numbers the
readings 1, 2, 3... (src/ble.c: send_memo_blk()), so readings that got lost
on the way are noticed. Pass --keep-log to only download.

NOTE ON CLOCK DRIFT (--no-drift-correction): a sensor's clock can gain or
lose time steadily (how much, and whether at all, is still being measured
on these sensors). --dump therefore reads
the sensor clock (0x23) before downloading and corrects the timestamps:
  - every clock set is visible in the log as a step that isn't one
    interval (the sample after it jumps by interval - error);
  - between two sets the error grows linearly from 0, so each stretch is
    shifted linearly; the stretch still running ends at the error just read;
  - clock sets made by this tool are also recorded in clock_log.json (per
    address), which pins down sets whose step is ambiguous;
  - a step bigger than drift could cause is a clock jump, left alone.
The CSV 'timestamp' is the corrected time; 'sensor_timestamp' keeps the
sensor's own time. Merging identifies a reading by sensor time + values, so
a later download with an updated correction replaces the earlier copy. The
iPhone app (webapp/index.html, driftCorrect()) does exactly the same.

--- Log transfer (0x35) ---
  Write 0x35 <cnt_lo> <cnt_hi> 0x00 0x00 -> sensor streams back samples as
  notifications (0xFFFF = "give me all of them").
  Each sample notification (13 bytes):
        byte 0      : 0x35 (block id)
        bytes 1-2   : running index          (uint16, little-endian)
        bytes 3-6   : unix timestamp          (uint32, little-endian)
        bytes 7-8   : temperature * 100       (int16,  little-endian)
        bytes 9-10  : humidity * 100          (uint16, little-endian)
        bytes 11-12 : battery voltage in mV   (uint16, little-endian)
  A short trailing 0x35 packet signals "transfer done" - this alone is
  enough to know the transfer finished (see NOTE ON THE POST-DUMP CLOCK
  SYNC above for what optionally happens next).

--- Clock (0x23) and --time-mode (default: utc) ---
  This firmware has no timezone concept - the epoch value you write is
  just displayed/logged verbatim. Two conventions exist for what to put
  in it, chosen with --time-mode (default 'utc', matching the iPhone app):
    "local" (matches pvvx's own web tools/GraphMemo.html):
        write (true UTC epoch + your local UTC offset), i.e. "local
        wall-clock time packed into a UTC-shaped field". Recorded sample
        timestamps are then already your local time as-is.
    "utc":
        write the true UTC epoch. Recorded sample timestamps are then
        kept as UTC too.
  Every CSV row also gets a 'utc_offset' column (e.g. '+02:00' or
  '+00:00') recording which of the above was in effect - NOT queried from
  the sensor (the sensor has no timezone; --dump reads its clock only to
  measure drift, see NOTE ON CLOCK DRIFT); it's simply what --time-mode implies: '+00:00' for 'utc', or this
  computer's own current UTC offset for 'local'. This is what lets
  --merge-tz correctly combine files recorded under different offsets
  later (e.g. across a DST change, or a switch between --time-mode
  values) without needing to re-derive anything from the sensor. Pick one
  --time-mode convention and stick with it for a given sensor; 'utc' is
  the default when --time-mode is omitted. Whichever mode is used, the current time is read from this
  computer immediately before it's sent to the sensor (not earlier in the
  connection), so it isn't stale by the time it's written.

--- Config (0x55) ---
  Write 0x55                                   -> sensor replies with its
                                                   current config (below)
  Write 0x55 <flg><flg2><temp_off><humi_off><adv_int><meas_int><rf_tx>
             <conn_lat>[<lcd_tint>[<hw_ver><av_meas_mem>]]
                                                -> sets config; sensor saves
                                                   to flash and replies with
                                                   the new config (same
                                                   format as a plain get)
  The firmware just memcpy()s whatever you send directly onto its config
  struct (src/cmd_parser.c), so the write is a straight byte-for-byte
  round trip of what a get returns (minus the read-only version byte).

--- Erase log (0x36) ---
  Write 0x36 0x12 0x34   (the 0x12 0x34 is a hard-coded confirmation
  value the firmware checks for - see src/cmd_parser.c - so a bare 0x36
  by itself does nothing).

Requirements:
    pip install bleak

Batch mode (multiple sensors):
  Put your sensors in a JSON file (--scan --save-sensors writes exactly
  this format, with "description" left blank for you to fill in, e.g. where
  the sensor is):

      [
        {"name": "ATC_a1b2c3", "description": "living_room", "address": "AA:BB:CC:DD:EE:01"},
        {"name": "ATC_d4e5f6", "description": "bedroom",     "address": "AA:BB:CC:DD:EE:02"},
        {"name": "ATC_a7b8c9", "description": "",            "address": "AA:BB:CC:DD:EE:03"}
      ]

  "name" is optional (falls back to the address if missing). "description"
  is optional too; when set, it comes first in every output filename,
  joined to "name" with a hyphen - when it's empty, just "name" is used on
  its own (see device_label() below). {"sensors": [...]} with the same list
  also works.

File names (batch mode), description first so files sort by description:
      <Description>-<ATC_name>-raw-<YYYYMMDD_HHMMSS>.csv   one per download
      <Description>-<ATC_name>-all.csv                     merged (also -daily-/-monthly-/-yearly-)
      <Description>-<ATC_name>-config.json                 --get-config / --set-config
  Spaces and hyphens inside a description become underscores. Older names
  (history_<name>__<description>_raw_<stamp>.csv etc.) are still read when
  merging, and per-sensor config_<name>_<description>.json files are still
  found by --set-config; rename_to_new_names.py converts old files.

  Then pass --sensors and use any action WITHOUT an address to run it
  against every sensor in the file, one at a time, continuing past any
  single sensor's failure and printing a summary at the end. See --help
  for a full worked example of every action in both single-sensor and
  batch form.
"""

import argparse
import asyncio
import csv
import glob
import json
import re
import struct
import sys
import threading
import time
from datetime import datetime, timedelta, timezone as dt_timezone
from pathlib import Path

from bleak import BleakClient, BleakScanner

SERVICE_UUID = "00001f10-0000-1000-8000-00805f9b34fb"
CHAR_UUID = "00001f1f-0000-1000-8000-00805f9b34fb"

CFG_NEW_TEMP_HUMI_LAYOUT_VER = 0x47  # firmware ver from which temp/humi offset
                                      # bytes are repurposed for adv timing

DEFAULT_TIMEOUT = 30.0
DEFAULT_SCAN_TIMEOUT = 60.0

DEVICE_NAME_PREFIXES = ("ATC_", "LYWSD", "MHO", "CGG", "MJWSD")


# ==========================================================================
# Logging - every printed status line gets a timestamp (with UTC offset)
# ==========================================================================

def _utc_offset_str(dt: datetime) -> str:
    offset = dt.utcoffset()
    if offset is None:
        return ""
    return f"UTC{format_offset_seconds(offset.total_seconds())}"


def log(msg: str = ""):
    now = datetime.now().astimezone()
    print(f"[{now.strftime('%Y-%m-%d %H:%M:%S')} {_utc_offset_str(now)}] {msg}")


# ==========================================================================
# CSV formatting helpers
# ==========================================================================

# 'timestamp' is drift-corrected (see drift_correct()); 'sensor_timestamp' is the sensor's own,
# uncorrected time for the same reading (same utc_offset), empty when unknown or identical.
CSV_HEADER = ["timestamp", "utc_offset", "temperature_c", "humidity_pct", "battery_mv", "sensor_timestamp"]


def format_offset_seconds(offset_seconds: float) -> str:
    total_minutes = int(round(offset_seconds / 60))
    sign = "+" if total_minutes >= 0 else "-"
    hh, mm = divmod(abs(total_minutes), 60)
    return f"{sign}{hh:02d}:{mm:02d}"


def parse_offset_str(s: str) -> int:
    """Inverse of format_offset_seconds(); returns seconds. Falls back to 0
    (UTC) for anything unparseable rather than raising, since this is only
    ever used to interpret an informational column."""
    if not s:
        return 0
    try:
        sign = -1 if s.startswith("-") else 1
        hh, mm = s.lstrip("+-").split(":")
        return sign * (int(hh) * 60 + int(mm)) * 60
    except (ValueError, IndexError):
        return 0


def dump_utc_offset(time_mode: str) -> str:
    """The offset recorded in every row of a dump's CSV, in the 'utc_offset'
    column - NOT queried from the sensor (the sensor isn't asked for its
    clock or timezone at dump start); it's simply what --time-mode implies:
    '+00:00' for 'utc', or this computer's own current UTC offset for
    'local' (the same offset device_epoch_now() itself uses when writing
    'local'-mode epochs to the sensor)."""
    if time_mode == "utc":
        return "+00:00"
    return format_offset_seconds(_local_utc_offset_seconds())


def fmt_num(value: float, locale: str) -> str:
    s = f"{value:.2f}"
    return s.replace(".", ",") if locale == "hu" else s


def write_csv(path: Path, rows, locale: str):
    """rows: iterable of (timestamp_str, temp_c, humidity_pct, battery_mv, utc_offset_str
    [, sensor_timestamp_str]) - that's the internal convention used throughout this script; the
    actual file column order (see CSV_HEADER) puts utc_offset right after
    timestamp, independent of this tuple's order."""
    delimiter = ";" if locale == "hu" else ","
    with open(path, "w", newline="") as f:
        w = csv.writer(f, delimiter=delimiter)
        w.writerow(CSV_HEADER)
        for row in rows:
            ts, tm, hm, vb, off = row[:5]
            sensor_ts = row[5] if len(row) > 5 and row[5] and row[5] != ts else ""
            w.writerow([ts, off, fmt_num(tm, locale), fmt_num(hm, locale), vb, sensor_ts])


def detect_locale(header_line: str) -> str:
    return "hu" if ";" in header_line else "en"


def read_csv_file(path: Path):
    """Returns (rows, locale) where rows are
    (timestamp_str, temp_c, humidity_pct, battery_mv, utc_offset_str, sensor_timestamp_str or None) - see
    write_csv() for why that tuple order differs from the file's column
    order. Columns are looked up by header name (not fixed position), so
    this tolerates any column order, including older files from before the
    utc_offset column existed (offset defaults to '+00:00' for those)."""
    rows = []
    with open(path, "r", newline="") as f:
        first_line = f.readline()
        loc = detect_locale(first_line)
        delim = ";" if loc == "hu" else ","
        f.seek(0)
        reader = csv.reader(f, delimiter=delim)
        header = [h.strip().lower() for h in (next(reader, None) or [])]

        def col_index(*names, default=None):
            for n in names:
                if n in header:
                    return header.index(n)
            return default

        ts_idx = col_index("timestamp", "utc_timestamp", "local_timestamp", default=0)
        off_idx = col_index("utc_offset")
        tm_idx = col_index("temperature_c", default=1)
        hm_idx = col_index("humidity_pct", default=2)
        vb_idx = col_index("battery_mv", default=3)
        st_idx = col_index("sensor_timestamp")
        needed = [i for i in (ts_idx, tm_idx, hm_idx, vb_idx) if i is not None]

        for row in reader:
            if not needed or len(row) <= max(needed):
                continue
            ts, tm, hm, vb = row[ts_idx], row[tm_idx], row[hm_idx], row[vb_idx]
            off = row[off_idx] if off_idx is not None and off_idx < len(row) else "+00:00"
            sensor_ts = row[st_idx].strip() if st_idx is not None and st_idx < len(row) else ""
            if loc == "hu":
                tm = tm.replace(",", ".")
                hm = hm.replace(",", ".")
            try:
                rows.append((ts, float(tm), float(hm), int(vb), off, sensor_ts or None))
            except ValueError:
                continue
    return rows, loc


def resolve_merge_tz(spec: str):
    """Resolves a --merge-tz spec into a tzinfo used ONLY to decide where
    daily/monthly/yearly bucket boundaries fall (see merge_history()) - it
    no longer affects the VALUES written to any aggregate file, which are
    always true UTC. None/'source'/'utc' = bucket by UTC calendar
    boundaries (the default - with no city specified, UTC is the
    reference). 'local' = this computer's CURRENT local UTC offset, a
    fixed-offset approximation (does NOT account for DST changes at other
    points in the year). Anything else is looked up as an IANA zone name
    via zoneinfo, e.g. 'Europe/Budapest' - the DST-correct option: a named
    city/region's actual calendar rules decide the cut, so e.g. a 'daily'
    bucket spans that city's real midnight-to-midnight even on a day that
    includes a DST transition (may need 'pip install tzdata' on Windows,
    where the OS doesn't ship the IANA timezone database itself)."""
    if spec is None or spec in ("source", "utc"):
        return dt_timezone.utc
    if spec == "local":
        return datetime.now().astimezone().tzinfo
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(spec)
    except Exception as e:
        raise ValueError(
            f"Unrecognized timezone '{spec}': {e}. Use 'source' or 'utc' (default - "
            f"bucket by UTC calendar boundaries), 'local' (this computer's current "
            f"UTC offset, DST-approximate), or an IANA zone name like "
            f"'Europe/Budapest' (DST-correct; may need: pip install tzdata)."
        )


RAW_STEM_RE = re.compile(r"[-_]raw[-_]\d{8}_\d{6}$")
SENSOR_ID_RE = re.compile(r"ATC_[0-9A-Fa-f]{6}(?![0-9A-Za-z])")


def find_raw_files(directory: Path, base: str):
    """All raw per-download CSVs belonging to one sensor: '<base>-raw-*.csv'
    (current naming), '<base>_raw_*.csv' (older naming), and - when <base>
    contains the sensor's ATC_xxxxxx name - any raw file in the directory for
    that same sensor under another description or the old
    'history_<name>__<description>_raw_*' naming, so renaming a description
    never splits a sensor's readings."""
    files = {Path(p) for p in glob.glob(str(directory / f"{glob.escape(base)}-raw-*.csv"))}
    files |= {Path(p) for p in glob.glob(str(directory / f"{glob.escape(base)}_raw_*.csv"))}
    m = SENSOR_ID_RE.search(base)
    if m:
        sid = m.group(0).upper()
        for p in directory.glob("*.csv"):
            ids = [x.upper() for x in SENSOR_ID_RE.findall(p.stem)]
            if sid in ids and RAW_STEM_RE.search(p.stem):
                files.add(p)
    return sorted(files)


ALL_STEM_RE = re.compile(r"[-_]all$")


def find_existing_all_files(directory: Path, base: str):
    """Existing merged '<base>-all.csv' (and, when <base> contains the
    sensor's ATC_xxxxxx name, any other '-all' / old '_all' file for that
    sensor). merge_history() reads these too, so a merged file that holds
    readings with no raw file behind them - e.g. one shared from the phone
    app and saved here - is extended instead of being overwritten."""
    files = {directory / f"{base}-all.csv", directory / f"{base}_all.csv"}
    m = SENSOR_ID_RE.search(base)
    if m:
        sid = m.group(0).upper()
        for p in directory.glob("*.csv"):
            ids = [x.upper() for x in SENSOR_ID_RE.findall(p.stem)]
            if sid in ids and ALL_STEM_RE.search(p.stem):
                files.add(p)
    return sorted(p for p in files if p.exists())


def merge_history(prefix: str, out_locale: str, merge_tz: str = "source",
                   levels=("all",)):
    """Merge all raw files ('<prefix>-raw-*.csv', see find_raw_files()) for one sensor into aggregate
    file(s), de-duplicated by true instant, correctly parsing whichever
    locale each raw file happens to be in.

    Every aggregate file this writes always stores true UTC timestamps
    (utc_offset column is always '+00:00') - this keeps them continuous
    and unambiguous regardless of any DST transition, safe to combine
    files recorded under different --time-mode conventions, and simple
    for a visualizer to plot directly without needing its own timezone
    handling for correctness.

    merge_tz (see resolve_merge_tz()) does NOT change those stored values
    - it only decides where the calendar day/month/year CUTS fall for the
    'daily'/'monthly'/'yearly' levels below. Passing an IANA city name
    means those cuts fall at that city's real local midnight/month-
    start/year-start (DST-correct); the default uses UTC's boundaries.

    levels: which aggregate file(s) to (re)generate, any subset of:
      'all'     -> <prefix>-all.csv                  (everything, deduped/sorted)
      'daily'   -> <prefix>-daily-<YYYYMMDD>.csv      (one per calendar day)
      'monthly' -> <prefix>-monthly-<YYYYMM>.csv      (one per calendar month)
      'yearly'  -> <prefix>-yearly-<YYYY>.csv         (one per calendar year)
    All are safe to regenerate every run - each is rebuilt fresh from
    every raw file currently on disk, so nothing is lost if you
    delete an aggregate file and re-run.

    Returns (written, locales_seen, file_count): written is a dict with
    keys 'all' -> (path, count) or None, and 'daily'/'monthly'/'yearly' ->
    a list of (path, count) tuples, one per bucket actually written."""
    prefix_path = Path(prefix)
    directory = prefix_path.parent if str(prefix_path.parent) else Path(".")
    base = prefix_path.name

    files = find_raw_files(directory, base)
    if not files:
        return {"all": None, "daily": [], "monthly": [], "yearly": []}, set(), 0
    # Existing merged files are inputs too (read before anything is rewritten), so readings that
    # exist only there are kept; duplicates collapse on the timestamp below.
    previous_all = find_existing_all_files(directory, base)

    bucket_tz = resolve_merge_tz(merge_tz)

    # One entry per READING, identified by the sensor's own timestamp (older files without a
    # sensor_timestamp column hold uncorrected sensor times, so their timestamp IS that) plus its
    # values. A later download with an updated drift correction replaces the earlier copy, and two
    # readings that ended up with the same time after a clock set are both kept.
    merged = {}  # (sensor UTC string, tm, hm, vb) -> (true-UTC timestamp string, tm, hm, vb, bucket_dt, sensor UTC string)
    locales_seen = set()

    def to_utc(ts, off):
        naive_dt = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")
        src_tz = dt_timezone(timedelta(seconds=parse_offset_str(off)))
        return naive_dt.replace(tzinfo=src_tz).astimezone(dt_timezone.utc)

    for fp in previous_all + files:  # raw files last (in time order), so the newest download wins
        rows, loc = read_csv_file(fp)
        locales_seen.add(loc)
        for ts, tm, hm, vb, off, sensor_ts in rows:
            try:
                true_utc = to_utc(ts, off)
                sensor_utc = to_utc(sensor_ts, off) if sensor_ts else true_utc
            except (ValueError, TypeError):
                continue  # unparseable - skip rather than store a bad timestamp
            out_ts = true_utc.replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S")
            sensor_out = sensor_utc.replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S")
            bucket_dt = true_utc.astimezone(bucket_tz)
            merged[(sensor_out, f"{tm:.2f}", f"{hm:.2f}", vb)] = (out_ts, tm, hm, vb, bucket_dt, sensor_out)

    sorted_items = sorted(merged.values(), key=lambda v: (v[0], v[5]))
    written = {"all": None, "daily": [], "monthly": [], "yearly": []}

    if "all" in levels and sorted_items:
        path = directory / f"{base}-all.csv"
        rows_all = [(ts, tm, hm, vb, "+00:00", st) for ts, tm, hm, vb, _bucket, st in sorted_items]
        write_csv(path, rows_all, out_locale)
        written["all"] = (path, len(rows_all))

    def write_buckets(level_name, key_fmt, path_fmt):
        buckets = {}
        for ts, tm, hm, vb, bucket_dt, st in sorted_items:
            key = bucket_dt.strftime(key_fmt)
            buckets.setdefault(key, []).append((ts, tm, hm, vb, "+00:00", st))
        for key, bucket_rows in sorted(buckets.items()):
            path = directory / path_fmt.format(base=base, key=key)
            write_csv(path, bucket_rows, out_locale)
            written[level_name].append((path, len(bucket_rows)))

    if "daily" in levels:
        write_buckets("daily", "%Y%m%d", "{base}-daily-{key}.csv")
    if "monthly" in levels:
        write_buckets("monthly", "%Y%m", "{base}-monthly-{key}.csv")
    if "yearly" in levels:
        write_buckets("yearly", "%Y", "{base}-yearly-{key}.csv")

    return written, locales_seen, len(files)


# ==========================================================================
# Clock conventions (--time-mode)
# ==========================================================================

def _local_utc_offset_seconds() -> float:
    return (datetime.now() - datetime.utcnow()).total_seconds()


def device_epoch_now(time_mode: str) -> int:
    """The epoch value to write to the sensor's clock right now. Call this
    immediately before the write, not earlier in the connection, so the
    value isn't stale by the time it's actually sent."""
    if time_mode == "utc":
        return int(time.time())
    return int(time.time() + _local_utc_offset_seconds())  # "local" / pvvx convention


def device_epoch_as_datetime(raw_epoch: int) -> datetime:
    """Every convention this script writes packs its value directly into the
    epoch field at face value - 'local' mode's raw value already IS local
    wall-clock time, 'utc' mode's raw value already IS true UTC. Neither
    needs conversion to interpret it back: just read it at face value with
    utcfromtimestamp() (i.e. treat the number's calendar fields as-is,
    without shifting through the system's local timezone). Only the label
    describing which convention it's in differs (see time_mode_label() /
    csv_timestamp_label()).

    (Previously this used datetime.fromtimestamp() for 'utc' mode display
    messages, which silently converted through the system's local timezone
    before printing - correct in value, but then mislabeled '[UTC]', which
    was misleading on any machine not itself set to UTC. Fixed.)"""
    return datetime.utcfromtimestamp(raw_epoch)


# ==========================================================================
# Clock drift correction (same algorithm as driftCorrect() in webapp/index.html - keep in step)
# ==========================================================================
# A sensor's clock can gain or lose time steadily (how much, and whether at all, is still being
# measured). The sensor doesn't remember when its clock was set, but every clock set
# shows up in the log: the sample after it jumps by (interval - error). Between two sets the error
# grows linearly from 0, so each stretch between sets is corrected linearly. For the stretch still
# running, the error is measured by reading the clock (0x23) before the download.

DRIFT_TOL = 20            # s: steps this close to one interval are normal jitter
DRIFT_MAX_PER_DAY = 150   # s/day: more than this is a clock jump, not drift - left alone
CLOCK_LOG = Path("clock_log.json")  # clock sets this tool made, per sensor address


def drift_correct(ts, now_sensor=None, now_true=None, sets=(), rate=None):
    """ts: sensor times (face values) in LOG order. sets: [{'before', 'at'}] recorded clock sets
    (sensor time just before, time written). rate: last known drift (s per s) or None.
    Returns (corrected list in the same order, stretches list of dicts, note)."""
    n = len(ts)
    corr = list(ts)
    stretches = []
    if not n:
        return corr, stretches, ""
    if min(ts) < 1577836800:
        return corr, stretches, "sensor clock was reset (dates before 2020) - not corrected"
    diffs = sorted(d for d in (ts[k] - ts[k - 1] for k in range(1, n)) if 30 <= d <= 7200)
    P = diffs[len(diffs) // 2] if diffs else 600
    ev = []  # dicts: k (first sample after the set), d (step), E (error at the set), known
    for k in range(1, n):
        d = ts[k] - ts[k - 1]
        rec = next((r for r in sets if ts[k - 1] - 5 <= r["before"] <= ts[k - 1] + 2 * P + 300
                    and ts[k] - 2 * P - 300 <= r["at"] <= ts[k] + 5), None)
        if rec:
            ev.append({"k": k, "d": d, "E": rec["before"] - rec["at"], "known": True})
            continue
        if abs(d - P) <= DRIFT_TOL:
            continue
        m = max(1, round(d / P))
        if m > 1 and abs(m * P - d) <= DRIFT_TOL:
            continue  # samples missed while connected, no clock change
        ev.append({"k": k, "d": d, "E": P - d, "known": False})

    def bounds():
        out, a = [], 0
        for e in ev:
            out.append((a, e["k"] - 1, e))
            a = e["k"]
        out.append((a, n - 1, None))
        return out

    # A step can also hide skipped samples: pick the count that fits the typical drift rate.
    rates = [e["E"] / (ts[b] - ts[a]) for a, b, e in bounds() if e and ts[b] - ts[a] > 86400]
    if rate is not None:
        rates.append(rate)
    if rates:
        typical = sorted(rates)[len(rates) // 2]
        for a, b, e in bounds():
            if e and not e["known"]:
                m = max(1, round((e["d"] + typical * (ts[b] - ts[a])) / P))
                e["E"] = m * P - e["d"]

    for a, b, e in bounds():
        s0 = ts[a]
        if a == 0:
            recs = [r for r in sets if ts[0] - 2 * P - 300 <= r["at"] <= ts[0] + 5]
            if recs:
                s0 = recs[-1]["at"]
        if e:
            te, E = ts[b], e["E"]
        elif now_sensor is not None and now_true is not None:
            te, E = now_sensor, now_sensor - now_true
        else:
            stretches.append({"from": ts[a], "to": ts[b], "n": b - a + 1, "E": None, "applied": False,
                              "why": "clock not read"})
            continue
        span = te - s0
        per_day = E / span * 86400 if span > 0 else 0.0
        st = {"from": ts[a], "to": ts[b], "n": b - a + 1, "E": E, "per_day": per_day, "applied": False}
        if span <= 0 or abs(E) <= 2:  # whole-second clock + ~1 s read uncertainty
            st["why"] = "no drift (within 2 s)"
        elif abs(E) > DRIFT_TOL + DRIFT_MAX_PER_DAY * span / 86400:
            st["why"] = "jump, not drift - not corrected"
        else:
            for i in range(a, b + 1):
                corr[i] = ts[i] - E * max(0, ts[i] - s0) / span
            st["applied"] = True
        stretches.append(st)
    return corr, stretches, ""


def load_clock_log(address: str) -> dict:
    try:
        return json.loads(CLOCK_LOG.read_text()).get(address.upper(), {"sets": [], "rate": None})
    except (OSError, ValueError):
        return {"sets": [], "rate": None}


def save_clock_log(address: str, new_set=None, rate=None):
    try:
        data = json.loads(CLOCK_LOG.read_text()) if CLOCK_LOG.exists() else {}
    except (OSError, ValueError):
        data = {}
    cur = data.get(address.upper(), {"sets": [], "rate": None})
    if new_set:
        cur["sets"] = (cur.get("sets", []) + [new_set])[-40:]
    if rate is not None:
        cur["rate"] = rate
    data[address.upper()] = cur
    try:
        CLOCK_LOG.write_text(json.dumps(data, indent=1))
    except OSError as e:
        log(f"(non-fatal) couldn't save {CLOCK_LOG}: {e}")


def fmt_dur(s: float) -> str:
    a = abs(round(s))
    if a >= 3600:
        return f"{a // 3600} h {round(a % 3600 / 60)} min"
    return f"{a // 60} min {a % 60} s" if a >= 60 else f"{a} s"


def drift_summary(stretches, note: str) -> str:
    if note:
        return note
    applied = [s for s in stretches if s["applied"]]
    if not applied:
        if stretches and stretches[-1].get("why") == "clock not read":
            return "clock not read - times not corrected"
        return "clock correct (within 2 s)"
    last = applied[-1]
    since = device_epoch_as_datetime(int(last["from"])).strftime("%Y-%m-%d %H:%M")
    # A rate only means something over a day or more (1 s in an hour would read as 24 s/day).
    span = last["E"] / last["per_day"] * 86400 if last["per_day"] else 0
    rate = f"{abs(last['per_day']):.0f} s/day " if span >= 86400 else ""
    txt = (f"clock was {fmt_dur(last['E'])} {'fast' if last['E'] > 0 else 'slow'} "
           f"({rate}since {since})")
    if len(applied) > 1:
        txt += f"; {len(applied)} stretches between clock sets corrected"
    return txt + f" - {sum(s['n'] for s in applied)} readings corrected"


async def read_device_clock(client, clock_reply: dict, clock_event: asyncio.Event, activity=None):
    """Asks for the sensor clock (0x23). Returns (sensor_epoch, computer_epoch) - the computer time
    taken half-way through the request to cancel the BLE delay - or None. The notify handler must
    put the 0x23 reply's epoch into clock_reply['epoch'] and set clock_event."""
    clock_event.clear()
    t0 = time.monotonic()
    await client.write_gatt_char(CHAR_UUID, bytes([0x23]))
    if activity:
        activity.touch()
    try:
        await asyncio.wait_for(clock_event.wait(), timeout=8)
    except asyncio.TimeoutError:
        return None
    rtt = time.monotonic() - t0
    return clock_reply["epoch"], time.time() - rtt / 2


def time_mode_label(time_mode: str) -> str:
    return "UTC" if time_mode == "utc" else "local (pvvx convention)"


# ==========================================================================
# Config (CMD_ID_CFG 0x55) - decode / encode
# ==========================================================================

def decode_cfg(data: bytes) -> dict:
    """data includes the leading 0x55 block id byte."""
    length = len(data) - 1
    if length < 9:
        raise ValueError(f"Config response too short ({length} bytes after block id)")

    ver = data[1]
    flg = data[2]
    flg2 = data[3]
    temp_offset_byte = data[4]
    humi_offset_byte = data[5]
    adv_int_raw = data[6]
    meas_int_raw = data[7]
    rf_tx_raw = data[8]
    conn_lat_raw = data[9]
    lcd_tint_raw = data[10] if length >= 10 else None
    hver_raw = data[11] if length >= 11 else None
    av_meas_mem_raw = data[12] if length >= 12 else None

    cfg = {
        "_note": (
            "Raw sensor config (CMD_ID_CFG 0x55). Fields ending '_raw', and the "
            "bit fields under flg/flg2, are what --set-config writes back. "
            "Fields ending '_info' or under 'device_info' are read-only / "
            "computed for convenience and are ignored on write. Bits labelled "
            "'hardware_specific' mean different things on different screen/model "
            "variants of this firmware - leave them alone unless you know what "
            "your specific sensor does with them."
        ),
        "device_info": {
            "protocol_version_raw": ver,
            "protocol_version_str": f"{ver >> 4}.{ver & 0x0F}",
        },
        "flg": {
            "raw": flg,
            "bits": {
                "advertising_type": flg & 0x03,  # 0=ATC1441 1=Custom(pvvx) 2=Mi 3=BTHome
                "comfort_smiley": bool(flg & 0x04),
                "hardware_specific_bit3": bool(flg & 0x08),
                "temperature_unit_fahrenheit": bool(flg & 0x10),
                "hardware_specific_bit5": bool(flg & 0x20),
                "tx_measures_when_connected": bool(flg & 0x40),
                "low_power_measurements": bool(flg & 0x80),
            },
        },
        "flg2": {
            "raw": flg2,
            "bits": {
                "smiley_or_screen_type": flg2 & 0x07,
                "adv_crypto": bool(flg2 & 0x08),
                "adv_flags": bool(flg2 & 0x10),
                "bt5_phy": bool(flg2 & 0x20),
                "long_range": bool(flg2 & 0x40),
                "screen_off": bool(flg2 & 0x80),
            },
        },
        "advertising_interval_raw": adv_int_raw,
        "advertising_interval_ms_info": round(adv_int_raw * 62.5, 1),
        "measure_interval_raw": meas_int_raw,
        "rf_tx_power_raw": rf_tx_raw,
        "connect_latency_raw": conn_lat_raw,
        "connect_latency_ms_info": (conn_lat_raw + 1) * 20,
    }

    if lcd_tint_raw is not None:
        cfg["lcd_tint_raw"] = lcd_tint_raw
        cfg["lcd_tint_seconds_info"] = round(lcd_tint_raw * 0.05, 2)
    if hver_raw is not None:
        cfg["hw_ver_raw"] = hver_raw
    if av_meas_mem_raw is not None:
        cfg["av_meas_mem_raw"] = av_meas_mem_raw

    if ver < CFG_NEW_TEMP_HUMI_LAYOUT_VER:
        signed_temp = struct.unpack("b", bytes([temp_offset_byte]))[0]
        signed_humi = struct.unpack("b", bytes([humi_offset_byte]))[0]
        cfg["temp_offset_raw"] = signed_temp
        cfg["temp_offset_c_info"] = round(signed_temp / 10.0, 1)
        cfg["humi_offset_raw"] = signed_humi
        cfg["humi_offset_pct_info"] = round(signed_humi / 10.0, 1)
    else:
        # repurposed on newer firmware: adv timing / date-display flags
        cfg["temp_offset_raw"] = temp_offset_byte
        cfg["adv_interval_delay_raw_info"] = temp_offset_byte & 0x0F
        cfg["date_display_ddmm_info"] = bool(temp_offset_byte & 0x40)
        cfg["day_of_week_flag_info"] = bool(temp_offset_byte & 0x80)
        cfg["humi_offset_raw"] = humi_offset_byte  # repurposed: event_adv_cnt
        cfg["event_adv_cnt_info"] = humi_offset_byte

    return cfg


def _byte_from_bits(obj, bit_map, raw_key="raw"):
    """bit_map: list of (json_key, mask, is_multibit) in bit order."""
    if "bits" in obj:
        b = obj["bits"]
        val = 0
        for key, mask, is_multibit in bit_map:
            if is_multibit:
                val |= int(b[key]) & mask
            elif b.get(key):
                val |= mask
        return val
    return int(obj[raw_key])


def encode_cfg(cfg: dict) -> bytes:
    flg = _byte_from_bits(cfg["flg"], [
        ("advertising_type", 0x03, True),
        ("comfort_smiley", 0x04, False),
        ("hardware_specific_bit3", 0x08, False),
        ("temperature_unit_fahrenheit", 0x10, False),
        ("hardware_specific_bit5", 0x20, False),
        ("tx_measures_when_connected", 0x40, False),
        ("low_power_measurements", 0x80, False),
    ])
    flg2 = _byte_from_bits(cfg["flg2"], [
        ("smiley_or_screen_type", 0x07, True),
        ("adv_crypto", 0x08, False),
        ("adv_flags", 0x10, False),
        ("bt5_phy", 0x20, False),
        ("long_range", 0x40, False),
        ("screen_off", 0x80, False),
    ])
    temp_offset = int(cfg["temp_offset_raw"]) & 0xFF
    humi_offset = int(cfg["humi_offset_raw"]) & 0xFF
    adv_int = int(cfg["advertising_interval_raw"]) & 0xFF
    meas_int = int(cfg["measure_interval_raw"]) & 0xFF
    rf_tx = int(cfg["rf_tx_power_raw"]) & 0xFF
    conn_lat = int(cfg["connect_latency_raw"]) & 0xFF

    payload = bytes([flg, flg2, temp_offset, humi_offset, adv_int, meas_int, rf_tx, conn_lat])

    if "lcd_tint_raw" in cfg and cfg["lcd_tint_raw"] is not None:
        payload += bytes([int(cfg["lcd_tint_raw"]) & 0xFF])
        if "hw_ver_raw" in cfg and cfg["hw_ver_raw"] is not None:
            payload += bytes([int(cfg["hw_ver_raw"]) & 0xFF])
            payload += bytes([int(cfg.get("av_meas_mem_raw", 0) or 0) & 0xFF])

    return payload


# ==========================================================================
# BLE
# ==========================================================================

class ActivityTimer:
    """Tracks time since the last BLE message (sent or received), so a
    --timeout can mean 'idle for this long', not 'this long overall'."""

    def __init__(self):
        self.last = time.monotonic()

    def touch(self):
        self.last = time.monotonic()

    def elapsed(self):
        return time.monotonic() - self.last


async def wait_idle(done: asyncio.Event, activity: ActivityTimer, timeout: float) -> bool:
    """Wait for `done`, but only time out after `timeout` seconds pass with
    NO activity (no message sent or received) - not from a fixed overall
    deadline. Every notification received, and every command sent, should
    call activity.touch() to keep resetting the clock. Logs remaining time
    every 5s while genuinely waiting (this naturally stays near `timeout`
    during an actively-streaming transfer, since activity keeps resetting
    it - it only visibly counts down once things actually go quiet).
    Returns True if `done` was set, False if it timed out from inactivity."""
    last_logged = None
    while not done.is_set():
        remaining = timeout - activity.elapsed()
        if remaining <= 0:
            return False
        remaining_rounded = int(remaining)
        if remaining_rounded != last_logged and remaining_rounded % 5 == 0 and remaining_rounded > 0:
            log(f"  {remaining_rounded}s remaining (idle timeout)...")
            last_logged = remaining_rounded
        try:
            await asyncio.wait_for(done.wait(), timeout=min(1.0, remaining))
        except asyncio.TimeoutError:
            continue  # something may have happened since - recheck remaining
    return True


async def _warm_up(client, activity: "ActivityTimer" = None):
    """Send a harmless 'get config' request and pause briefly so the BLE
    notification pipe is properly settled before sending the command we
    actually want a reply to. See the NOTE ON BLE NOTIFICATION TIMING at
    the top of this file."""
    try:
        await client.write_gatt_char(CHAR_UUID, bytes([0x55]))
        if activity:
            activity.touch()
    except Exception:
        pass
    await asyncio.sleep(1.5)


async def scan(timeout: float, save: bool = False):
    log(f"Scanning for up to {timeout:.0f}s - press Enter at any time to stop early...")
    found = {}

    def on_detect(device, adv_data):
        name = device.name or (getattr(adv_data, "local_name", None) or "")
        if name.upper().startswith(DEVICE_NAME_PREFIXES) and device.address not in found:
            found[device.address] = {"name": name, "description": "", "address": device.address}
            log(f"  Found: {device.address}   {name}")

    stop_event = asyncio.Event()
    loop = asyncio.get_event_loop()

    def _wait_for_enter():
        try:
            input()
        except Exception:
            pass
        loop.call_soon_threadsafe(stop_event.set)

    threading.Thread(target=_wait_for_enter, daemon=True).start()

    scanner = BleakScanner(detection_callback=on_detect)
    await scanner.start()
    start = time.monotonic()
    last_logged = None
    try:
        while True:
            remaining = timeout - (time.monotonic() - start)
            if remaining <= 0:
                log("Scan time elapsed.")
                break
            if stop_event.is_set():
                log("Stopping scan (Enter pressed).")
                break
            remaining_rounded = int(remaining)
            if remaining_rounded != last_logged and remaining_rounded % 5 == 0 and remaining_rounded > 0:
                log(f"  {remaining_rounded}s remaining (press Enter to stop early)...")
                last_logged = remaining_rounded
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=min(1.0, remaining))
            except asyncio.TimeoutError:
                pass
    finally:
        await scanner.stop()

    found_list = list(found.values())
    if not found_list:
        log("  No matching sensors found. Make sure the sensor is powered,")
        log("  in range, and not already connected to another app/browser tab.")
        return

    log(f"Found {len(found_list)} sensor(s) total.")
    if save:
        save_path = f"sensors_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        with open(save_path, "w") as f:
            json.dump(found_list, f, indent=2)
        log(f"Wrote {len(found_list)} sensor(s) to {save_path} - fill in each "
            f"'description' (e.g. where the sensor is) if you'd like it "
            f"folded into output filenames.")


async def dump(address: str, out_prefix: str, requested_count: int, timeout: float,
                locale: str, time_mode: str, set_and_erase: bool = False,
                merge_tz: str = "source",
                merge_levels=("all",), drift_corr: bool = True) -> bool:
    """set_and_erase: set the sensor's clock and erase its log once the whole log is saved (both
    or neither). Returns True if everything worked: nothing missing, and the clock set and the
    log erased if asked for."""
    samples = []
    done = asyncio.Event()
    delete_done = asyncio.Event()
    clock_event = asyncio.Event()
    clock_reply = {}
    activity = ActivityTimer()
    mode_offset = 0 if time_mode == "utc" else _local_utc_offset_seconds()

    def handle_notify(_sender, data: bytearray):
        activity.touch()
        if not data:
            return
        blkid = data[0]
        if blkid == 0x35:
            if len(data) >= 13:
                idx, tc, tm, hm, vb = struct.unpack_from("<HIhHH", data, 1)
                samples.append((tc, tm / 100.0, hm / 100.0, vb, idx))
            else:
                done.set()  # short trailing packet = transfer complete
        elif blkid == 0x36:
            delete_done.set()
        elif blkid == 0x23 and len(data) >= 5:
            clock_reply["epoch"] = struct.unpack_from("<I", data, 1)[0]
            clock_event.set()

    clk = None
    log(f"Connecting to {address} ...")
    async with BleakClient(address) as client:
        await client.start_notify(CHAR_UUID, handle_notify)
        await _warm_up(client, activity)

        if drift_corr:
            # Read the clock first: its error now is the end point of the drift correction.
            got = await read_device_clock(client, clock_reply, clock_event, activity)
            if got:
                clk = (got[0], got[1] + mode_offset)
                log(f"Sensor clock {device_epoch_as_datetime(clk[0]).isoformat(sep=' ')} - "
                    f"{fmt_dur(clk[0] - clk[1])} {'fast' if clk[0] >= clk[1] else 'slow'} "
                    f"[{time_mode_label(time_mode)}]")
            else:
                log("Couldn't read the sensor clock - the newest readings won't be drift-corrected.")

        cnt = requested_count & 0xFFFF
        log(f"Requesting {'all stored' if cnt == 0xFFFF else cnt} readings...")
        await client.write_gatt_char(
            CHAR_UUID, bytes([0x35, cnt & 0xFF, (cnt >> 8) & 0xFF, 0, 0])
        )
        activity.touch()

        finished = await wait_idle(done, activity, timeout)
        if not finished:
            log(f"No response from the sensor for {timeout:.0f}s (idle timeout); "
                f"writing the {len(samples)} reading(s) received so far. (This only "
                "fires when the sensor goes quiet, not from the transfer's total "
                "length - raise --timeout if the sensor is just slow to respond.)")
        # Complete = the sensor said it's done, and no record number is missing in between.
        missing = missing_records(s[4] for s in samples)
        complete = finished and not missing
        if missing:
            log(f"{missing} reading(s) got lost on the way. Download again to get them.")
        # Save the download to disk BEFORE anything else happens on the sensor, so erasing it
        # (the default) can never lose readings that didn't make it into a file.
        out_path, saved = None, 0
        if samples:
            out_path, saved = _save_dump(samples, address, out_prefix, locale, time_mode, drift_corr, clk)
        elif finished:
            log("No readings on the sensor.")

        ok = complete and saved == len(samples)
        if set_and_erase:
            why = ("the download is incomplete" if not complete
                   else f"only the last {cnt} readings were downloaded" if cnt != 0xFFFF
                   else "there are no readings" if not samples
                   else "the download file couldn't be confirmed on disk" if saved != len(samples) else "")
            if why:
                log(f"Not setting the clock or erasing the sensor: {why}.")
            else:
                log(f"Saved all {saved} readings to {out_path}; setting the clock and erasing the "
                    "sensor's log (--keep-log to do neither)...")
                ok = await _set_clock_and_erase(client, address, time_mode, clk, activity, delete_done, timeout)

        await client.stop_notify(CHAR_UUID)

    prefix = out_prefix[:-4] if out_prefix.lower().endswith(".csv") else out_prefix
    if merge_levels:
        _merge_and_report(prefix, locale, merge_tz, merge_levels)
    return ok


def missing_records(numbers) -> int:
    """How many readings of a download never arrived. The firmware numbers them 1, 2, 3... without
    gaps (1 = the newest), so any number not seen up to the highest one was lost on the way."""
    seen = set(numbers)
    return max(seen, default=0) + (1 if 0 in seen else 0) - len(seen)


async def _set_clock_and_erase(client, address, time_mode, clk, activity, delete_done, timeout) -> bool:
    """Both or neither: if setting the clock fails, nothing is erased. Uses the connection that is
    still open after the download."""
    # Take the time right before sending it, not earlier in the connection.
    t = device_epoch_now(time_mode)
    try:
        await client.write_gatt_char(CHAR_UUID, bytes([0x23]) + t.to_bytes(4, "little"))
    except Exception as e:
        log(f"Setting the clock failed, so the sensor was NOT erased (the readings are saved): {e}")
        return False
    activity.touch()
    log(f"Updated sensor clock to {device_epoch_as_datetime(t).isoformat(sep=' ')} "
        f"[{time_mode_label(time_mode)}]")
    if clk:
        save_clock_log(address, {"before": t + round(clk[0] - clk[1]), "at": t})
    try:
        await client.write_gatt_char(CHAR_UUID, bytes([0x36, 0x12, 0x34]))
    except Exception as e:
        log(f"Erasing failed (the readings are saved): {e}")
        return False
    activity.touch()
    if await wait_idle(delete_done, activity, timeout):
        log("Sensor confirmed: log erased.")
        return True
    log(f"No response from the sensor for {timeout:.0f}s (idle timeout); it may still have erased "
        "its log. Run --dump again to check.")
    return False


def _save_dump(samples, address, out_prefix, locale, time_mode, drift_corr, clk):
    """Drift-corrects the downloaded samples and writes them to '<prefix>-raw-<stamp>.csv'.
    Returns (path, number of rows read back from the file) - the read-back is what allows
    the sensor to be erased afterwards."""
    # Log order (needed to see clock sets, since a clock set back makes times overlap): by record
    # number, in whichever direction makes the times increase.
    samples = list(samples)
    samples.sort(key=lambda s: s[4])
    if sum((b[0] > a[0]) - (b[0] < a[0]) for a, b in zip(samples, samples[1:])) < 0:
        samples.reverse()
    sensor_ts = [s[0] for s in samples]
    corrected = sensor_ts
    if drift_corr and samples:
        clog = load_clock_log(address)
        corrected, stretches, note = drift_correct(
            sensor_ts, clk[0] if clk else None, clk[1] if clk else None,
            clog.get("sets", []), clog.get("rate"))
        corrected = [round(c) for c in corrected]
        long_ones = [s for s in stretches if s["applied"] and s["to"] - s["from"] > 86400]
        if long_ones:
            save_clock_log(address, rate=long_ones[-1]["per_day"] / 86400)
        for s in stretches:
            log(f"  drift stretch {device_epoch_as_datetime(s['from']).isoformat(sep=' ')} .. "
                f"{device_epoch_as_datetime(s['to']).isoformat(sep=' ')} ({s['n']} readings): "
                + ("-" if s["E"] is None else f"{s['E']:+.0f} s, {s['per_day']:+.1f} s/day, ")
                + ("corrected" if s["applied"] else s.get("why", "")))
        log(f"Clock drift: {drift_summary(stretches, note)}")
    offset_str = dump_utc_offset(time_mode)
    rows = sorted(((device_epoch_as_datetime(c).isoformat(sep=" "), s[1], s[2], s[3], offset_str,
                    device_epoch_as_datetime(s[0]).isoformat(sep=" "))
                   for s, c in zip(samples, corrected)), key=lambda r: r[0])

    import_stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    prefix = out_prefix[:-4] if out_prefix.lower().endswith(".csv") else out_prefix
    out_path = Path(f"{prefix}-raw-{import_stamp}.csv")
    try:
        write_csv(out_path, rows, locale)
        saved = len(read_csv_file(out_path)[0])
    except OSError as e:
        log(f"Couldn't write {out_path}: {e}")
        return out_path, 0
    log(f"Wrote {saved} readings to {out_path}")
    return out_path, saved


def _merge_and_report(prefix, locale, merge_tz, merge_levels):
    if merge_levels:
        written, locales_seen, file_count = merge_history(prefix, locale, merge_tz, merge_levels)
        locale_note = f" (source locales seen: {', '.join(sorted(locales_seen))})" \
            if len(locales_seen) > 1 else ""
        if written["all"]:
            path, count = written["all"]
            log(f"Merged {file_count} raw file(s) into {path}: {count} readings{locale_note}")
        if written["daily"]:
            days = [p.stem.rsplit("-daily-", 1)[1] for p, _ in written["daily"]]
            log(f"Wrote {len(written['daily'])} daily file(s) ({days[0]}..{days[-1]}) "
                f"next to {prefix}-daily-*.csv{locale_note}")
        if written["monthly"]:
            months = [p.stem.rsplit("-monthly-", 1)[1] for p, _ in written["monthly"]]
            log(f"Wrote {len(written['monthly'])} monthly file(s) ({months[0]}..{months[-1]}) "
                f"next to {prefix}-monthly-*.csv{locale_note}")
        if written["yearly"]:
            years = [p.stem.rsplit("-yearly-", 1)[1] for p, _ in written["yearly"]]
            log(f"Wrote {len(written['yearly'])} yearly file(s) ({years[0]}..{years[-1]}) "
                f"next to {prefix}-yearly-*.csv{locale_note}")


async def get_config(address: str, out_path: str, timeout: float = DEFAULT_TIMEOUT):
    result = {}
    done = asyncio.Event()
    armed = {"on": False}
    activity = ActivityTimer()

    def handle_notify(_sender, data: bytearray):
        activity.touch()
        if not armed["on"]:
            return
        if data and data[0] == 0x55 and len(data) - 1 >= 9:
            result["cfg"] = decode_cfg(bytes(data))
            done.set()

    log(f"Connecting to {address} ...")
    async with BleakClient(address) as client:
        await client.start_notify(CHAR_UUID, handle_notify)
        await _warm_up(client, activity)
        armed["on"] = True
        log("Requesting sensor config...")
        await client.write_gatt_char(CHAR_UUID, bytes([0x55]))
        activity.touch()
        if not await wait_idle(done, activity, timeout):
            log(f"No response from the sensor for {timeout:.0f}s (idle timeout).")
            await client.stop_notify(CHAR_UUID)
            return
        await client.stop_notify(CHAR_UUID)

    with open(out_path, "w") as f:
        json.dump(result["cfg"], f, indent=2)
    log(f"Wrote config to {out_path}")


async def set_config(address: str, in_path: str, timeout: float = DEFAULT_TIMEOUT):
    with open(in_path, "r") as f:
        cfg_json = json.load(f)
    payload = encode_cfg(cfg_json)

    confirmed = {}
    done = asyncio.Event()
    armed = {"on": False}
    activity = ActivityTimer()

    def handle_notify(_sender, data: bytearray):
        activity.touch()
        if not armed["on"]:
            return
        if data and data[0] == 0x55 and len(data) - 1 >= 9:
            confirmed["cfg"] = decode_cfg(bytes(data))
            done.set()

    log(f"Connecting to {address} ...")
    async with BleakClient(address) as client:
        await client.start_notify(CHAR_UUID, handle_notify)
        await _warm_up(client, activity)
        armed["on"] = True
        log(f"Writing config ({len(payload)} bytes)...")
        await client.write_gatt_char(CHAR_UUID, bytes([0x55]) + payload)
        activity.touch()
        if not await wait_idle(done, activity, timeout):
            log(f"No response from the sensor for {timeout:.0f}s (idle timeout); "
                "it may or may not have applied. Re-run --get-config to check.")
            await client.stop_notify(CHAR_UUID)
            return
        await client.stop_notify(CHAR_UUID)

    log("Sensor confirmed the new config:")
    print(json.dumps(confirmed["cfg"], indent=2))


async def set_time(address: str, timeout: float, time_mode: str):
    confirmed = {}
    done = asyncio.Event()
    armed = {"on": False}
    activity = ActivityTimer()

    def handle_notify(_sender, data: bytearray):
        activity.touch()
        if not armed["on"]:
            return
        if data and data[0] == 0x23 and len(data) - 1 >= 4:
            confirmed["epoch"] = struct.unpack_from("<I", data, 1)[0]
            done.set()

    log(f"Connecting to {address} ...")
    async with BleakClient(address) as client:
        await client.start_notify(CHAR_UUID, handle_notify)
        await _warm_up(client, activity)
        armed["on"] = True
        # Read the clock first, so this set is recorded with the error it corrects (used by the
        # drift correction in later dumps).
        before = await read_device_clock(client, confirmed, done, activity)
        done.clear()
        # Query the current time right before sending it, not earlier in
        # the connection (the warm-up step above takes ~1.5s on its own).
        t = device_epoch_now(time_mode)
        if before:
            err = round(before[0] - (before[1] + (0 if time_mode == "utc" else _local_utc_offset_seconds())))
            log(f"Sensor clock was {fmt_dur(err)} {'fast' if err >= 0 else 'slow'}.")
            save_clock_log(address, {"before": t + err, "at": t})
        payload = bytes([0x23]) + t.to_bytes(4, "little")
        log(f"Setting sensor clock to {device_epoch_as_datetime(t).isoformat(sep=' ')} "
            f"[{time_mode_label(time_mode)}]...")
        await client.write_gatt_char(CHAR_UUID, payload)
        activity.touch()
        if not await wait_idle(done, activity, timeout):
            log(f"No response from the sensor for {timeout:.0f}s (idle timeout).")
            await client.stop_notify(CHAR_UUID)
            return
        await client.stop_notify(CHAR_UUID)

    confirmed_dt = device_epoch_as_datetime(confirmed["epoch"])
    log(f"Sensor confirmed clock set to: {confirmed_dt.isoformat(sep=' ')}")


async def delete_log(address: str, timeout: float = DEFAULT_TIMEOUT):
    done = asyncio.Event()
    armed = {"on": False}
    activity = ActivityTimer()

    def handle_notify(_sender, data: bytearray):
        activity.touch()
        if not armed["on"]:
            return
        if data and data[0] == 0x36:
            done.set()

    log(f"Connecting to {address} ...")
    async with BleakClient(address) as client:
        await client.start_notify(CHAR_UUID, handle_notify)
        await _warm_up(client, activity)
        armed["on"] = True
        log("Sending erase-log command...")
        await client.write_gatt_char(CHAR_UUID, bytes([0x36, 0x12, 0x34]))
        activity.touch()
        if await wait_idle(done, activity, timeout):
            log("Sensor confirmed: log erased.")
        else:
            log(f"No response from the sensor for {timeout:.0f}s (idle timeout); it may "
                "still have processed the deletion. Consider trying --dump to check "
                "whether the log is actually empty.")
        await client.stop_notify(CHAR_UUID)


# ==========================================================================
# Batch (multiple sensors from a JSON file)
# ==========================================================================

def load_sensors(path: str):
    """The sensor list (sensors.json) is either a JSON list of
    {"name": ..., "description": ..., "address": ...} objects, or
    {"sensors": [...]} with the same shape. 'name' is optional (falls back
    to the address with ':' stripped). 'description' is optional - e.g.
    where the sensor is - and gets folded into output filenames
    alongside 'name' (see device_label())."""
    with open(path, "r") as f:
        data = json.load(f)
    if isinstance(data, dict):  # {"sensors": [...]} (or {"devices": [...]} from older versions)
        data = data.get("sensors", data.get("devices"))
    if not isinstance(data, list):
        raise ValueError(
            "The sensor list must be a JSON list of {\"name\": ..., \"description\": ..., "
            "\"address\": ...} objects, or {\"sensors\": [...]} with the same shape."
        )
    sensors = []
    for i, d in enumerate(data):
        if "address" not in d:
            raise ValueError(f"Sensor #{i + 1} in {path} is missing 'address'")
        name = d.get("name") or d["address"].replace(":", "")
        description = d.get("description") or ""
        sensors.append({"name": name, "description": description, "address": d["address"]})
    if not sensors:
        raise ValueError(f"No sensors found in {path}")
    return sensors


def device_label(dev: dict) -> str:
    """Combine a sensor's description and name for use in
    output filenames: 'Description-name', description first so files sort
    by description, or 'name' alone if there's no description. Spaces and hyphens
    inside the description become underscores, so the hyphen only ever
    separates the parts and the files can be split back apart reliably
    (the ATC_xxxxxx name is what identifies the sensor)."""
    desc = re.sub(r"[\s\-]+", "_", (dev.get("description") or "").strip()).strip("_")
    return f"{desc}-{dev['name']}" if desc else dev["name"]


def legacy_config_names(dev: dict, stem: str = "config"):
    """Per-sensor config file names used by earlier versions, still looked
    for by --set-config: config_<name>__<description>.json and
    config_<name>_<description>.json (or just config_<name>.json)."""
    name, desc = dev["name"], (dev.get("description") or "")
    if not desc:
        return [f"{stem}_{sanitize_name(name)}.json"]
    return [f"{stem}_{sanitize_name(name + '__' + desc)}.json", f"{stem}_{sanitize_name(name + '_' + desc)}.json"]


def device_display(dev: dict) -> str:
    """Human-readable name + description + address for log messages and
    confirmation prompts (distinct from device_label(), which produces a
    filename-safe underscore-joined string for output paths)."""
    label = dev["name"]
    if dev.get("description"):
        label += f" ({dev['description']})"
    return f"{label} [{dev['address']}]"


def sanitize_name(name: str) -> str:
    """Make a sensor name safe to use in a filename."""
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_") or "sensor"


async def run_batch(sensors, label, coro_fn):
    """Run coro_fn(device_dict) for every sensor, sequentially (BLE adapters
    generally only handle one connection at a time), continuing past
    per-sensor failures, then print a summary."""
    results = []
    for i, dev in enumerate(sensors, 1):
        log(f"=== [{i}/{len(sensors)}] {device_display(dev)} - {label} ===")
        try:
            await coro_fn(dev)
            results.append((device_display(dev), "OK"))
        except Exception as e:
            log(f"ERROR on {device_display(dev)}: {e}")
            results.append((device_display(dev), f"FAILED: {e}"))

    log(f"=== {label} summary ===")
    ok = sum(1 for _, status in results if status == "OK")
    for display, status in results:
        log(f"  {display:40s} {status}")
    log(f"{ok}/{len(results)} succeeded")
    return results


def strip_suffix(path: str, suffix: str) -> str:
    return path[: -len(suffix)] if path.lower().endswith(suffix) else path


# ==========================================================================
# CLI
# ==========================================================================

EXAMPLES = """
examples:
  A download sets the sensor's clock (UTC) and then erases its log - but only
  after the whole log was downloaded and saved to a file. --keep-log does neither.
  --scan has no batch form: it's how you build a sensors.json in the first place.

  --- batch mode (--sensors sensors.json): every sensor in the list ---
    python ATC_MiThermometer_tools.py --sensors sensors.json --dump
        -> <Description>-<name>-raw-<timestamp>.csv per download, merged into
           <Description>-<name>-all.csv; then clock set and log erased
    python ATC_MiThermometer_tools.py --sensors sensors.json --dump --keep-log
        -> only download: clocks and logs stay as they are
    python ATC_MiThermometer_tools.py --sensors sensors.json --dump --count 500
        -> only the last 500 readings (a partial download changes nothing on the sensor)
    python ATC_MiThermometer_tools.py --sensors sensors.json --dump --locale hu
        -> Excel-friendly CSV: semicolons and decimal commas
    python ATC_MiThermometer_tools.py --sensors sensors.json --dump --merge-levels all,daily,monthly
        -> also <Description>-<name>-daily-<YYYYMMDD>.csv and -monthly-<YYYYMM>.csv
    python ATC_MiThermometer_tools.py --sensors sensors.json --dump --merge-tz Europe/Berlin
        -> daily/monthly files cut at that city's midnight (the times stay UTC)
    python ATC_MiThermometer_tools.py --sensors sensors.json --dump --out home
        -> same, with a prefix: home-<Description>-<name>-...

    python ATC_MiThermometer_tools.py --sensors sensors.json --set-time
    python ATC_MiThermometer_tools.py --sensors sensors.json --get-config
        -> <Description>-<name>-config.json per sensor
    python ATC_MiThermometer_tools.py --sensors sensors.json --set-config
        -> uses <Description>-<name>-config.json per sensor if present (or an older
           config_<name>_<description>.json), otherwise the shared config.json
    python ATC_MiThermometer_tools.py --sensors sensors.json --delete-log
        -> erase without downloading (asks first; --yes skips the question)

  --- one sensor, by its address ---
    python ATC_MiThermometer_tools.py --scan
    python ATC_MiThermometer_tools.py --scan --save-sensors
        -> writes sensors_<timestamp>.json for use with --sensors
    python ATC_MiThermometer_tools.py --dump A4:C1:38:A1:B2:C3 --out kitchen
    python ATC_MiThermometer_tools.py --dump A4:C1:38:A1:B2:C3 --out kitchen --keep-log
    python ATC_MiThermometer_tools.py --get-config A4:C1:38:A1:B2:C3 --config-out config.json
    python ATC_MiThermometer_tools.py --set-config A4:C1:38:A1:B2:C3 --config-in config.json
    python ATC_MiThermometer_tools.py --set-time A4:C1:38:A1:B2:C3
    python ATC_MiThermometer_tools.py --delete-log A4:C1:38:A1:B2:C3
"""


# Same pattern as the app: the day it's published, then the build number (all versions ever published).
VERSION = "2026-11-25.126"


def main():
    parser = argparse.ArgumentParser(
        description=__doc__.split("\n\n")[0],
        epilog=EXAMPLES,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    parser.add_argument("--scan", action="store_true",
                         help="Scan for nearby ATC-firmware sensors, logging each one as it's "
                              "found; press Enter at any time to stop early")
    parser.add_argument("--save-sensors", action="store_true",
                         help="(--scan) Save the found sensors to a timestamped "
                              "sensors_<timestamp>.json, in the JSON format --sensors expects")
    parser.add_argument("--sensors", metavar="FILE",
                         help="JSON file listing multiple sensors ([{\"name\":..,\"description\":.."
                              ",\"address\":..}, ...] or {\"sensors\": [...]}). When given, use "
                              "--dump/--get-config/--set-config/--set-time/--delete-log WITHOUT an "
                              "address to run that action against every sensor in the file.")
    parser.add_argument("--dump", nargs="?", const="__ALL__", default=None, metavar="ADDRESS",
                         help="MAC address of the sensor to download readings from "
                              "(omit the address, and use with --sensors, to run on all of them)")
    parser.add_argument("--get-config", nargs="?", const="__ALL__", default=None, metavar="ADDRESS",
                         help="MAC address of the sensor to read config from (use with --config-out); "
                              "omit the address (with --sensors) to run on all of them")
    parser.add_argument("--set-config", nargs="?", const="__ALL__", default=None, metavar="ADDRESS",
                         help="MAC address of the sensor to write config to (use with --config-in); "
                              "omit the address (with --sensors) to run on all of them")
    parser.add_argument("--delete-log", nargs="?", const="__ALL__", default=None, metavar="ADDRESS",
                         help="MAC address of the sensor whose log to erase; "
                              "omit the address (with --sensors) to run on all of them")
    parser.add_argument("--keep-log", action="store_true",
                         help="(--dump) Only download: don't set the sensor's clock or erase its log. By "
                              "default both are done, together, once the whole log has been downloaded "
                              "and saved to a file (never after an incomplete download, or with --count).")
    parser.add_argument("--no-clock-sync", action="store_true",
                         help="(--dump) Same as --keep-log: the clock is only set together with erasing.")
    parser.add_argument("--no-drift-correction", action="store_true",
                         help="(--dump) Don't correct the sensor clock's drift. By default the clock "
                              "is read before downloading and the readings since each clock set are "
                              "shifted to the right time (see NOTE ON CLOCK DRIFT); the sensor's own "
                              "times stay in the 'sensor_timestamp' column.")
    parser.add_argument("--set-time", nargs="?", const="__ALL__", default=None, metavar="ADDRESS",
                         help="MAC address of the sensor to set the clock on (--time-mode, "
                              "default utc); omit the address (with --sensors) to run on all of them")
    parser.add_argument("--yes", "-y", action="store_true",
                         help="Skip the confirmation question of --delete-log")

    parser.add_argument("--out", default=None,
                         help="(--dump) Output filename prefix. Each run writes "
                              "'<prefix>-raw-<import-timestamp>.csv' so raw files are never "
                              "overwritten, and (re)generates aggregate file(s) from every raw file "
                              "on disk - see --merge-levels. Single sensor: default 'atc_history'. "
                              "Batch mode (--sensors): files are named '<Description>-<name>-…' by "
                              "default; a given --out is put in front ('<out>-<Description>-<name>-…').")
    parser.add_argument("--config-out", default="config.json",
                         help="(--get-config) Path to write the config JSON to (default: config.json). "
                              "In batch mode (--sensors), each sensor gets '<Description>-<name>-config.json' "
                              "(or '<stem>-<Description>-<name>.json' if you pass another --config-out).")
    parser.add_argument("--config-in", default="config.json",
                         help="(--set-config) Path to read the config JSON from (default: config.json). "
                              "In batch mode (--sensors), a per-sensor '<Description>-<name>-config.json' "
                              "(or an older config_<name>_<description>.json) is used automatically if it "
                              "exists; otherwise this shared file is used for every sensor.")

    parser.add_argument("--count", type=lambda x: int(x, 0), default=0xFFFF,
                         help="(--dump) Number of most recent readings to request (default: all, 0xFFFF)")
    parser.add_argument("--timeout", type=float, default=None,
                         help="Idle timeout in seconds - only counts from the last message sent or "
                              "received, not the whole operation. Used for --scan too (how long to "
                              f"scan for; press Enter to stop earlier). Default: {DEFAULT_SCAN_TIMEOUT:.0f} "
                              f"for --scan, {DEFAULT_TIMEOUT:.0f} for everything else.")
    parser.add_argument("--locale", choices=["en", "hu"], default="en",
                         help="(--dump) CSV format: 'en' = comma-separated, dot decimals "
                              "(default); 'hu' = semicolon-separated, comma decimals "
                              "(Hungarian Excel)")
    parser.add_argument("--time-mode", choices=["local", "utc"], default="utc",
                         help="(--dump/--set-time, default: utc) Clock convention to write to the "
                              "sensor: 'local' matches pvvx's own web tools - local wall-clock time "
                              "packed into a UTC-shaped field; 'utc' writes the true UTC epoch "
                              "instead. Every CSV row also records which was used in its "
                              "'utc_offset' column. See the NOTE in this file's docstring - pick "
                              "one and stick with it.")
    parser.add_argument("--merge-tz", default="source",
                         help="(--dump) Every aggregate CSV file (--merge-levels) always stores "
                              "true UTC timestamps, unaffected by this - the raw per-import CSV "
                              "separately always keeps --time-mode's raw values plus its own "
                              "utc_offset column, also unaffected. This ONLY decides where the "
                              "daily/monthly/yearly calendar CUT falls: 'source' or 'utc' (default) "
                              "bucket by UTC's own calendar boundaries; 'local' buckets by this "
                              "computer's current UTC offset (a DST-approximate quick option); an "
                              "IANA zone name like 'Europe/Budapest' buckets by that city/region's "
                              "actual local calendar (DST-correct: a day spanning a DST transition "
                              "is still cut at that city's real midnight, not shifted by a flat "
                              "offset; may need pip install tzdata on Windows).")
    parser.add_argument("--merge-levels", default="all",
                         help="(--dump) Comma-separated list of aggregate file(s) to (re)generate "
                              "from every raw file on disk for this sensor (all "
                              "always stored as true UTC - see --merge-tz): 'all' (default) -> "
                              "<prefix>-all.csv (everything); 'daily' -> one "
                              "<prefix>-daily-<YYYYMMDD>.csv per calendar day; 'monthly' -> one "
                              "<prefix>-monthly-<YYYYMM>.csv per calendar month; 'yearly' -> one "
                              "<prefix>-yearly-<YYYY>.csv per calendar year. Combine as needed, e.g. "
                              "'all,daily,monthly,yearly', or pass 'none' to only write the raw file "
                              "and skip aggregation entirely.")
    args = parser.parse_args()

    if args.timeout is None:
        args.timeout = DEFAULT_SCAN_TIMEOUT if args.scan else DEFAULT_TIMEOUT

    merge_levels = tuple(lvl.strip() for lvl in args.merge_levels.split(",") if lvl.strip())
    if merge_levels == ("none",):
        merge_levels = ()
    valid_levels = {"all", "daily", "monthly", "yearly"}
    bad_levels = [lvl for lvl in merge_levels if lvl not in valid_levels]
    if bad_levels:
        parser.error(f"--merge-levels: unknown value(s) {bad_levels}; "
                      f"valid: all, daily, monthly, yearly, none")

    def want_batch(value):
        return value == "__ALL__"

    def require_sensors():
        if not args.sensors:
            log("--sensors FILE is required when using this action without an address.")
            sys.exit(1)
        return load_sensors(args.sensors)

    def confirm_destructive(prompt: str) -> bool:
        if args.yes:
            return True
        reply = input(prompt)
        if reply.strip() != "YES":
            log("Cancelled.")
            return False
        return True

    if args.scan:
        asyncio.run(scan(args.timeout, args.save_sensors))

    elif args.dump is not None:
        # Setting the clock and erasing after a download is the default, always both or neither
        # (like the iPhone app), and only once the whole log is saved to a file.
        set_and_erase = not (args.keep_log or args.no_clock_sync)
        if set_and_erase and (args.count & 0xFFFF) != 0xFFFF:
            log(f"--count {args.count}: only part of the log is downloaded, so the clock won't be set "
                "and nothing is erased.")
            set_and_erase = False
        if set_and_erase:
            log("After each complete download the sensor's clock is set and its log is erased "
                "(use --keep-log to do neither).")

        if want_batch(args.dump):
            sensors = require_sensors()

            async def _one(dev):
                label = sanitize_name(device_label(dev))
                prefix = f"{args.out}-{label}" if args.out else label
                if not await dump(dev["address"], prefix, args.count, args.timeout, args.locale,
                                  args.time_mode, set_and_erase, args.merge_tz,
                                  merge_levels, not args.no_drift_correction):
                    raise RuntimeError("incomplete, or not erased (see the messages above)")

            asyncio.run(run_batch(sensors, "dump", _one))
        else:
            asyncio.run(dump(args.dump, args.out or "atc_history", args.count, args.timeout, args.locale,
                              args.time_mode, set_and_erase, args.merge_tz,
                              merge_levels, not args.no_drift_correction))

    elif args.get_config is not None:
        if want_batch(args.get_config):
            sensors = require_sensors()
            stem = strip_suffix(args.config_out, ".json")

            async def _one(dev):
                label = sanitize_name(device_label(dev))
                out_path = f"{label}-config.json" if args.config_out == "config.json" else f"{stem}-{label}.json"
                await get_config(dev["address"], out_path, args.timeout)

            asyncio.run(run_batch(sensors, "get-config", _one))
        else:
            asyncio.run(get_config(args.get_config, args.config_out, args.timeout))

    elif args.set_config is not None:
        if want_batch(args.set_config):
            sensors = require_sensors()
            stem = strip_suffix(args.config_in, ".json")

            async def _one(dev):
                label = sanitize_name(device_label(dev))
                candidates = [f"{label}-config.json"]
                if args.config_in != "config.json":
                    candidates.append(f"{stem}-{label}.json")
                candidates += legacy_config_names(dev, Path(stem).name)
                path = next((c for c in candidates if Path(c).exists()), args.config_in)
                log(f"Using config file: {path}")
                await set_config(dev["address"], path, args.timeout)

            asyncio.run(run_batch(sensors, "set-config", _one))
        else:
            asyncio.run(set_config(args.set_config, args.config_in, args.timeout))

    elif args.set_time is not None:
        if want_batch(args.set_time):
            sensors = require_sensors()

            async def _one(dev):
                await set_time(dev["address"], args.timeout, args.time_mode)

            asyncio.run(run_batch(sensors, "set-time", _one))
        else:
            asyncio.run(set_time(args.set_time, args.timeout, args.time_mode))

    elif args.delete_log is not None:
        if want_batch(args.delete_log):
            sensors = require_sensors()
            names = ", ".join(device_display(d) for d in sensors)
            if not confirm_destructive(
                f"This will PERMANENTLY erase the log of {len(sensors)} "
                f"sensor(s): {names}. Type YES to continue: "
            ):
                sys.exit(1)

            async def _one(dev):
                await delete_log(dev["address"], args.timeout)

            asyncio.run(run_batch(sensors, "delete-log", _one))
        else:
            if not confirm_destructive(
                "This will PERMANENTLY erase the sensor's log. "
                "Type YES to continue: "
            ):
                sys.exit(1)
            asyncio.run(delete_log(args.delete_log, args.timeout))

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
