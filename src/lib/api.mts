'use strict';

import { log } from '@eeveebot/libeevee';
import { fetch } from 'undici';
import type { WeatherData, ForecastData, ApiUnits } from './types.mjs';

/**
 * Detect if a string is a US ZIP code (5 digits or ZIP+4 format).
 */
function isUSZipCode(str: string): boolean {
  return /^\d{5}(-\d{4})?$/.test(str.trim());
}

/**
 * Detect if a string is a Canadian postal code (A1A 1A1 format).
 */
function isCanadianPostalCode(str: string): boolean {
  return /^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/.test(str.trim());
}

/**
 * Convert location search string to coordinates using Nominatim geocoding.
 */
export async function zipcodeToCoordinates(
  location: string
): Promise<{ lat: number; lon: number } | null> {
  try {
    let url: string;

    if (isUSZipCode(location)) {
      url = `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(location.trim())}&countrycodes=US&format=json&limit=1`;
    } else if (isCanadianPostalCode(location)) {
      url = `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(location.trim())}&countrycodes=CA&format=json&limit=1`;
    } else {
      url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Geocoding API returned ${response.status}`);
    }

    const data = (await response.json()) as Array<{ lat: string; lon: string }>;
    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    return {
      lat: parseFloat(data[0].lat),
      lon: parseFloat(data[0].lon),
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
 * Fetch current weather data from Pirate Weather API.
 */
export async function fetchWeatherData(
  lat: number,
  lon: number,
  units: ApiUnits = 'us'
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

    return (await response.json()) as WeatherData;
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
 * Fetch forecast data from Pirate Weather API.
 */
export async function fetchForecastData(
  lat: number,
  lon: number,
  units: ApiUnits = 'us'
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

    return (await response.json()) as ForecastData;
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
