'use strict';

// Weather module
// Provides weather information using the Pirate Weather API

import {
  NatsClient,
  createNatsConnection,
  registerGracefulShutdown,
  createModuleMetrics,
  loadModuleConfig,
  defaultRateLimit,
  registerCommand,
  registerHelp,
  HelpEntry,
  registerStatsHandlers,
  initializeSystemMetrics,
  setupHttpServer,
  NatsSubscriptionResult,
} from '@eeveebot/libeevee';
import { WeatherConfig } from './lib/types.mjs';
import { initDatabase, closeDatabase } from './lib/database.mjs';
import { handleWeatherCommand } from './commands/weather.mjs';
import { handleForecastCommand } from './commands/forecast.mjs';
import fs from 'node:fs';

const moduleStartTime = Date.now();
const moduleVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;
const metrics = createModuleMetrics('weather');

const weatherCommandUUID = 'd9de0032-5d46-41f9-a09f-33c8da28462c';
const forecastCommandUUID = '16cc3c75-d406-4f16-b8ed-f8269aa1b0e0';

const natsClients: InstanceType<typeof NatsClient>[] = [];
const natsSubscriptions: Array<Promise<NatsSubscriptionResult>> = [];

initializeSystemMetrics('weather');

setupHttpServer({
  port: process.env.HTTP_API_PORT || '9000',
  serviceName: 'weather',
  natsClients: natsClients,
});

registerGracefulShutdown(natsClients, async () => {
  closeDatabase();
});

const nats = await createNatsConnection();
natsClients.push(nats);

const weatherConfig = loadModuleConfig<WeatherConfig>({});

// Initialize SQLite database
initDatabase();

// Register commands using registerCommand helper
const weatherCmdSubs = await registerCommand(nats, {
  commandUUID: weatherCommandUUID,
  commandDisplayName: 'weather',
  regex: '^weather\\s*',
  platformPrefixAllowed: true,
  ratelimit: weatherConfig.ratelimit || defaultRateLimit,
}, metrics);
natsSubscriptions.push(...weatherCmdSubs);

const forecastCmdSubs = await registerCommand(nats, {
  commandUUID: forecastCommandUUID,
  commandDisplayName: 'forecast',
  regex: '^(?:forecast|fivecast)\\s*',
  platformPrefixAllowed: true,
  ratelimit: weatherConfig.ratelimit || defaultRateLimit,
}, metrics);
natsSubscriptions.push(...forecastCmdSubs);

// Subscribe to command execution
natsSubscriptions.push(handleWeatherCommand({ nats, commandUUID: weatherCommandUUID }));
natsSubscriptions.push(handleForecastCommand({ nats, commandUUID: forecastCommandUUID }));

// Stats
const statsSubs = registerStatsHandlers({ nats, moduleName: 'weather', startTime: moduleStartTime, version: moduleVersion, metrics });
natsSubscriptions.push(...statsSubs);

// Help
const weatherHelp: HelpEntry[] = [
  {
    command: 'weather',
    descr: 'Get current weather for a location (location can be omitted if previously set)',
    params: [
      { param: '[location]', required: false, descr: 'Any location string (address, city, postal code, etc.)' },
      { param: '-c', required: false, descr: 'Use Celsius/metric units' },
      { param: '-f', required: false, descr: 'Use Fahrenheit/imperial units' },
      { param: '-k', required: false, descr: 'Use Kelvin units' },
      { param: '-o', required: false, descr: 'Toggle obscure mode (hides location in responses)' },
    ],
  },
  {
    command: 'forecast',
    descr: 'Get 5-day weather forecast for a location (location can be omitted if previously set)',
    aliases: ['fivecast'],
    params: [
      { param: '[location]', required: false, descr: 'Any location string (address, city, postal code, etc.)' },
      { param: '-c', required: false, descr: 'Use Celsius/metric units' },
      { param: '-f', required: false, descr: 'Use Fahrenheit/imperial units' },
      { param: '-k', required: false, descr: 'Use Kelvin units' },
      { param: '-o', required: false, descr: 'Toggle obscure mode (hides location in responses)' },
    ],
  },
];

const helpSubs = await registerHelp(nats, 'weather', weatherHelp, metrics);
natsSubscriptions.push(...helpSubs);
