'use strict';

// Weather module
// Provides weather information using the Pirate Weather API

import fs from 'node:fs';
import {
  NatsClient,
  log,
  createNatsConnection,
  registerGracefulShutdown,
  createModuleMetrics,
  loadModuleConfig,
  RateLimitConfig,
  defaultRateLimit,
  registerCommand,
  sendChatMessage,
  registerHelp,
  HelpEntry,
  registerStatsHandlers
} from '@eeveebot/libeevee';
import Database from 'better-sqlite3';
import { fetch } from 'undici';
import { colorizeWeather } from './utils/colorize.mjs';

// Record module startup time for uptime tracking
const moduleStartTime = Date.now();

const metrics = createModuleMetrics('weather');

const weatherCommandUUID = 'd9de0032-5d46-41f9-a09f-33c8da28462c';
const weatherCommandDisplayName = 'weather';

const forecastCommandUUID = '16cc3c75-d406-4f16-b8ed-f8269aa1b0e0';
const forecastCommandDisplayName = 'forecast';

// Weather module configuration interface
interface WeatherConfig {
  ratelimit?: RateLimitConfig;
}

const natsClients: InstanceType<typeof NatsClient>[] = [];
const natsSubscriptions: Array<Promise<string | boolean>> = [];



//
// Do whatever teardown is necessary before calling common handler
registerGracefulShutdown(natsClients, async () => {
  if (db) db.close();
});

//
// Setup NATS connection
const nats = await createNatsConnection();
natsClients.push(nats);

// Load configuration at startup
const weatherConfig = loadModuleConfig<WeatherConfig>({});

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

  // Create table for user unit preferences
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_units (
      user_ident TEXT PRIMARY KEY,
      units TEXT NOT NULL DEFAULT 'imperial',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create table for user preferences
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_ident TEXT PRIMARY KEY,
      obscure BOOLEAN NOT NULL DEFAULT 0,
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

// Prepared statements for user unit preferences
const getUserUnitsStmt = db.prepare(
  'SELECT units FROM user_units WHERE user_ident = ?'
);
const setUserUnitsStmt = db.prepare(`
  INSERT INTO user_units (user_ident, units) 
  VALUES (?, ?)
  ON CONFLICT(user_ident) DO UPDATE SET 
    units = excluded.units,
    updated_at = CURRENT_TIMESTAMP
`);

// Prepared statements for user preferences
const getUserObscurePreferenceStmt = db.prepare(
  'SELECT obscure FROM user_preferences WHERE user_ident = ?'
);
const setUserObscurePreferenceStmt = db.prepare(`
  INSERT INTO user_preferences (user_ident, obscure) 
  VALUES (?, ?)
  ON CONFLICT(user_ident) DO UPDATE SET 
    obscure = excluded.obscure,
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
 * Get stored unit preference for a user
 * @param userIdent User identifier
 * @returns Unit preference ('metric', 'imperial', or 'kelvin') or null if not found
 */
function getUserUnits(
  userIdent: string
): 'metric' | 'imperial' | 'kelvin' | null {
  try {
    const row = getUserUnitsStmt.get(userIdent) as
      | { units: string }
      | undefined;
    return row ? (row.units as 'metric' | 'imperial' | 'kelvin') : null;
  } catch (error) {
    log.error('Failed to get user units', {
      producer: 'weather',
      userIdent,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Set unit preference for a user
 * @param userIdent User identifier
 * @param units Unit preference ('metric', 'imperial', or 'kelvin')
 */
function setUserUnits(
  userIdent: string,
  units: 'metric' | 'imperial' | 'kelvin'
): void {
  try {
    setUserUnitsStmt.run(userIdent, units);
  } catch (error) {
    log.error('Failed to set user units', {
      producer: 'weather',
      userIdent,
      units,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get user's obscure preference
 * @param userIdent User identifier
 * @returns Boolean indicating if user has obscure preference enabled
 */
function getUserObscurePreference(userIdent: string): boolean {
  try {
    const row = getUserObscurePreferenceStmt.get(userIdent) as
      | { obscure: number }
      | undefined;
    return row ? Boolean(row.obscure) : false;
  } catch (error) {
    log.error('Failed to get user obscure preference', {
      producer: 'weather',
      userIdent,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Set user's obscure preference
 * @param userIdent User identifier
 * @param obscure Boolean indicating if user wants to obscure their location
 */
function setUserObscurePreference(userIdent: string, obscure: boolean): void {
  try {
    setUserObscurePreferenceStmt.run(userIdent, obscure ? 1 : 0);
  } catch (error) {
    log.error('Failed to set user obscure preference', {
      producer: 'weather',
      userIdent,
      obscure,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Detect if a string is a US ZIP code (5 digits or ZIP+4 format)
 * @param str String to check
 * @returns True if string matches US ZIP code format
 */
function isUSZipCode(str: string): boolean {
  return /^\d{5}(-\d{4})?$/.test(str.trim());
}

/**
 * Detect if a string is a Canadian postal code (A1A 1A1 format)
 * @param str String to check
 * @returns True if string matches Canadian postal code format
 */
function isCanadianPostalCode(str: string): boolean {
  return /^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/.test(str.trim());
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
    let url: string;

    // Check if location is a ZIP code or postal code for more specific search
    if (isUSZipCode(location)) {
      // Use specific postal code search for US ZIP codes
      url = `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(location.trim())}&countrycodes=US&format=json&limit=1`;
    } else if (isCanadianPostalCode(location)) {
      // Use specific postal code search for Canadian postal codes
      url = `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(location.trim())}&countrycodes=CA&format=json&limit=1`;
    } else {
      // Use general search for other locations
      url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
    }

    // Using OpenStreetMap Nominatim for geocoding
    const response = await fetch(url);

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
 * @param units Units for weather data ('us' for imperial, 'si' for metric)
 * @returns Weather data or null if failed
 */
interface WeatherData {
  currently?: {
    temperature?: number;
    summary?: string;
    humidity?: number;
    windSpeed?: number;
    windGust?: number;
  };
  daily?: {
    data?: Array<{
      precipProbability?: number;
      temperatureHigh?: number;
      temperatureLow?: number;
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
  lon: number,
  units: 'us' | 'si' = 'us'
): Promise<WeatherData | null> {
  try {
    const apiKey = process.env.PIRATE_WEATHER_API_KEY;
    if (!apiKey) {
      throw new Error('PIRATE_WEATHER_API_KEY environment variable not set');
    }

    const response = await fetch(
      `https://api.pirateweather.net/forecast/${apiKey}/${lat},${lon}?units=${units}&exclude=minutely,hourly,alerts,flags`
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
      units,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Fetch forecast data from Pirate Weather API
 * @param lat Latitude
 * @param lon Longitude
 * @param units Units for weather data ('us' for imperial, 'si' for metric)
 * @returns Forecast data or null if failed
 */
async function fetchForecastData(
  lat: number,
  lon: number,
  units: 'us' | 'si' = 'us'
): Promise<ForecastData | null> {
  try {
    const apiKey = process.env.PIRATE_WEATHER_API_KEY;
    if (!apiKey) {
      throw new Error('PIRATE_WEATHER_API_KEY environment variable not set');
    }

    const response = await fetch(
      `https://api.pirateweather.net/forecast/${apiKey}/${lat},${lon}?units=${units}&extend=hourly`
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
      units,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Format weather data for display
 * @param weatherData Raw weather data
 * @param platform Platform identifier for colorization
 * @param units Units for weather data ('metric' or 'imperial')
 * @returns Formatted weather string
 */
function formatWeatherData(
  weatherData: WeatherData,
  platform: string,
  units: 'metric' | 'imperial' | 'kelvin' = 'imperial'
): string {
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
    const windGust = Math.round(currently.windGust || 0);
    const precipProbability = daily?.precipProbability || 0;
    const precipChance = Math.round(precipProbability * 100);

    // Daily high/low temperatures
    const temperatureHigh =
      daily?.temperatureHigh !== undefined
        ? Math.round(daily.temperatureHigh)
        : undefined;
    const temperatureLow =
      daily?.temperatureLow !== undefined
        ? Math.round(daily.temperatureLow)
        : undefined;

    // Determine unit symbols
    const tempUnit =
      units === 'metric' ? '°C' : units === 'kelvin' ? 'K' : '°F';
    const speedUnit = units === 'metric' || units === 'kelvin' ? 'km/h' : 'mph';

    // Convert temperature if needed
    let displayTemp = temperature;
    let displayHigh = temperatureHigh;
    let displayLow = temperatureLow;

    if (units === 'metric') {
      displayTemp = Math.round(((temperature - 32) * 5) / 9);
      if (displayHigh !== undefined) {
        displayHigh = Math.round(((displayHigh - 32) * 5) / 9);
      }
      if (displayLow !== undefined) {
        displayLow = Math.round(((displayLow - 32) * 5) / 9);
      }
    } else if (units === 'kelvin') {
      displayTemp = Math.round(((temperature - 32) * 5) / 9 + 273.15);
      if (displayHigh !== undefined) {
        displayHigh = Math.round(((displayHigh - 32) * 5) / 9 + 273.15);
      }
      if (displayLow !== undefined) {
        displayLow = Math.round(((displayLow - 32) * 5) / 9 + 273.15);
      }
    }

    // Convert wind speed if needed
    const displayWindSpeed =
      units === 'metric' || units === 'kelvin'
        ? Math.round(windSpeed * 1.60934)
        : windSpeed;

    const displayWindGust =
      units === 'metric' || units === 'kelvin'
        ? Math.round(windGust * 1.60934)
        : windGust;

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
      `${displayTemp}${tempUnit}`,
      platform,
      displayTemp
    );

    // Build the result with separators
    let result = `${coloredSummary}, ${coloredTemp}`;

    // Add daily high/low if available
    if (displayHigh !== undefined && displayLow !== undefined) {
      const coloredHigh = colorizeWeather(
        `H:${displayHigh}${tempUnit}`,
        platform,
        displayHigh
      );
      const coloredLow = colorizeWeather(
        `L:${displayLow}${tempUnit}`,
        platform,
        displayLow
      );
      result += ` (${coloredHigh}/${coloredLow})`;
    }

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

    if (displayWindSpeed > 0) {
      let windText = `${displayWindSpeed} ${speedUnit} wind`;
      if (displayWindGust > displayWindSpeed) {
        windText += ` (gusts ${displayWindGust} ${speedUnit})`;
      }

      const coloredWind = colorizeWeather(
        windText,
        platform,
        undefined,
        displayWindSpeed
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
 * @param units Units for weather data ('metric' or 'imperial')
 * @returns Formatted forecast string
 */
function formatForecastData(
  forecastData: ForecastData,
  platform: string,
  units: 'metric' | 'imperial' | 'kelvin' = 'imperial'
): string {
  try {
    const dailyData = forecastData.daily?.data;

    if (!dailyData || dailyData.length === 0) {
      return colorizeWeather('Unable to parse forecast data', platform);
    }

    // Get the next 5 days of forecast data
    const forecastDays = dailyData.slice(0, 5);

    // Determine unit symbols
    const tempUnit =
      units === 'metric' ? '°C' : units === 'kelvin' ? 'K' : '°F';

    const formattedDays = forecastDays
      .map((day) => {
        if (!day.time) return '';

        const date = new Date(day.time * 1000);
        const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
        const high = Math.round(day.temperatureHigh || 0);
        const low = Math.round(day.temperatureLow || 0);

        // Convert temperatures if needed
        let displayHigh = high;
        let displayLow = low;
        if (units === 'metric') {
          displayHigh = Math.round(((high - 32) * 5) / 9);
          displayLow = Math.round(((low - 32) * 5) / 9);
        } else if (units === 'kelvin') {
          displayHigh = Math.round(((high - 32) * 5) / 9 + 273.15);
          displayLow = Math.round(((low - 32) * 5) / 9 + 273.15);
        }

        const summary = day.summary ? day.summary.replace(/\.$/, '') : '';
        const precipChance = Math.round((day.precipProbability || 0) * 100);

        let result = `${dayName}: ${summary}, High: ${displayHigh}${tempUnit}, Low: ${displayLow}${tempUnit}`;

        if (precipChance > 0) {
          result += `, ${precipChance}% rain`;
        }

        // For forecast, we'll colorize each day based on the high temperature
        return colorizeWeather(
          result,
          platform,
          displayHigh,
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

// Register commands at startup using libeevee registerCommand
const weatherCmdSubs = await registerCommand(nats, {
  commandUUID: weatherCommandUUID,
  commandDisplayName: weatherCommandDisplayName,
  regex: '^weather\\s*',
  platformPrefixAllowed: true,
  ratelimit: weatherConfig.ratelimit || defaultRateLimit,
}, metrics);
natsSubscriptions.push(...weatherCmdSubs);

const forecastCmdSubs = await registerCommand(nats, {
  commandUUID: forecastCommandUUID,
  commandDisplayName: forecastCommandDisplayName,
  regex: '^(?:forecast|fivecast)\\s*',
  platformPrefixAllowed: true,
  ratelimit: weatherConfig.ratelimit || defaultRateLimit,
}, metrics);
natsSubscriptions.push(...forecastCmdSubs);

// Subscribe to command execution messages
const weatherCommandSub = nats.subscribe(
  `command.execute.${weatherCommandUUID}`,
  async (subject, message) => {
    try {
      const data = JSON.parse(message.string());
      // Send error response helper function
      const sendErrorResponse = (errorMessage: string) => {
        if (data && data.platform && data.instance && data.channel) {
          void sendChatMessage(nats, {
            channel: data.channel,
            network: data.network,
            instance: data.instance,
            platform: data.platform,
            text: errorMessage,
            trace: data.trace,
          }, metrics);
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
      // Strip the command name from the text to get just the location and flags
      const commandText = data.text.trim();

      // Parse flags for unit conversion and obscure preference
      let units: 'metric' | 'imperial' | 'kelvin' = 'imperial'; // default to imperial
      let locationSearch = commandText;
      let toggleObscure = false;
      const userIdent = `${data.platform}:${data.network}:${data.user}`;

      // Check for -o flag (obscure)
      if (commandText.includes('-o')) {
        toggleObscure = true;
        locationSearch = commandText.replace('-o', '').trim();
      }

      // Check for -k flag (Kelvin)
      if (locationSearch.includes('-k')) {
        units = 'kelvin';
        locationSearch = locationSearch.replace('-k', '').trim();
      }
      // Check for -c flag (Celsius/metric)
      else if (locationSearch.includes('-c')) {
        units = 'metric';
        locationSearch = locationSearch.replace('-c', '').trim();
      }
      // Check for -f flag (Fahrenheit/imperial)
      else if (locationSearch.includes('-f')) {
        units = 'imperial';
        locationSearch = locationSearch.replace('-f', '').trim();
      }
      // If no flags, check user's stored preference
      else {
        const storedUnits = getUserUnits(userIdent);
        if (storedUnits) {
          units = storedUnits;
        }
      }

      // If flags were used, save the preference
      if (commandText !== locationSearch) {
        setUserUnits(userIdent, units);
      }

      // Toggle obscure preference if -o flag was used
      if (toggleObscure) {
        const currentObscure = getUserObscurePreference(userIdent);
        setUserObscurePreference(userIdent, !currentObscure);
      }

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

      // Determine API units (Pirate Weather uses 'us' for imperial, 'si' for metric)
      const apiUnits = units === 'metric' || units === 'kelvin' ? 'si' : 'us';

      // Fetch weather data
      const weatherData = await fetchWeatherData(
        coordinates.lat,
        coordinates.lon,
        apiUnits
      );
      if (!weatherData) {
        sendErrorResponse(
          'Unable to fetch weather data. Please try again later.'
        );
        return;
      }

      // Format and send weather data
      const formattedWeather = formatWeatherData(
        weatherData,
        data.platform,
        units
      );

      // Check if user has obscure preference enabled
      const obscureEnabled = getUserObscurePreference(userIdent);
      const displayText = obscureEnabled
        ? data.nick || data.user
        : displayLocation;

      await sendChatMessage(nats, {
        channel: data.channel,
        network: data.network,
        instance: data.instance,
        platform: data.platform,
        text: `Weather for ${displayText}: ${formattedWeather}`,
        trace: data.trace,
      }, metrics);
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
          void sendChatMessage(nats, {
            channel: data.channel,
            network: data.network,
            instance: data.instance,
            platform: data.platform,
            text: errorMessage,
            trace: data.trace,
          }, metrics);
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
      // Strip the command name from the text to get just the location and flags
      const commandText = data.text
        .trim()
        .replace(/^(forecast|fivecast)\s*/i, '')
        .trim();

      // Parse flags for unit conversion and obscure preference
      let units: 'metric' | 'imperial' | 'kelvin' = 'imperial'; // default to imperial
      let locationSearch = commandText;
      let toggleObscure = false;
      const userIdent = `${data.platform}:${data.network}:${data.user}`;

      // Check for -o flag (obscure)
      if (commandText.includes('-o')) {
        toggleObscure = true;
        locationSearch = commandText.replace('-o', '').trim();
      }

      // Check for -k flag (Kelvin)
      if (locationSearch.includes('-k')) {
        units = 'kelvin';
        locationSearch = locationSearch.replace('-k', '').trim();
      }
      // Check for -c flag (Celsius/metric)
      else if (locationSearch.includes('-c')) {
        units = 'metric';
        locationSearch = locationSearch.replace('-c', '').trim();
      }
      // Check for -f flag (Fahrenheit/imperial)
      else if (locationSearch.includes('-f')) {
        units = 'imperial';
        locationSearch = locationSearch.replace('-f', '').trim();
      }
      // If no flags, check user's stored preference
      else {
        const storedUnits = getUserUnits(userIdent);
        if (storedUnits) {
          units = storedUnits;
        }
      }

      // If flags were used, save the preference
      if (commandText !== locationSearch) {
        setUserUnits(userIdent, units);
      }

      // Toggle obscure preference if -o flag was used
      if (toggleObscure) {
        const currentObscure = getUserObscurePreference(userIdent);
        setUserObscurePreference(userIdent, !currentObscure);
      }

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

      // Determine API units (Pirate Weather uses 'us' for imperial, 'si' for metric)
      const apiUnits = units === 'metric' || units === 'kelvin' ? 'si' : 'us';

      // Fetch forecast data
      const forecastData = await fetchForecastData(
        coordinates.lat,
        coordinates.lon,
        apiUnits
      );
      if (!forecastData) {
        sendErrorResponse(
          'Unable to fetch forecast data. Please try again later.'
        );
        return;
      }

      // Format and send forecast data
      const formattedForecast = formatForecastData(
        forecastData,
        data.platform,
        units
      );

      // Check if user has obscure preference enabled
      const obscureEnabled = getUserObscurePreference(userIdent);
      const displayText = obscureEnabled
        ? data.nick || data.user
        : displayLocation;

      await sendChatMessage(nats, {
        channel: data.channel,
        network: data.network,
        instance: data.instance,
        platform: data.platform,
        text: `5-Day Forecast for ${displayText}: ${formattedForecast}`,
        trace: data.trace,
      }, metrics);
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

// control.registerCommands subscriptions are now handled by registerCommand() above

// Subscribe to stats.uptime and stats.emit.request
const statsSubs = registerStatsHandlers({ nats, moduleName: 'weather', startTime: moduleStartTime, metrics });
natsSubscriptions.push(...statsSubs);

// Help information for weather commands
const weatherHelp: HelpEntry[] = [
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
      {
        param: '-c',
        required: false,
        descr: 'Use Celsius/metric units',
      },
      {
        param: '-f',
        required: false,
        descr: 'Use Fahrenheit/imperial units',
      },
      {
        param: '-k',
        required: false,
        descr: 'Use Kelvin units',
      },
      {
        param: '-o',
        required: false,
        descr: 'Toggle obscure mode (hides location in responses)',
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
      {
        param: '-c',
        required: false,
        descr: 'Use Celsius/metric units',
      },
      {
        param: '-f',
        required: false,
        descr: 'Use Fahrenheit/imperial units',
      },
      {
        param: '-k',
        required: false,
        descr: 'Use Kelvin units',
      },
      {
        param: '-o',
        required: false,
        descr: 'Toggle obscure mode (hides location in responses)',
      },
    ],
  },
];

// Register help using libeevee registerHelp
const helpSubs = await registerHelp(nats, 'weather', weatherHelp, metrics);
natsSubscriptions.push(...helpSubs);
