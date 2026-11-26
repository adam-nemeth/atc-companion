"""Tests for python/ATC_MiThermometer_tools.py. Run from the repository root:

    python -m unittest discover -s tests

Nothing to install: Bluetooth (bleak) isn't needed for these, and is stubbed if missing.
"""
import csv
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))
try:
    import bleak  # noqa: F401
except ImportError:
    sys.modules["bleak"] = types.SimpleNamespace(BleakClient=None, BleakScanner=None)
import ATC_MiThermometer_tools as T  # noqa: E402


class DriftCorrection(unittest.TestCase):
    def test_shared_cases(self):
        """Same cases (tests/fixtures/drift_cases.json) as the app's tests, so both stay in step."""
        cases = json.loads((ROOT / "tests" / "fixtures" / "drift_cases.json").read_text())
        for c in cases:
            with self.subTest(c["name"]):
                corr, _stretches, _note = T.drift_correct(c["ts"], c["now_sensor"], c["now_true"])
                if c["expect"] == "corrected":
                    worst = max(abs(v - t) for v, t in zip(corr, c["true"]))
                    self.assertLessEqual(worst, c["tolerance"], f"off by up to {worst:.1f} s")
                else:
                    self.assertEqual(list(corr), c["ts"])

    def test_summary_has_no_rate_for_short_stretches(self):
        """1 s off after an hour is not '24 s/day' - and within 2 s counts as correct."""
        ts = [1790000000 + i * 600 for i in range(6)]
        corr, st, note = T.drift_correct(ts, ts[-1] + 300 + 1, ts[-1] + 300)
        self.assertEqual(T.drift_summary(st, note), "clock correct (within 2 s)")
        corr, st, note = T.drift_correct(ts, ts[-1] + 300 + 10, ts[-1] + 300)
        self.assertNotIn("s/day", T.drift_summary(st, note))


class CsvFiles(unittest.TestCase):
    def test_round_trip_both_formats(self):
        rows = [("2026-11-22 10:00:00", 21.5, 55.25, 2990, "+00:00", "2026-11-22 10:00:42"),
                ("2026-11-22 10:10:00", -3.25, 80.0, 3001, "+01:00")]
        with tempfile.TemporaryDirectory() as d:
            for loc in ("en", "hu"):
                p = Path(d) / f"x-{loc}.csv"
                T.write_csv(p, rows, loc)
                back, seen = T.read_csv_file(p)
                self.assertEqual(seen, loc)
                self.assertEqual(back[0], ("2026-11-22 10:00:00", 21.5, 55.25, 2990, "+00:00", "2026-11-22 10:00:42"))
                self.assertEqual(back[1], ("2026-11-22 10:10:00", -3.25, 80.0, 3001, "+01:00", None))

    def test_reads_files_from_before_the_extra_columns(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "old.csv"
            p.write_text("timestamp,temperature_c,humidity_pct,battery_mv\n2026-01-01 00:00:00,20.00,50.00,3000\n")
            rows, _ = T.read_csv_file(p)
            self.assertEqual(rows, [("2026-01-01 00:00:00", 20.0, 50.0, 3000, "+00:00", None)])


class Merging(unittest.TestCase):
    def test_corrected_redownload_replaces_old_copy_and_keeps_phone_data(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            base = "Kitchen-ATC_A1B2C3"
            # An old download, before drift correction (sensor times only)...
            T.write_csv(d / f"{base}-raw-20260801_120000.csv",
                        [("2026-08-01 10:00:00", 21.0, 50.0, 3000, "+00:00"),
                         ("2026-08-01 10:10:00", 21.1, 50.1, 3000, "+00:00")], "en")
            # ...the same readings downloaded again, corrected by 37 s, plus a new one...
            T.write_csv(d / f"{base}-raw-20260802_120000.csv",
                        [("2026-08-01 09:59:23", 21.0, 50.0, 3000, "+00:00", "2026-08-01 10:00:00"),
                         ("2026-08-01 10:09:23", 21.1, 50.1, 3000, "+00:00", "2026-08-01 10:10:00"),
                         ("2026-08-01 10:19:23", 21.2, 50.2, 3000, "+00:00", "2026-08-01 10:20:00")], "en")
            # ...and an -all.csv shared from the phone with a reading no raw file has.
            T.write_csv(d / f"{base}-all.csv", [("2026-07-31 08:00:00", 19.0, 60.0, 3010, "+00:00")], "en")

            written, _locales, nfiles = T.merge_history(str(d / base), "en")
            self.assertEqual(nfiles, 2)
            with open(written["all"][0], newline="") as f:
                rows = list(csv.reader(f))
            self.assertEqual([r[0] for r in rows[1:]],
                             ["2026-07-31 08:00:00", "2026-08-01 09:59:23", "2026-08-01 10:09:23", "2026-08-01 10:19:23"])
            self.assertEqual(rows[2][5], "2026-08-01 10:00:00")  # sensor time kept

    def test_finds_raw_files_under_other_names_for_the_same_sensor(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            for name in ("Kitchen-ATC_A1B2C3-raw-20260801_120000.csv", "Old_name-ATC_A1B2C3-raw-20260701_120000.csv",
                         "Bedroom-ATC_D4E5F6-raw-20260801_120000.csv"):
                (d / name).write_text("timestamp\n")
            found = {p.name for p in T.find_raw_files(d, "Kitchen-ATC_A1B2C3")}
            self.assertEqual(found, {"Kitchen-ATC_A1B2C3-raw-20260801_120000.csv", "Old_name-ATC_A1B2C3-raw-20260701_120000.csv"})


class SensorConfig(unittest.TestCase):
    def test_decode_then_encode_gives_the_same_bytes(self):
        reply = bytes([0x55, 88, 133, 16, 10, 6, 40, 4, 169, 49, 49, 0, 60])  # a real LYWSD03MMC reply
        cfg = T.decode_cfg(reply)
        self.assertEqual(cfg["advertising_interval_ms_info"], 2500)
        self.assertEqual(T.encode_cfg(json.loads(json.dumps(cfg))), reply[2:])


class FakeSensor:
    """Stands in for bleak's BleakClient: answers the clock (0x23), history (0x35) and erase
    (0x36) commands like a sensor with `n` readings, and records what was sent."""
    def __init__(self, n=50, finish=True, lost=(), clock_fails=False, logs_during=0, due_in=300):
        self.n, self.finish, self.sent, self.erased_with_files = n, finish, [], None
        self.lost, self.clock_fails, self.clock_set = lost, clock_fails, False
        self.logs_during, self.new = logs_during, 0  # readings logged while the first download runs
        self.due_in = due_in  # seconds until the next reading is logged
        self.prefix_dir = None

    def __call__(self, address):  # used as BleakClient(address)
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def start_notify(self, _uuid, handler):
        self.handler = handler

    async def stop_notify(self, _uuid):
        pass

    async def write_gatt_char(self, _uuid, data):
        data = bytes(data)
        self.sent.append(data[0])
        now = int(__import__("time").time())
        if data[0] == 0x23 and len(data) == 1:
            self.handler(None, bytearray(b"\x23" + now.to_bytes(4, "little")))
        elif data[0] == 0x23:
            if self.clock_fails:
                raise OSError("simulated Bluetooth error")
            self.clock_set = True
        elif data[0] == 0x35:
            # Like the firmware: the log as it is now, newest first, numbered from 1, as many as asked for.
            last = now + self.due_in - 600
            times = [last + j * 600 for j in range(self.new, 0, -1)] + [last - i * 600 for i in range(self.n)]
            for i, t in enumerate(times[:data[1] | data[2] << 8], 1):
                if i not in self.lost:
                    self.handler(None, bytearray(b"\x35" + T.struct.pack("<HIhHH", i, t, 2150, 5000, 3000)))
            self.new += self.logs_during
            self.logs_during = 0
            if self.finish:
                self.handler(None, bytearray(b"\x35"))  # short packet = end of transfer
        elif data[0] == 0x36:
            # Which download files existed at the moment the sensor was told to erase?
            self.erased_with_files = sorted(p.name for p in self.prefix_dir.glob("*-raw-*.csv"))
            self.handler(None, bytearray(b"\x36\x00"))


class DownloadAndErase(unittest.TestCase):
    """--dump erases the sensor's log by default - only after the whole log is saved to a file."""
    def run_dump(self, sensor, erase=True, count=0xFFFF, timeout=5):
        with tempfile.TemporaryDirectory() as d:
            sensor.prefix_dir = Path(d)
            saved = (T.BleakClient, T._warm_up, T.CLOCK_LOG, T.log)
            async def no_warm_up(*a, **k):
                pass
            T.BleakClient, T._warm_up, T.CLOCK_LOG, T.log = sensor, no_warm_up, Path(d) / "clock_log.json", lambda *a: None
            try:
                finished = T.asyncio.run(T.dump("A4:C1:38:A1:B2:C3", str(Path(d) / "Kitchen-ATC_A1B2C3"), count,
                                                timeout, "en", "utc", erase, "source", ("all",), True))
                files = sorted(p.name for p in Path(d).glob("*.csv"))
                raw = [p for p in Path(d).glob("*-raw-*.csv")]
                self.rows = len(T.read_csv_file(raw[0])[0]) if raw else 0
            finally:
                T.BleakClient, T._warm_up, T.CLOCK_LOG, T.log = saved
        return finished, files

    def assert_left_alone(self, s):
        self.assertFalse(s.clock_set)
        self.assertNotIn(0x36, s.sent)

    def test_sets_clock_and_erases_by_default_after_the_file_is_saved(self):
        s = FakeSensor()
        ok, files = self.run_dump(s)
        self.assertTrue(ok)
        self.assertTrue(s.clock_set)
        self.assertIn(0x36, s.sent)
        self.assertEqual(len(s.erased_with_files), 1, "download file must exist before erasing")
        self.assertIn("Kitchen-ATC_A1B2C3-all.csv", files)

    def test_keep_log(self):
        s = FakeSensor()
        ok, _files = self.run_dump(s, erase=False)
        self.assertTrue(ok)
        self.assert_left_alone(s)

    def test_partial_download_leaves_the_sensor_alone(self):
        s = FakeSensor()
        self.run_dump(s, count=500)
        self.assert_left_alone(s)

    def test_incomplete_download_leaves_the_sensor_alone(self):
        s = FakeSensor(finish=False)
        ok, files = self.run_dump(s, timeout=1)
        self.assertFalse(ok)
        self.assert_left_alone(s)
        self.assertTrue(any("-raw-" in f for f in files), "what arrived is still saved")

    def test_lost_readings_leave_the_sensor_alone(self):
        for lost in ((1,), (20, 21)):
            s = FakeSensor(lost=lost)
            ok, files = self.run_dump(s)
            self.assertFalse(ok)
            self.assert_left_alone(s)
            self.assertTrue(any("-raw-" in f for f in files), "what arrived is still saved")

    def test_empty_download_leaves_the_sensor_alone(self):
        s = FakeSensor(n=0)
        ok, files = self.run_dump(s)
        self.assertTrue(ok)
        self.assert_left_alone(s)
        self.assertEqual([f for f in files if "-raw-" in f], [])

    def test_nothing_is_erased_if_setting_the_clock_fails(self):
        s = FakeSensor(clock_fails=True)
        ok, _files = self.run_dump(s)
        self.assertFalse(ok)
        self.assert_left_alone(s)

    def test_reading_logged_during_the_download_is_saved_before_erasing(self):
        for during in (1, 6):
            s = FakeSensor(logs_during=during)
            ok, files = self.run_dump(s)
            self.assertTrue(ok)
            self.assertIn(0x36, s.sent)
            raw = [f for f in files if "-raw-" in f]
            self.assertEqual(len(raw), 1)
            self.assertEqual(s.sent.count(0x35), 2 if during < 4 else 3)
            self.assertEqual(self.rows, 50 + during)

    def test_waits_when_the_next_reading_is_due(self):
        waits = []
        async def fake_sleep(s):
            waits.append(s)
        real = T.asyncio.sleep
        T.asyncio.sleep = fake_sleep
        try:
            s = FakeSensor(due_in=5)
            ok, _files = self.run_dump(s)
        finally:
            T.asyncio.sleep = real
        self.assertTrue(ok)
        self.assertEqual([w for w in waits if w >= 1], [20])
        self.assertIn(0x36, s.sent)

    def test_wait_for_next_log_matches_the_app(self):
        log = [1790000000 + i * 600 for i in range(10)]
        last = log[-1]
        for now, wait in ((300, 0), (590, 25), (610, 5), (700, 0), (1195, 20)):
            self.assertEqual(T.wait_for_next_log(log, last + now), wait)
        self.assertEqual(T.wait_for_next_log(log, None), 0)

    def test_missing_records(self):
        self.assertEqual(T.missing_records([]), 0)
        self.assertEqual(T.missing_records([3, 2, 1]), 0)
        self.assertEqual(T.missing_records([0, 1, 2]), 0)
        self.assertEqual(T.missing_records([1, 2, 2, 5]), 2)


class SensorList(unittest.TestCase):
    def test_reads_list_and_both_wrapped_forms(self):
        entry = {"name": "ATC_A1B2C3", "description": "Kitchen", "address": "A4:C1:38:A1:B2:C3"}
        with tempfile.TemporaryDirectory() as d:
            for content in ([entry], {"sensors": [entry]}, {"devices": [entry]}):  # last: older files
                p = Path(d) / "sensors.json"
                p.write_text(json.dumps(content))
                self.assertEqual(T.load_sensors(str(p)), [entry])
            p.write_text(json.dumps({"something": []}))
            with self.assertRaises(ValueError):
                T.load_sensors(str(p))


class Version(unittest.TestCase):
    def test_day_dot_number(self):
        self.assertRegex(T.VERSION, r"^\d{4}-\d{2}-\d{2}\.[1-9]\d*$")


class FileNames(unittest.TestCase):
    def test_device_label(self):
        self.assertEqual(T.device_label({"name": "ATC_A1B2C3", "description": "Living room"}), "Living_room-ATC_A1B2C3")
        self.assertEqual(T.device_label({"name": "ATC_A1B2C3", "description": ""}), "ATC_A1B2C3")


if __name__ == "__main__":
    unittest.main()
