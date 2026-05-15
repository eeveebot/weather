'use strict';

import { log } from '@eeveebot/libeevee';
import { colorizeWeather } from '../utils/colorize.mjs';
import type { WeatherData, ForecastData, UserUnits } from './types.mjs';

/**
 * Convert temperature from Fahrenheit to the user's preferred unit.
 */
function convertTemp(tempF: number, units: UserUnits): number {
  if (units === 'metric') return Math.round(((tempF - 32) * 5) / 9);
  if (units === 'kelvin') return Math.round(((tempF - 32) * 5) / 9 + 273.15);
  return Math.round(tempF);
}

/**
 * Convert wind speed from mph to the user's preferred unit (km/h or mph).
 */
function convertWind(mph: number, units: UserUnits): number {
  if (units === 'metric' || units === 'kelvin') return Math.round(mph * 1.60934);
  return Math.round(mph);
}

/**
 * Get the temperature unit symbol.
 */
function tempUnit(units: UserUnits): string {
  if (units === 'metric') return '°C';
  if (units === 'kelvin') return 'K';
  return '°F';
}

/**
 * Get the wind speed unit symbol.
 */
function speedUnit(units: UserUnits): string {
  if (units === 'metric' || units === 'kelvin') return 'km/h';
  return 'mph';
}

/**
 * Format current weather data for display.
 */
export function formatWeatherData(
  weatherData: WeatherData,
  platform: string,
  units: UserUnits = 'imperial'
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

    const displayTemp = convertTemp(temperature, units);
    const displayHigh = daily?.temperatureHigh !== undefined
      ? convertTemp(daily.temperatureHigh, units)
      : undefined;
    const displayLow = daily?.temperatureLow !== undefined
      ? convertTemp(daily.temperatureLow, units)
      : undefined;
    const displayWindSpeed = convertWind(windSpeed, units);
    const displayWindGust = convertWind(windGust, units);
    const tu = tempUnit(units);
    const su = speedUnit(units);

    const coloredSummary = colorizeWeather(summary, platform, undefined, undefined, undefined, undefined, currently.summary);
    const coloredTemp = colorizeWeather(`${displayTemp}${tu}`, platform, displayTemp);

    let result = `${coloredSummary}, ${coloredTemp}`;

    if (displayHigh !== undefined && displayLow !== undefined) {
      const coloredHigh = colorizeWeather(`H:${displayHigh}${tu}`, platform, displayHigh);
      const coloredLow = colorizeWeather(`L:${displayLow}${tu}`, platform, displayLow);
      result += ` (${coloredHigh}/${coloredLow})`;
    }

    if (humidity > 0) {
      const coloredHumidity = colorizeWeather(`${humidity}% humidity`, platform, undefined, undefined, humidity);
      result += `, ${coloredHumidity}`;
    }

    if (displayWindSpeed > 0) {
      let windText = `${displayWindSpeed} ${su} wind`;
      if (displayWindGust > displayWindSpeed) {
        windText += ` (gusts ${displayWindGust} ${su})`;
      }
      const coloredWind = colorizeWeather(windText, platform, undefined, displayWindSpeed);
      result += `, ${coloredWind}`;
    }

    if (precipProbability > 0) {
      const coloredPrecip = colorizeWeather(`${precipChance}% chance of precipitation`, platform, undefined, undefined, undefined, precipChance);
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
 * Format 5-day forecast data for display.
 */
export function formatForecastData(
  forecastData: ForecastData,
  platform: string,
  units: UserUnits = 'imperial'
): string {
  try {
    const dailyData = forecastData.daily?.data;

    if (!dailyData || dailyData.length === 0) {
      return colorizeWeather('Unable to parse forecast data', platform);
    }

    const forecastDays = dailyData.slice(0, 5);
    const tu = tempUnit(units);

    const formattedDays = forecastDays
      .map((day) => {
        if (!day.time) return '';

        const date = new Date(day.time * 1000);
        const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });

        const displayHigh = convertTemp(day.temperatureHigh || 0, units);
        const displayLow = convertTemp(day.temperatureLow || 0, units);
        const precipChance = Math.round((day.precipProbability || 0) * 100);

        let result = `${dayName} ${displayHigh}/${displayLow}${tu}`;
        if (precipChance > 0) {
          result += ` ${precipChance}% rain`;
        }

        return colorizeWeather(result, platform, displayHigh, undefined, undefined, precipChance, day.icon);
      })
      .filter((day) => day !== '');

    return colorizeWeather(formattedDays.join(' | '), platform);
  } catch (error) {
    log.error('Failed to format forecast data', {
      producer: 'weather',
      error: error instanceof Error ? error.message : String(error),
    });
    return colorizeWeather('Unable to format forecast data', platform);
  }
}
