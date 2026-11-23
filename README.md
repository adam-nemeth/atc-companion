# atc-thermo

Read and chart the history of a **Xiaomi Mi Temperature and Humidity Monitor 2** (LYWSD03MMC) on an **iPhone**: no app store, no Mac, no cloud.

**Open the app:** https://adam-nemeth.github.io/atc-thermo/

## Tribute

This only works thanks to [**pvvx/ATC_MiThermometer**](https://github.com/pvvx/ATC_MiThermometer), the custom firmware by pvvx (building on atc1441's original). It gives these sensors on-device history logging, a configurable clock and an open Bluetooth protocol. Everything here talks to that firmware. Thank you!

## How to use

1. Flash the pvvx firmware onto the sensor (see the [pvvx project](https://github.com/pvvx/ATC_MiThermometer)).
2. On the iPhone, install the free **Bluefy** browser (Safari has no Web Bluetooth) and open the link above.
3. **Sensor** tab: *Connect…* → pick the sensor → *Download history*. The clock is set and the sensor's log is erased afterwards (both optional).
4. **History** tab: chart (pinch to zoom, drag to move, tap for values), min/max/average, and *Share* to export CSV.
5. **Batch** tab: the same for all your sensors in one go.

Your data stays on your phone. Nothing is sent anywhere.

## On a computer

[`python/ATC_MiThermometer_tools.py`](python/) does the same from Windows, macOS or Linux, in the same CSV format. See [its README](python/README.md) for examples.

## License

[MIT](LICENSE)
