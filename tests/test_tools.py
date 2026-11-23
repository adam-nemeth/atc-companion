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


class FileNames(unittest.TestCase):
    def test_device_label(self):
        self.assertEqual(T.device_label({"name": "ATC_A1B2C3", "description": "Living room"}), "Living_room-ATC_A1B2C3")
        self.assertEqual(T.device_label({"name": "ATC_A1B2C3", "description": ""}), "ATC_A1B2C3")


if __name__ == "__main__":
    unittest.main()
