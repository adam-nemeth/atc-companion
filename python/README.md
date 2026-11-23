# ATC_MiThermometer_tools.py

Command-line companion to the [iPhone app](../README.md): the same jobs from a computer (Windows, macOS or Linux with Bluetooth LE) for Xiaomi LYWSD03MMC sensors running [pvvx's ATC_MiThermometer firmware](https://github.com/pvvx/ATC_MiThermometer).

It can find sensors, download their history to CSV, set the clock, erase the log, and read or write the configuration. It works on one sensor or on a whole list. The CSV files it writes have the same format as the app's, so either can read the other's.

## Setup

```
pip install bleak
python ATC_MiThermometer_tools.py --help
```

## Examples

Find sensors and save them to a list:

```
python ATC_MiThermometer_tools.py --scan --save-devices
```

This writes `devices_<timestamp>.json`. Fill in a `description` (room) for each sensor and rename the file to `devices.json`:

```json
[
  {"name": "ATC_A1B2C3", "description": "Kitchen", "address": "A4:C1:38:A1:B2:C3"},
  {"name": "ATC_D4E5F6", "description": "Bedroom", "address": "A4:C1:38:D4:E5:F6"}
]
```

Download every sensor's history (the clock is set afterwards):

```
python ATC_MiThermometer_tools.py --devices devices.json --dump
```

This writes `Kitchen-ATC_A1B2C3-raw-<timestamp>.csv` per download and merges all downloads into `Kitchen-ATC_A1B2C3-all.csv`.

Download and then erase the sensors' logs (asks for confirmation; `--yes` skips it):

```
python ATC_MiThermometer_tools.py --devices devices.json --dump --delete-after-dump
```

One sensor, last 500 readings, Excel-friendly (semicolons, comma decimals):

```
python ATC_MiThermometer_tools.py --dump A4:C1:38:A1:B2:C3 --out kitchen --count 500 --locale hu
```

Set the clocks (UTC), or read and write the configuration:

```
python ATC_MiThermometer_tools.py --devices devices.json --set-time
python ATC_MiThermometer_tools.py --devices devices.json --get-config
python ATC_MiThermometer_tools.py --devices devices.json --set-config
```

`--get-config` writes `Kitchen-ATC_A1B2C3-config.json` per sensor. Edit it, then `--set-config` writes it back.

Daily and monthly files as well as the merged one:

```
python ATC_MiThermometer_tools.py --devices devices.json --dump --merge-levels all,daily,monthly
```

## Good to know

- **Times are UTC**, both on the sensor and in the files. The `utc_offset` column says so.
- **Clock drift:** before downloading, the sensor's clock is read and the readings are shifted to the right time. The sensor's own time stays in the `sensor_timestamp` column. Use `--no-drift-correction` to turn this off.
- **Merging is safe to repeat:** each reading is stored once, however often it's downloaded.
- `--help` lists every option with more examples.

## License

[MIT](../LICENSE). Thanks to [pvvx](https://github.com/pvvx/ATC_MiThermometer), whose firmware and documentation made this possible.
