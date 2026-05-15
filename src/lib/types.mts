'use strict';

import { RateLimitConfig } from '@eeveebot/libeevee';

// Weather module configuration interface
export interface WeatherConfig {
  ratelimit?: RateLimitConfig;
}

// Pirate Weather API response types
export interface WeatherData {
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

export interface ForecastData {
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

// Unit types
export type UserUnits = 'metric' | 'imperial' | 'kelvin';
export type ApiUnits = 'us' | 'si';
