# ATC_MiThermometer_tools.py

A command-line tool for **Xiaomi LYWSD03MMC** thermometers running [pvvx's ATC_MiThermometer firmware](https://github.com/pvvx/ATC_MiThermometer). It runs on any computer with Bluetooth LE (Windows, macOS, Linux).

## What it's for

The pvvx firmware makes each sensor log a reading every few minutes into its own memory, typically a few months' worth. This tool collects those logs onto your computer and keeps them:

- **Downloads the readings** of one sensor or of all your sensors in one run. It's made for running regularly, e.g. weekly by hand or from Task Scheduler / cron.
- **Builds a growing archive.** Every download is kept as its own file and merged into one `-all.csv` per sensor. Each reading appears once, no matter how often it was downloaded or how much the downloads overlap. Readings shared from the [iPhone app](../README.md) are merged in too.
- **Keeps the sensors healthy:** after each download it sets their clocks (in UTC) and erases their logs, so the next download starts fresh. It also reads and writes their settings (measurement and logging intervals, display options, calibration).
- **Corrects clock drift.** The sensors' clocks run fast or slow. Before each download the tool reads the clock and moves the readings back to the right time.

It talks to the sensors directly over Bluetooth: no app, no gateway, no cloud.

## Setup

Python 3.9 or newer, plus one package:

```
pip install bleak
python ATC_MiThermometer_tools.py --help
```

## Examples

**1. Find your sensors** and save them to a list:

```
python ATC_MiThermometer_tools.py --scan --save-sensors
```

This writes `sensors_<timestamp>.json`. Give each sensor a `description` (e.g. where it is) and rename the file to `sensors.json`:

```json
[
  {"name": "ATC_A1B2C3", "description": "Kitchen", "address": "A4:C1:38:A1:B2:C3"},
  {"name": "ATC_D4E5F6", "description": "Bedroom", "address": "A4:C1:38:D4:E5:F6"}
]
```

**2. Download every sensor's readings:**

```
python ATC_MiThermometer_tools.py --sensors sensors.json --dump
```

Each run writes `Kitchen-ATC_A1B2C3-raw-<timestamp>.csv` and updates `Kitchen-ATC_A1B2C3-all.csv`, which holds everything so far. Then each sensor's clock is set and its log is erased.

The clock is set and the log erased together or not at all, and only when the whole log was downloaded and saved to the file first. After an interrupted, partial (`--count`) or empty download, or one with missing readings, the sensor is left alone.

**3. Only download** (clocks and logs stay as they are):

```
python ATC_MiThermometer_tools.py --sensors sensors.json --dump --keep-log
```

**4. One sensor, last 500 readings, Excel-friendly CSV** (semicolons, decimal commas). Only part of the log is downloaded, so the sensor is left alone:

```
python ATC_MiThermometer_tools.py --dump A4:C1:38:A1:B2:C3 --out kitchen --count 500 --locale hu
```

**5. Clocks and settings:**

```
python ATC_MiThermometer_tools.py --sensors sensors.json --set-time
python ATC_MiThermometer_tools.py --sensors sensors.json --get-config
python ATC_MiThermometer_tools.py --sensors sensors.json --set-config
```

`--get-config` saves `Kitchen-ATC_A1B2C3-config.json` per sensor. Edit it and `--set-config` writes it back.

**6. Daily and monthly files** next to the merged one:

```
python ATC_MiThermometer_tools.py --sensors sensors.json --dump --merge-levels all,daily,monthly
```

## The CSV files

| Column | |
|---|---|
| `timestamp` | When the reading was taken, in UTC, corrected for clock drift |
| `utc_offset` | `+00:00`: the timestamp is UTC |
| `temperature_c`, `humidity_pct`, `battery_mv` | The reading |
| `sensor_timestamp` | The sensor's own (uncorrected) time, when it differs |

Clock sets made by the tool are remembered in `clock_log.json` in the folder you run it from; they make the drift correction exact. `--no-drift-correction` turns the correction off. `--help` lists every option with more examples.

## License

[MIT](../LICENSE). Thanks to [pvvx](https://github.com/pvvx/ATC_MiThermometer), whose firmware and documentation made this possible.
