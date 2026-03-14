'use strict';

// Weather module
// Provides weather information using the Pirate Weather API

import fs from 'node:fs';
import yaml from 'js-yaml';
import { NatsClient, log } from '@eeveebot/libeevee';
import Database from 'better-sqlite3';
import { fetch } from 'undici';
import { colorizeWeather } from './utils/colorize.mjs';

// Record module startup time for uptime tracking
const moduleStartTime = Date.now();

const weatherCommandUUID = 'd9de0032-5d46-41f9-a09f-33c8da28462c';
const weatherCommandDisplayName = 'weather';

const forecastCommandUUID = '16cc3c75-d406-4f16-b8ed-f8269aa1b0e0';
const forecastCommandDisplayName = 'forecast';

// Rate limit configuration interface
interface RateLimitConfig {
  mode: 'enqueue' | 'drop';
  level: 'channel' | 'user' | 'global';
  limit: number;
  interval: string; // e.g., "30s", "1m", "5m"
}

// Weather module configuration interface
interface WeatherConfig {
  ratelimit?: RateLimitConfig;
}

const natsClients: InstanceType<typeof NatsClient>[] = [];
const natsSubscriptions: Array<Promise<string | boolean>> = [];

/**
 * Load weather configuration from YAML file
 * @returns WeatherConfig parsed from YAML file
 */
function loadWeatherConfig(): WeatherConfig {
  // Get the config file path from environment variable
  const configPath = process.env.MODULE_CONFIG_PATH;
  if (!configPath) {
    log.warn('MODULE_CONFIG_PATH not set, using default config', {
      producer: 'weather',
    });
    return {};
  }

  try {
    // Read the YAML file
    const configFile = fs.readFileSync(configPath, 'utf8');

    // Parse the YAML content
    const config = yaml.load(configFile) as WeatherConfig;

    log.info('Loaded weather configuration', {
      producer: 'weather',
      configPath,
    });

    return config;
  } catch (error) {
    log.error('Failed to load weather configuration, using defaults', {
      producer: 'weather',
      configPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

//
// Do whatever teardown is necessary before calling common handler
process.on('SIGINT', () => {
  natsClients.forEach((natsClient) => {
    void natsClient.drain();
  });
});

process.on('SIGTERM', () => {
  natsClients.forEach((natsClient) => {
    void natsClient.drain();
  });
});

//
// Setup NATS connection

// Get host and token
const natsHost = process.env.NATS_HOST || false;
if (!natsHost) {
  const msg = 'environment variable NATS_HOST is not set.';
  throw new Error(msg);
}

const natsToken = process.env.NATS_TOKEN || false;
if (!natsToken) {
  const msg = 'environment variable NATS_TOKEN is not set.';
  throw new Error(msg);
}

const nats = new NatsClient({
  natsHost: natsHost as string,
  natsToken: natsToken as string,
});
natsClients.push(nats);
await nats.connect();

// Load configuration at startup
const weatherConfig = loadWeatherConfig();

// Initialize SQLite database
let db: Database.Database | null = null;
try {
  const moduleDataPath = process.env.MODULE_DATA;
  if (!moduleDataPath) {
    throw new Error('MODULE_DATA environment variable not set');
  }

  // Ensure the directory exists
  if (!fs.existsSync(moduleDataPath)) {
    fs.mkdirSync(moduleDataPath, { recursive: true });
  }

  const dbPath = `${moduleDataPath}/weather.db`;
  db = new Database(dbPath);

  // Create tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_locations (
      user_ident TEXT PRIMARY KEY,
      search_string TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  log.info('Initialized weather database', {
    producer: 'weather',
    dbPath,
  });
} catch (error) {
  log.error('Failed to initialize database', {
    producer: 'weather',
    error: error instanceof Error ? error.message : String(error),
  });
  throw error;
}

// Prepared statements for database operations
const getUserLocationStmt = db.prepare(
  'SELECT search_string, latitude, longitude FROM user_locations WHERE user_ident = ?'
);
const setUserLocationStmt = db.prepare(`
  INSERT INTO user_locations (user_ident, search_string, latitude, longitude) 
  VALUES (?, ?, ?, ?)
  ON CONFLICT(user_ident) DO UPDATE SET 
    search_string = excluded.search_string,
    latitude = excluded.latitude,
    longitude = excluded.longitude,
    updated_at = CURRENT_TIMESTAMP
`);

/**
 * Get stored location for a user
 * @param userIdent User identifier
 * @returns Location data or null if not found
 */
function getUserLocation(
  userIdent: string
): { searchString: string; lat: number; lon: number } | null {
  try {
    const row = getUserLocationStmt.get(userIdent) as
      | { search_string: string; latitude: number; longitude: number }
      | undefined;
    return row
      ? {
          searchString: row.search_string,
          lat: row.latitude,
          lon: row.longitude,
        }
      : null;
  } catch (error) {
    log.error('Failed to get user location', {
      producer: 'weather',
      userIdent,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Set location for a user
 * @param userIdent User identifier
 * @param searchString Original search string
 * @param lat Latitude
 * @param lon Longitude
 */
function setUserLocation(
  userIdent: string,
  searchString: string,
  lat: number,
  lon: number
): void {
  try {
    setUserLocationStmt.run(userIdent, searchString, lat, lon);
  } catch (error) {
    log.error('Failed to set user location', {
      producer: 'weather',
      userIdent,
      searchString,
      lat,
      lon,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Convert location search string to coordinates using a geocoding service
 * @param location Location search string
 * @returns Latitude and longitude or null if failed
 */
async function zipcodeToCoordinates(
  location: string
): Promise<{ lat: number; lon: number } | null> {
  try {
    // Using OpenStreetMap Nominatim for geocoding
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`
    );

    if (!response.ok) {
      throw new Error(`Geocoding API returned ${response.status}`);
    }

    const data = (await response.json()) as
      | Array<{ lat: string; lon: string }>
      | [];

    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    const firstResult = data[0] as { lat: string; lon: string };
    return {
      lat: parseFloat(firstResult.lat),
      lon: parseFloat(firstResult.lon),
    };
  } catch (error) {
    log.error('Failed to convert location to coordinates', {
      producer: 'weather',
      location,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Fetch weather data from Pirate Weather API
 * @param lat Latitude
 * @param lon Longitude
 * @returns Weather data or null if failed
 */
interface WeatherData {
  currently?: {
    temperature?: number;
    summary?: string;
    humidity?: number;
    windSpeed?: number;
  };
  daily?: {
    data?: Array<{
      precipProbability?: number;
    }>;
  };
}

interface ForecastData {
  daily?: {
    data?: Array<{
      time?: number;
      summary?: string;
      temperatureHigh?: number;
      temperatureLow?: number;
      precipProbability?: number;
      icon?: string;
    }>;
  };
}

async function fetchWeatherData(
  lat: number,
  lon: number
): Promise<WeatherData | null> {
  try {
    const apiKey = process.env.PIRATE_WEATHER_API_KEY;
    if (!apiKey) {
      throw new Error('PIRATE_WEATHER_API_KEY environment variable not set');
    }

    const response = await fetch(
      `https://api.pirateweather.net/forecast/${apiKey}/${lat},${lon}?units=us`
    );

    if (!response.ok) {
      throw new Error(`Pirate Weather API returned ${response.status}`);
    }

    const data = (await response.json()) as WeatherData;
    return data;
  } catch (error) {
    log.error('Failed to fetch weather data', {
      producer: 'weather',
      lat,
      lon,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Fetch forecast data from Pirate Weather API
 * @param lat Latitude
 * @param lon Longitude
 * @returns Forecast data or null if failed
 */
async function fetchForecastData(
  lat: number,
  lon: number
): Promise<ForecastData | null> {
  try {
    const apiKey = process.env.PIRATE_WEATHER_API_KEY;
    if (!apiKey) {
      throw new Error('PIRATE_WEATHER_API_KEY environment variable not set');
    }

    const response = await fetch(
      `https://api.pirateweather.net/forecast/${apiKey}/${lat},${lon}?units=us&extend=hourly`
    );

    if (!response.ok) {
      throw new Error(`Pirate Weather API returned ${response.status}`);
    }

    const data = (await response.json()) as ForecastData;
    return data;
  } catch (error) {
    log.error('Failed to fetch forecast data', {
      producer: 'weather',
      lat,
      lon,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Format weather data for display
 * @param weatherData Raw weather data
 * @param platform Platform identifier for colorization
 * @returns Formatted weather string
 */
function formatWeatherData(weatherData: WeatherData, platform: string): string {
  try {
    const currently = weatherData.currently;
    const daily = weatherData.daily?.data?.[0];

    if (!currently) {
      return colorizeWeather('Unable to parse weather data', platform);
    }

    const temperature = Math.round(currently.temperature || 0);
    const summary = currently.summary || 'Unknown conditions';
    const humidity = Math.round((currently.humidity || 0) * 100);
    const windSpeed = Math.round(currently.windSpeed || 0);
    const precipProbability = daily?.precipProbability || 0;
    const precipChance = Math.round(precipProbability * 100);

    // Colorize each part separately for more varied colors
    const coloredSummary = colorizeWeather(
      summary,
      platform,
      undefined,
      undefined,
      undefined,
      undefined,
      currently.summary
    );
    const coloredTemp = colorizeWeather(
      `${temperature}°F`,
      platform,
      temperature
    );

    // Build the result with separators
    let result = `${coloredSummary}, ${coloredTemp}`;

    if (humidity > 0) {
      const coloredHumidity = colorizeWeather(
        `${humidity}% humidity`,
        platform,
        undefined,
        undefined,
        humidity
      );
      result += `, ${coloredHumidity}`;
    }

    if (windSpeed > 0) {
      const coloredWind = colorizeWeather(
        `${windSpeed} mph wind`,
        platform,
        undefined,
        windSpeed
      );
      result += `, ${coloredWind}`;
    }

    if (precipProbability > 0) {
      const coloredPrecip = colorizeWeather(
        `${precipChance}% chance of precipitation`,
        platform,
        undefined,
        undefined,
        undefined,
        precipChance
      );
      result += `, ${coloredPrecip}`;
    }

    return result;
  } catch (error) {
    log.error('Failed to format weather data', {
      producer: 'weather',
      error: error instanceof Error ? error.message : String(error),
    });
    return colorizeWeather('Unable to format weather data', platform);
  }
}

/**
 * Format forecast data for display
 * @param forecastData Raw forecast data
 * @param platform Platform identifier for colorization
 * @returns Formatted forecast string
 */
function formatForecastData(
  forecastData: ForecastData,
  platform: string
): string {
  try {
    const dailyData = forecastData.daily?.data;

    if (!dailyData || dailyData.length === 0) {
      return colorizeWeather('Unable to parse forecast data', platform);
    }

    // Get the next 5 days of forecast data
    const forecastDays = dailyData.slice(0, 5);

    const formattedDays = forecastDays
      .map((day) => {
        if (!day.time) return '';

        const date = new Date(day.time * 1000);
        const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
        const high = Math.round(day.temperatureHigh || 0);
        const low = Math.round(day.temperatureLow || 0);
        const summary = day.summary ? day.summary.replace(/\.$/, '') : '';
        const precipChance = Math.round((day.precipProbability || 0) * 100);

        let result = `${dayName}: ${summary}, High: ${high}°F, Low: ${low}°F`;

        if (precipChance > 0) {
          result += `, ${precipChance}% rain`;
        }

        // For forecast, we'll colorize each day based on the high temperature
        return colorizeWeather(
          result,
          platform,
          high,
          undefined,
          undefined,
          precipChance,
          day.icon
        );
      })
      .filter((day) => day !== '');

    const result = formattedDays.join(' | ');
    return colorizeWeather(result, platform);
  } catch (error) {
    log.error('Failed to format forecast data', {
      producer: 'weather',
      error: error instanceof Error ? error.message : String(error),
    });
    return colorizeWeather('Unable to format forecast data', platform);
  }
}

// Function to register the weather command with the router
async function registerWeatherCommand(): Promise<void> {
  // Default rate limit configuration
  const defaultRateLimit = {
    mode: 'drop',
    level: 'user',
    limit: 5,
    interval: '1m',
  };

  // Use configured rate limit or default
  const rateLimitConfig = weatherConfig.ratelimit || defaultRateLimit;

  const commandRegistration = {
    type: 'command.register',
    commandUUID: weatherCommandUUID,
    commandDisplayName: weatherCommandDisplayName,
    platform: '.*', // Match all platforms
    network: '.*', // Match all networks
    instance: '.*', // Match all instances
    channel: '.*', // Match all channels
    user: '.*', // Match all users
    regex: 'weather(?:\\s+(.+))?$', // Match weather with optional location
    platformPrefixAllowed: true,
    ratelimit: rateLimitConfig,
  };

  try {
    await nats.publish('command.register', JSON.stringify(commandRegistration));
    log.info('Registered weather command with router', {
      producer: 'weather',
      ratelimit: rateLimitConfig,
    });
  } catch (error) {
    log.error('Failed to register weather command', {
      producer: 'weather',
      error: error,
    });
  }
}

// Function to register the forecast command with the router
async function registerForecastCommand(): Promise<void> {
  // Default rate limit configuration
  const defaultRateLimit = {
    mode: 'drop',
    level: 'user',
    limit: 5,
    interval: '1m',
  };

  // Use configured rate limit or default
  const rateLimitConfig = weatherConfig.ratelimit || defaultRateLimit;

  const commandRegistration = {
    type: 'command.register',
    commandUUID: forecastCommandUUID,
    commandDisplayName: forecastCommandDisplayName,
    platform: '.*', // Match all platforms
    network: '.*', // Match all networks
    instance: '.*', // Match all instances
    channel: '.*', // Match all channels
    user: '.*', // Match all users
    regex: '(?:forecast|fivecast)(?:\\s+(.+))?$', // Match forecast/fivecast with optional location
    platformPrefixAllowed: true,
    ratelimit: rateLimitConfig,
  };

  try {
    await nats.publish('command.register', JSON.stringify(commandRegistration));
    log.info('Registered forecast command with router', {
      producer: 'weather',
      ratelimit: rateLimitConfig,
    });
  } catch (error) {
    log.error('Failed to register forecast command', {
      producer: 'weather',
      error: error,
    });
  }
}

// Register commands at startup
await registerWeatherCommand();
await registerForecastCommand();

// Subscribe to command execution messages
const weatherCommandSub = nats.subscribe(
  `command.execute.${weatherCommandUUID}`,
  async (subject, message) => {
    try {
      const data = JSON.parse(message.string());
      // Send error response helper function
      const sendErrorResponse = (errorMessage: string) => {
        if (data && data.platform && data.instance && data.channel) {
          const response = {
            channel: data.channel,
            network: data.network,
            instance: data.instance,
            platform: data.platform,
            text: errorMessage,
            trace: data.trace,
            type: 'message.outgoing',
          };

          const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
          void nats.publish(outgoingTopic, JSON.stringify(response));
        }
      };

      log.info('Received command.execute for weather', {
        producer: 'weather',
        platform: data.platform,
        instance: data.instance,
        channel: data.channel,
        user: data.user,
        originalText: data.originalText,
      });

      // Extract location from the command (optional)
      // Strip the command name from the text to get just the location
      const locationSearch = data.text
        .trim()
        .replace(/^weather\s*/i, '')
        .trim();

      let coordinates = null;
      let displayLocation = '';

      // If location provided in command, convert to coordinates
      if (locationSearch) {
        // Convert location search to coordinates
        coordinates = await zipcodeToCoordinates(locationSearch);
        if (!coordinates) {
          sendErrorResponse(`Unable to find location for "${locationSearch}"`);
          return;
        }

        displayLocation = locationSearch;

        // Store the location for this user
        const userIdent = `${data.platform}:${data.network}:${data.user}`;
        setUserLocation(
          userIdent,
          locationSearch,
          coordinates.lat,
          coordinates.lon
        );
      } else {
        // No location provided, check stored location
        const userIdent = `${data.platform}:${data.network}:${data.user}`;
        const storedLocation = getUserLocation(userIdent);
        if (storedLocation) {
          coordinates = { lat: storedLocation.lat, lon: storedLocation.lon };
          displayLocation = storedLocation.searchString;
        } else {
          sendErrorResponse(
            'Please provide a location or set one with "weather <location>" first'
          );
          return;
        }
      }

      // Fetch weather data
      const weatherData = await fetchWeatherData(
        coordinates.lat,
        coordinates.lon
      );
      if (!weatherData) {
        sendErrorResponse(
          'Unable to fetch weather data. Please try again later.'
        );
        return;
      }

      // Format and send weather data
      const formattedWeather = formatWeatherData(weatherData, data.platform);

      const response = {
        channel: data.channel,
        network: data.network,
        instance: data.instance,
        platform: data.platform,
        text: `Weather for ${displayLocation}: ${formattedWeather}`,
        trace: data.trace,
        type: 'message.outgoing',
      };

      const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
      void nats.publish(outgoingTopic, JSON.stringify(response));
    } catch (error) {
      log.error('Failed to process weather command', {
        producer: 'weather',
        error: error instanceof Error ? error.message : String(error),
      });

      // We can't send a specific error response since we don't have the data structure
      // The error has been logged, so we'll just silently fail
    }
  }
);
natsSubscriptions.push(weatherCommandSub);

// Subscribe to forecast command execution messages
const forecastCommandSub = nats.subscribe(
  `command.execute.${forecastCommandUUID}`,
  async (subject, message) => {
    try {
      const data = JSON.parse(message.string());
      // Send error response helper function
      const sendErrorResponse = (errorMessage: string) => {
        if (data && data.platform && data.instance && data.channel) {
          const response = {
            channel: data.channel,
            network: data.network,
            instance: data.instance,
            platform: data.platform,
            text: errorMessage,
            trace: data.trace,
            type: 'message.outgoing',
          };

          const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
          void nats.publish(outgoingTopic, JSON.stringify(response));
        }
      };

      log.info('Received command.execute for forecast', {
        producer: 'weather',
        platform: data.platform,
        instance: data.instance,
        channel: data.channel,
        user: data.user,
        originalText: data.originalText,
      });

      // Extract location from the command (optional)
      // Strip the command name from the text to get just the location
      const locationSearch = data.text
        .trim()
        .replace(/^(forecast|fivecast)\s*/i, '')
        .trim();

      let coordinates = null;
      let displayLocation = '';

      // If location provided in command, convert to coordinates
      if (locationSearch) {
        // Convert location search to coordinates
        coordinates = await zipcodeToCoordinates(locationSearch);
        if (!coordinates) {
          sendErrorResponse(`Unable to find location for "${locationSearch}"`);
          return;
        }

        displayLocation = locationSearch;

        // Store the location for this user
        const userIdent = `${data.platform}:${data.network}:${data.user}`;
        setUserLocation(
          userIdent,
          locationSearch,
          coordinates.lat,
          coordinates.lon
        );
      } else {
        // No location provided, check stored location
        const userIdent = `${data.platform}:${data.network}:${data.user}`;
        const storedLocation = getUserLocation(userIdent);
        if (storedLocation) {
          coordinates = { lat: storedLocation.lat, lon: storedLocation.lon };
          displayLocation = storedLocation.searchString;
        } else {
          sendErrorResponse(
            'Please provide a location or set one with "forecast <location>" first'
          );
          return;
        }
      }

      // Fetch forecast data
      const forecastData = await fetchForecastData(
        coordinates.lat,
        coordinates.lon
      );
      if (!forecastData) {
        sendErrorResponse(
          'Unable to fetch forecast data. Please try again later.'
        );
        return;
      }

      // Format and send forecast data
      const formattedForecast = formatForecastData(forecastData, data.platform);

      const response = {
        channel: data.channel,
        network: data.network,
        instance: data.instance,
        platform: data.platform,
        text: `5-Day Forecast for ${displayLocation}: ${formattedForecast}`,
        trace: data.trace,
        type: 'message.outgoing',
      };

      const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
      void nats.publish(outgoingTopic, JSON.stringify(response));
    } catch (error) {
      log.error('Failed to process forecast command', {
        producer: 'weather',
        error: error instanceof Error ? error.message : String(error),
      });

      // We can't send a specific error response since we don't have the data structure
      // The error has been logged, so we'll just silently fail
    }
  }
);
natsSubscriptions.push(forecastCommandSub);

// Subscribe to control messages for re-registering commands
const controlSubRegisterCommandWeather = nats.subscribe(
  `control.registerCommands.${weatherCommandDisplayName}`,
  () => {
    log.info(
      `Received control.registerCommands.${weatherCommandDisplayName} control message`,
      {
        producer: 'weather',
      }
    );
    void registerWeatherCommand();
  }
);
natsSubscriptions.push(controlSubRegisterCommandWeather);

const controlSubRegisterCommandForecast = nats.subscribe(
  `control.registerCommands.${forecastCommandDisplayName}`,
  () => {
    log.info(
      `Received control.registerCommands.${forecastCommandDisplayName} control message`,
      {
        producer: 'weather',
      }
    );
    void registerForecastCommand();
  }
);
natsSubscriptions.push(controlSubRegisterCommandForecast);

const controlSubRegisterCommandAll = nats.subscribe(
  'control.registerCommands',
  () => {
    log.info('Received control.registerCommands control message', {
      producer: 'weather',
    });
    void registerWeatherCommand();
    void registerForecastCommand();
  }
);
natsSubscriptions.push(controlSubRegisterCommandAll);

// Subscribe to stats.uptime messages and respond with module uptime
const statsUptimeSub = nats.subscribe('stats.uptime', (subject, message) => {
  try {
    const data = JSON.parse(message.string());
    log.info('Received stats.uptime request', {
      producer: 'weather',
      replyChannel: data.replyChannel,
    });

    // Calculate uptime in milliseconds
    const uptime = Date.now() - moduleStartTime;

    // Send uptime back via the ephemeral reply channel
    const uptimeResponse = {
      module: 'weather',
      uptime: uptime,
      uptimeFormatted: `${Math.floor(uptime / 86400000)}d ${Math.floor((uptime % 86400000) / 3600000)}h ${Math.floor((uptime % 3600000) / 60000)}m ${Math.floor((uptime % 60000) / 1000)}s`,
    };

    if (data.replyChannel) {
      void nats.publish(data.replyChannel, JSON.stringify(uptimeResponse));
    }
  } catch (error) {
    log.error('Failed to process stats.uptime request', {
      producer: 'weather',
      error: error,
    });
  }
});
natsSubscriptions.push(statsUptimeSub);

// Help information for weather commands
const weatherHelp = [
  {
    command: 'weather',
    descr:
      'Get current weather for a location (location can be omitted if previously set)',
    params: [
      {
        param: '[location]',
        required: false,
        descr: 'Any location string (address, city, postal code, etc.)',
      },
    ],
  },
  {
    command: 'forecast',
    descr:
      'Get 5-day weather forecast for a location (location can be omitted if previously set)',
    aliases: ['fivecast'],
    params: [
      {
        param: '[location]',
        required: false,
        descr: 'Any location string (address, city, postal code, etc.)',
      },
    ],
  },
];

// Function to publish help information
async function publishHelp(): Promise<void> {
  const helpUpdate = {
    from: 'weather',
    help: weatherHelp,
  };

  try {
    await nats.publish('_help.update', JSON.stringify(helpUpdate));
    log.info('Published weather help information', {
      producer: 'weather',
    });
  } catch (error) {
    log.error('Failed to publish weather help information', {
      producer: 'weather',
      error: error,
    });
  }
}

// Publish help information at startup
await publishHelp();

// Subscribe to help update requests
const helpUpdateRequestSub = nats.subscribe('_help.updateRequest', () => {
  log.info('Received _help.updateRequest message', {
    producer: 'weather',
  });
  void publishHelp();
});
natsSubscriptions.push(helpUpdateRequestSub);
