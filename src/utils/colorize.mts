import {
  colorizeByValue,
  type ValueColorRange,
} from '@eeveebot/libeevee';

// Weather condition icons - trailing spaces intentional
const weatherIcons: Record<string, string> = {
  'clear-day': '☀️ ',
  'clear-night': '🌙 ',
  rain: '🌧️ ',
  snow: '❄️ ',
  sleet: '🌨️ ',
  wind: '💨 ',
  fog: '🌫️ ',
  cloudy: '☁️ ',
  'partly-cloudy-day': '⛅ ',
  'partly-cloudy-night': '☁️🌙 ',
  thunderstorm: '⛈️ ',
  tornado: '🌪️ ',
  hail: '🌨️ ',
  unknown: '❓ ',
};

/**
 * Get a weather emoji for a condition string.
 * Normalizes case/whitespace and falls back to ❓.
 */
export function getWeatherIcon(condition: string): string {
  const normalized = condition.toLowerCase().trim();
  if (weatherIcons[normalized]) return weatherIcons[normalized];
  for (const [key, icon] of Object.entries(weatherIcons)) {
    if (normalized.includes(key)) return icon;
  }
  return weatherIcons.unknown;
}

// Temperature → color range (Fahrenheit)
const tempColorDef: ValueColorRange = {
  ranges: [
    { max: 32, color: 'blue' },
    { max: 50, color: 'cyan' },
    { max: 70, color: 'green' },
    { max: 80, color: 'yellow' },
    { max: 90, color: 'olive' },
  ],
  fallback: 'red',
};

// Wind speed → color range (mph)
const windColorDef: ValueColorRange = {
  ranges: [
    { max: 5, color: 'green' },
    { max: 15, color: 'yellow' },
    { max: 25, color: 'olive' },
  ],
  fallback: 'red',
};

// Humidity → color range (%)
const humidityColorDef: ValueColorRange = {
  ranges: [
    { max: 30, color: 'olive' },
    { max: 70, color: 'green' },
  ],
  fallback: 'blue',
};

// Precipitation probability → color range (%)
const precipColorDef: ValueColorRange = {
  ranges: [
    { max: 20, color: 'green' },
    { max: 50, color: 'yellow' },
    { max: 80, color: 'olive' },
  ],
  fallback: 'red',
};


/**
 * Colorize weather text based on platform and weather metrics
 */
export function colorizeWeather(
  text: string,
  platform: string,
  temperature?: number,
  windSpeed?: number,
  humidity?: number,
  precipitation?: number,
  condition?: string
): string {
  // Add weather icon if condition is provided
  let resultText = text;
  if (condition) {
    const icon = getWeatherIcon(condition);
    resultText = `${icon} ${resultText}`;
  }

  // Only apply colorization for IRC platform
  if (platform !== 'irc') return resultText;

  // Apply temperature coloring (primary), or fall back to wind/humidity/precip
  if (temperature !== undefined) {
    return colorizeByValue(resultText, platform, temperature, tempColorDef);
  }
  if (windSpeed !== undefined) {
    return colorizeByValue(resultText, platform, windSpeed, windColorDef);
  }
  if (humidity !== undefined) {
    return colorizeByValue(resultText, platform, humidity, humidityColorDef);
  }
  if (precipitation !== undefined) {
    return colorizeByValue(resultText, platform, precipitation, precipColorDef);
  }

  // No metric provided — just return with icon
  return resultText;
}
