# ATC MiThermometer Companion

A companion for [pvvx's ATC firmware](https://github.com/pvvx/ATC_MiThermometer): read and chart the readings of a **Xiaomi Mi Temperature and Humidity Monitor 2** (LYWSD03MMC) on an **iPhone**, with no app store, no Mac and no cloud, plus a [command-line tool](python/) for the computer.

**Open the app:** https://adam-nemeth.github.io/atc-companion/ · **Try it without a sensor:** [demo](https://adam-nemeth.github.io/atc-companion/?demo)

<p>
  <img src="screenshots/sensor.png" width="270" alt="Sensor tab: latest values per sensor, sensor list with log fill level">
  <img src="screenshots/history.png" width="270" alt="Readings tab: temperature and humidity chart with min/max table">
  <img src="screenshots/compare.png" width="270" alt="Readings tab: the temperatures of three sensors compared in one chart">
</p>

## Tribute

This only works thanks to [**pvvx/ATC_MiThermometer**](https://github.com/pvvx/ATC_MiThermometer), the custom firmware by pvvx (building on atc1441's original). It gives these sensors on-device logging, a configurable clock and an open Bluetooth protocol. Everything here talks to that firmware. Thank you!

## How to use

1. Flash the pvvx firmware onto the sensor (see the [pvvx project](https://github.com/pvvx/ATC_MiThermometer)).
2. On the iPhone, install the free **Bluefy** browser (Safari has no Web Bluetooth) and open the link above.
3. **Sensor** tab: *Connect…* → pick the sensor → *Download, set clock & erase…* (*Set clock & erase* is one option, on by default; the button says what it will do, and the app asks before erasing).
4. **Readings** tab: chart (pinch to zoom, drag to move, tap for values, turn the phone sideways for full screen), min/max/average, *Compare* for several sensors in one chart, and *Export CSV* for one or more sensors (also as one ZIP file).
5. **Batch** tab: the same for all your sensors in one go, with a retry for those that failed.

Your data stays on your phone. Nothing is sent anywhere. The app reminds you to save a backup (to Files, iCloud Drive, mail…) now and then: one file with all readings, sensors and settings, which you can restore on another phone. It also warns when a sensor's log fills up or its battery gets low.

## On a computer

[`python/ATC_MiThermometer_tools.py`](python/) is a command-line tool for Windows, macOS and Linux. It does the same jobs (download, clocks, settings) for many sensors at once and keeps a growing CSV archive per sensor, in the same format as the app. See [its README](python/README.md).

## For developers

The app is a single page, [`index.html`](index.html), with its logic in [`core.js`](core.js). Tests need no installs, and run on GitHub with every push:

```
node --test tests/
python -m unittest discover -s tests
```

Both test the clock-drift correction against the same simulated sensor logs ([`tests/fixtures`](tests/fixtures/), made by [`tests/make_fixtures.py`](tests/make_fixtures.py)), so the app and the Python tool stay in step.

## License

[MIT](LICENSE)
