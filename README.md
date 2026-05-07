# Weather

> Current conditions and 5-day forecasts for any location, right in chat.

## Overview

The weather module provides real-time weather information and multi-day forecasts through the Pirate Weather API. It integrates with the eevee command router via NATS and responds to `!weather` and `!forecast` (alias: `!fivecast`) commands in any connected channel.

When a user provides a location, the module geocodes it via OpenStreetMap Nominatim, stores the coordinates in a local SQLite database, and fetches weather data. Subsequent requests without a location automatically reuse the stored location. Users can choose their preferred units (Fahrenheit, Celsius, or Kelvin) and toggle an obscure mode that hides their location string from responses.

Weather output is colorized on IRC using temperature, wind speed, humidity, and precipitation color ranges, with weather-condition emoji prepended to each part of the report.

## Features

- Current weather for any location (city, address, postal code, landmark, etc.)
- 5-day forecast via `!forecast` / `!fivecast`
- Per-user location storage in SQLite — set it once, query without arguments
- Configurable units: imperial (°F/mph), metric (°C/km/h), or Kelvin
- Obscure mode (`-o` flag) hides the location string from responses
- Per-user unit preference persistence
- Colorized output on IRC with weather-condition emoji
- Rate limited to prevent abuse
- Configurable through YAML configuration

## Install

This module is part of the [eevee project](https://github.com/eeveebot/eevee) and is not published independently. Install it as a workspace package:

```bash
# From the eevee project root
npm install
```

To build and run the module standalone for development:

```bash
cd weather
npm install
npm run dev
```

## Configuration

Create a `config.yaml` file with the following structure:

```yaml
# Rate limiting configuration
ratelimit:
  mode: drop       # "drop" or "queue"
  level: user      # "user" or "channel"
  limit: 5         # max requests per interval
  interval: 1m     # time window
```

All keys are optional — sensible defaults are provided by `@eeveebot/libeevee`.

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `PIRATE_WEATHER_API_KEY` | Pirate Weather API key ([get one](https://pirateweather.net/)) | Yes |
| `MODULE_CONFIG_PATH` | Path to the YAML configuration file | No |
| `MODULE_DATA` | Directory for the SQLite database (`weather.db`) | Yes |
| `NATS_HOST` | NATS server hostname | Yes |
| `NATS_TOKEN` | NATS authentication token | Yes |

## Commands

### `!weather [location] [-c|-f|-k] [-o]`

Get current weather for a location. If no location is provided, the user's previously stored location is used.

| Flag | Description |
|------|-------------|
| `-c` | Use Celsius / metric units |
| `-f` | Use Fahrenheit / imperial units |
| `-k` | Use Kelvin |
| `-o` | Toggle obscure mode (hides location in response) |

**Examples:**

```
!weather New York
!weather 90210 -c
!weather -f
!weather Tokyo -o
```

### `!forecast [location] [-c|-f|-k] [-o]`

Get a 5-day weather forecast. Alias: `!fivecast`. Accepts the same flags as `!weather`.

**Examples:**

```
!forecast London
!fivecast Berlin -c
!forecast -k
```

### Supported Location Formats

- Postal codes (US, Canada, UK, etc.) — e.g. `10001`, `M5A 1A1`
- City names — e.g. `New York`, `London`, `Tokyo`
- Addresses — e.g. `123 Main St, Anytown, ST`
- Landmarks — e.g. `Statue of Liberty`, `Eiffel Tower`

## Architecture

```
┌────────────┐    NATS     ┌──────────────────┐    HTTP     ┌─────────────────┐
│  eevee      │───────────▶│  weather module  │───────────▶│ Pirate Weather  │
│  router     │◀──────────│  (main.mts)      │◀──────────│ API             │
└────────────┘    NATS     └──────┬───────────┘    HTTP     └─────────────────┘
                                 │                          ┌─────────────────┐
                                 ├─────────────────────────▶│ OSM Nominatim   │
                                 │  geocode location        │ (geocoding)     │
                                 │◀────────────────────────│                 │
                                 │                          └─────────────────┘
                                 │
                           ┌─────┴──────┐
                           │ SQLite DB  │
                           │ weather.db │
                           └────────────┘
```

1. The router dispatches matched commands (`weather`, `forecast`/`fivecast`) to the module over NATS.
2. The module parses flags and extracts the location string.
3. If a location is provided, it is geocoded via OpenStreetMap Nominatim (with special handling for US ZIP and Canadian postal codes). Coordinates are stored in SQLite for the user.
4. If no location is provided, the module looks up the user's previously stored coordinates.
5. Weather or forecast data is fetched from the Pirate Weather API.
6. The response is formatted with colorization and emoji, then sent back to the channel via NATS.

The module uses `@eeveebot/libeevee` for NATS connectivity, command registration, rate limiting, help registration, metrics, and graceful shutdown.

## Development

```bash
# Install dependencies
npm install

# Lint
npm test

# Build (lint + TypeScript compile)
npm run build

# Build and run
npm run dev
```

### Module Structure

```
weather/
├── src/
│   ├── main.mts          # Entry point, command handlers, DB, API logic
│   └── utils/
│       └── colorize.mts  # Weather-condition emoji and IRC colorization
├── config.yaml           # Rate limit configuration
├── package.json
└── tsconfig.json
```

## Contributing

Contributions are welcome! Please see the [eevee contributing guide](https://github.com/eeveebot/eevee) for details.

## License

[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) — see [LICENSE](./LICENSE) for the full text.
