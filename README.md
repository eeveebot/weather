# Weather Module

This module provides weather information using the Pirate Weather API.

## Features

- Get current weather for any location (city, address, postal code, etc.)
- Stores user's location search string and coordinates in SQLite database
- Rate limited to prevent abuse
- Configurable through YAML configuration
- Supports global locations

## Commands

- `weather [location]` - Get current weather for a location (location is optional if previously set)

## Configuration

Create a `config.yaml` file with the following structure:

```yaml
# Rate limiting configuration
ratelimit:
  mode: drop
  level: user
  limit: 5
  interval: 1m
```

## Environment Variables

- `MODULE_CONFIG_PATH` - Path to the YAML configuration file
- `MODULE_DATA` - Path to the directory where the SQLite database will be stored
- `NATS_HOST` - NATS server hostname
- `NATS_TOKEN` - NATS authentication token
- `PIRATE_WEATHER_API_KEY` - Pirate Weather API key (get one at https://pirateweather.net/)

## How it works

1. When a user provides a location string, it's converted to coordinates using OpenStreetMap Nominatim
2. Both the original search string and coordinates are stored in a SQLite database for that user
3. Subsequent requests without a location use the stored search string and coordinates
4. Weather data is fetched from the Pirate Weather API using the coordinates

## Supported Location Formats

You can use various location formats:

- Postal codes (US, Canada, UK, etc.)
- City names ("New York", "London", "Tokyo")
- Addresses ("123 Main St, Anytown, ST")
- Landmarks ("Statue of Liberty", "Eiffel Tower")
