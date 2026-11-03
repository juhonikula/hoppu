<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.svg">
    <img src="assets/wordmark-light.svg" alt="hoppu" height="96">
  </picture>
</p>

# hoppu

A route finder for Helsinki region public transport (HSL) that lets you
tune how bold your transfers are. The HSL app plans with generous transfer
margins; hoppu lets you set the margin to zero, use your own walking and
running speeds, and see which tight connections are still makeable.

**Open the app:** https://juhonikula.github.io/hoppu/
(on a phone, use "Add to Home screen" to "install" it as a web app)

## What it does

- **Hoppu!** plans from where you are, right now, with zero transfer
  margin, and opens the fastest route.
- Each transfer is coloured by how much time you have at your own walking
  and running pace: green, amber, red, or violet when only running makes it.
- **Show options here** at any boarding lists earlier and later
  departures, so you can bet on a tighter connection or pick a backup.
- **Ride view:** tap a bus or train to see all its stops and the vehicle's
  live position, and check what you'd catch by getting off earlier or
  staying on longer.
- Routes you switched away from stay on the map, so you can go back.

## Your own API key

hoppu has no server. It runs entirely in your browser and talks to
[Digitransit](https://digitransit.fi/) directly with **your own** free API
key: register at the
[Digitransit developer portal](https://digitransit.fi/en/developers/api-registration/)
and paste the key into the app on first start.

## Privacy

Your key and everything you save (places, settings, own transfer times)
are stored only in your browser (localStorage). The app talks to:

- `api.digitransit.fi`: routing and address search, with your key;
- `mqtt.hsl.fi`: live vehicle positions (HSL's open feed, no key);
- `tile.openstreetmap.org`: map tiles.

Your location is used only when you ask for it (Hoppu!, "My location",
transfer options) and is sent only to Digitransit, as the start of a
route.

## Status

A vibe-coded proof of concept hobby project. Expect rough edges. Don't expect maintenance.

## Credits

Timetables and realtime data: HSL / Digitransit. Map data ©
[OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
Map library: [Leaflet](https://leafletjs.com/) (BSD-2-Clause).

## License

[MIT](LICENSE). The vendored Leaflet keeps its own BSD-2-Clause
license (`vendor/leaflet/LICENSE`).
