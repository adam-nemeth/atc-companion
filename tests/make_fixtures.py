"""Generates tests/fixtures/drift_cases.json: simulated sensor logs with known true times, used by
both the app's tests (core.test.js) and the Python tool's tests (test_tools.py).

Model: the sensor logs every 600 s of its own clock. Its clock gains `rate` seconds per second of
true time, and a clock set puts it back to the true time (error 0). Each case lists the sensor's
timestamps in log order, the true times of the same readings, and the clock reading at download.

Run from the repository root:  python tests/make_fixtures.py
"""
import json
from pathlib import Path

DAY = 86400
START = 1786000000  # 2026-08-06, a fixed start so the file never changes


def simulate(stretches, rate, missed=(), jitter=True, now_after=300):
    """stretches: list of (days, set_offset_s) - each stretch lasts `days`; at its end the clock is
    set to true time + set_offset_s (0 = correct). The last stretch ends with the download: its clock
    is read (now_sensor / now_true) instead of set. Returns ts, true, now_sensor, now_true."""
    ts, true = [], []
    t_true, err, k = START, 0.0, 0
    step = 600 / (1 + rate)                  # 600 s of sensor time, in true seconds
    for i, (days, set_off) in enumerate(stretches):
        end = t_true + days * DAY
        while t_true < end:
            if k not in missed:
                j = (k * 7919 % 3) - 1 if jitter else 0  # deterministic -1..+1 s timestamp jitter
                ts.append(round(t_true + err + j))
                true.append(round(t_true))
            k += 1
            t_true += step
            err += step * rate
        if i < len(stretches) - 1:
            err = float(set_off)             # clock set at the end of the stretch
    now_true = t_true - step + now_after     # the clock is read a few minutes after the last reading
    now_err = err - step * rate + now_after * rate
    return ts, true, round(now_true + now_err), round(now_true)


cases = []

# 1. Steady drift, the clock set at several downloads (like the August logs): every reading
#    must come back to its true time.
ts, true, ns, nt = simulate([(1, 0), (4, 0), (1.6, 0), (3, 0)], rate=43 / DAY)
cases.append({"name": "steady drift, four stretches", "ts": ts, "true": true,
              "now_sensor": ns, "now_true": nt, "expect": "corrected", "tolerance": 5})

# 2. 86 days without a set (clock ~1 h fast), then set back, with one reading missed while
#    connected right at the set (the 19 Nov Dolgozo case). Earlier stretches give the rate.
ts, true, ns, nt = simulate([(1, 0), (4, 0), (1.6, 0), (86, 0), (3, 0)], rate=43 / DAY,
                            missed={int((1 + 4 + 1.6 + 86) * DAY / 600) + 1})
cases.append({"name": "one hour fast after 86 days, set back, one reading missed", "ts": ts, "true": true,
              "now_sensor": ns, "now_true": nt, "expect": "corrected", "tolerance": 5})

# 3. A clock that keeps time: nothing may change.
ts, true, ns, nt = simulate([(2, 0)], rate=0, jitter=False)
cases.append({"name": "no drift (clock 1 s off at download)", "ts": ts, "true": true, "now_sensor": ns + 1,
              "now_true": nt, "expect": "unchanged"})

# 4. The clock was set 50 minutes wrong by hand a few hours ago: that's a jump, not drift, and
#    must not be "corrected" into the earlier readings.
ts, true, ns, nt = simulate([(1, 3000), (0.1, 0)], rate=0, jitter=False)
cases.append({"name": "clock set wrong by hand (jump, not drift)", "ts": ts, "true": true,
              "now_sensor": ns, "now_true": nt, "expect": "unchanged"})

# 5. A battery change reset the clock to 1970: leave everything alone.
cases.append({"name": "clock reset to 1970", "ts": [600 * i for i in range(1, 50)],
              "true": [600 * i for i in range(1, 50)], "now_sensor": 30000, "now_true": START,
              "expect": "unchanged"})

out = Path(__file__).parent / "fixtures" / "drift_cases.json"
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(cases, separators=(",", ":")) + "\n")
print(f"wrote {out} ({len(cases)} cases, {sum(len(c['ts']) for c in cases)} readings)")
