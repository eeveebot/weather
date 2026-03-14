import * as ircColors from 'irc-colors';
import { log } from '@eeveebot/libeevee';

// Weather condition icons
const weatherIcons: Record<string, string> = {
  'clear-day': '☀️',
  'clear-night': '🌙',
  rain: '🌧️',
  snow: '❄️',
  sleet: '🌨️',
  wind: '💨',
  fog: '🌫️',
  cloudy: '☁️',
  'partly-cloudy-day': '⛅',
  'partly-cloudy-night': '☁️🌙',
  thunderstorm: '⛈️',
  tornado: '🌪️',
  hail: '🌨️',
  unknown: '❓',
};

// Temperature color mapping
function getTemperatureColor(temp: number): (text: string) => string {
  log.debug('getTemperatureColor called', {
    producer: 'weather',
    temp: temp,
    ircColorsBlue: typeof ircColors.blue,
    ircColorsCyan: typeof ircColors.cyan,
    ircColorsGreen: typeof ircColors.green,
    ircColorsYellow: typeof ircColors.yellow,
    ircColorsOrange: typeof ircColors.orange,
    ircColorsRed: typeof ircColors.red,
  });

  let colorFunction: ((text: string) => string) | undefined;

  if (temp < 32) {
    colorFunction = ircColors.blue;
    log.debug('Selected ircColors.blue', { producer: 'weather' });
  } else if (temp < 50) {
    colorFunction = ircColors.cyan;
    log.debug('Selected ircColors.cyan', { producer: 'weather' });
  } else if (temp < 70) {
    colorFunction = ircColors.green;
    log.debug('Selected ircColors.green', { producer: 'weather' });
  } else if (temp < 80) {
    colorFunction = ircColors.yellow;
    log.debug('Selected ircColors.yellow', { producer: 'weather' });
  } else if (temp < 90) {
    colorFunction = ircColors.orange;
    log.debug('Selected ircColors.orange', { producer: 'weather' });
  } else {
    colorFunction = ircColors.red;
    log.debug('Selected ircColors.red', { producer: 'weather' });
  }

  // Safety check to ensure we have a valid function
  if (typeof colorFunction !== 'function') {
    log.error('Color function is not a function', {
      producer: 'weather',
      colorFunction: colorFunction,
      typeofColorFunction: typeof colorFunction,
    });
    // Return a fallback function that just returns the text unchanged
    return (text: string) => text;
  }

  return colorFunction;
}

// Wind speed color mapping
function getWindSpeedColor(wind: number): (text: string) => string {
  if (wind < 5) return ircColors.green;
  if (wind < 15) return ircColors.yellow;
  if (wind < 25) return ircColors.orange;
  return ircColors.red;
}

// Humidity color mapping
function getHumidityColor(humidity: number): (text: string) => string {
  if (humidity < 30) return ircColors.orange;
  if (humidity < 70) return ircColors.green;
  return ircColors.blue;
}

// Precipitation probability color mapping
function getPrecipitationColor(precip: number): (text: string) => string {
  if (precip < 20) return ircColors.green;
  if (precip < 50) return ircColors.yellow;
  if (precip < 80) return ircColors.orange;
  return ircColors.red;
}

/**
 * Get weather icon for condition
 * @param condition Weather condition string
 * @returns Weather icon emoji
 */
export function getWeatherIcon(condition: string): string {
  // Normalize condition string to lowercase and remove extra whitespace
  const normalizedCondition = condition.toLowerCase().trim();

  // Try direct match first
  if (weatherIcons[normalizedCondition]) {
    return weatherIcons[normalizedCondition];
  }

  // Try partial matching for conditions like "Partly Cloudy"
  for (const [key, icon] of Object.entries(weatherIcons)) {
    if (normalizedCondition.includes(key)) {
      return icon;
    }
  }

  // Default icon
  return weatherIcons.unknown;
}

/**
 * Colorize weather text based on platform and weather metrics
 * @param text Text to colorize
 * @param platform Platform identifier
 * @param temperature Temperature in Fahrenheit (for temperature-based coloring)
 * @param windSpeed Wind speed in mph (for wind-based coloring)
 * @param humidity Humidity percentage (for humidity-based coloring)
 * @param precipitation Precipitation probability percentage (for precipitation-based coloring)
 * @param condition Weather condition (for icon selection)
 * @returns Colorized text with icons if platform is IRC, otherwise original text with icons
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
  log.debug('colorizeWeather called', {
    producer: 'weather',
    text: text,
    platform: platform,
    temperature: temperature,
    windSpeed: windSpeed,
    humidity: humidity,
    precipitation: precipitation,
    condition: condition,
  });

  // Add weather icon if condition is provided
  let resultText = text;
  if (condition) {
    const icon = getWeatherIcon(condition);
    resultText = `${icon} ${resultText}`;
  }

  // Only apply colorization for IRC platform
  if (platform === 'irc') {
    try {
      log.debug('Applying colorization for IRC', {
        producer: 'weather',
        resultText: resultText,
        temperature: temperature,
      });

      let coloredText = resultText;

      // Apply temperature coloring if temperature is provided
      if (temperature !== undefined) {
        log.debug('Temperature provided, getting color function', {
          producer: 'weather',
          temperature: temperature,
        });
        const tempColor = getTemperatureColor(temperature);
        log.debug('Got tempColor function, applying to text', {
          producer: 'weather',
          tempColorType: typeof tempColor,
        });
        coloredText = tempColor(coloredText);
      }

      // Apply wind speed coloring if windSpeed is provided and no temperature (to avoid conflicts)
      if (windSpeed !== undefined && temperature === undefined) {
        const windColor = getWindSpeedColor(windSpeed);
        coloredText = windColor(coloredText);
      }

      // Apply humidity coloring if humidity is provided and no temperature/wind
      if (
        humidity !== undefined &&
        temperature === undefined &&
        windSpeed === undefined
      ) {
        const humidityColor = getHumidityColor(humidity);
        coloredText = humidityColor(coloredText);
      }

      // Apply precipitation coloring if precipitation is provided and no other metrics
      if (
        precipitation !== undefined &&
        temperature === undefined &&
        windSpeed === undefined &&
        humidity === undefined
      ) {
        const precipColor = getPrecipitationColor(precipitation);
        coloredText = precipColor(coloredText);
      }

      log.debug('Successfully colorized weather text for IRC', {
        producer: 'weather',
        originalText: resultText,
        coloredText: coloredText,
      });

      return coloredText;
    } catch (error) {
      log.error('Failed to colorize weather text for IRC', {
        producer: 'weather',
        text: resultText,
        error: error instanceof Error ? error.message : String(error),
      });
      return resultText;
    }
  }

  log.debug('Returning weather text with icon for non-IRC platform', {
    producer: 'weather',
    text: resultText,
    platform: platform,
  });

  // Return text with icon for non-IRC platforms
  return resultText;
}
