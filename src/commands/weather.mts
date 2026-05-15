'use strict';

import { log, NatsClient, sendChatMessage, createModuleMetrics, NatsSubscriptionResult } from '@eeveebot/libeevee';
import { getUserObscurePreference } from '../lib/database.mjs';
import { fetchWeatherData } from '../lib/api.mjs';
import { formatWeatherData } from '../lib/formatting.mjs';
import { parseCommandContext } from '../lib/context.mjs';

const metrics = createModuleMetrics('weather');

export interface CommandHandlerParams {
  nats: InstanceType<typeof NatsClient>;
  commandUUID: string;
}

export async function handleWeatherCommand({
  nats,
  commandUUID,
}: CommandHandlerParams): Promise<NatsSubscriptionResult> {
  const weatherCommandSub = nats.subscribe(
    `command.execute.${commandUUID}`,
    async (subject, message) => {
      try {
        const data = JSON.parse(message.string());
        const sendError = (errorMessage: string) => {
          void sendChatMessage(nats, {
            channel: data.channel, network: data.network, instance: data.instance,
            platform: data.platform, text: errorMessage, trace: data.trace,
          }, metrics);
        };

        log.info('Received command.execute for weather', {
          producer: 'weather', platform: data.platform, instance: data.instance,
          channel: data.channel, user: data.user, originalText: data.originalText,
        });

        const commandText = data.text.trim();
        const context = await parseCommandContext(commandText, data, 'weather');

        if (typeof context === 'string') {
          sendError(context);
          return;
        }

        const weatherData = await fetchWeatherData(context.coordinates.lat, context.coordinates.lon, context.apiUnits);
        if (!weatherData) {
          sendError('Unable to fetch weather data. Please try again later.');
          return;
        }

        const formattedWeather = formatWeatherData(weatherData, data.platform, context.units);
        const obscureEnabled = getUserObscurePreference(context.userIdent);
        const displayText = obscureEnabled ? (data.nick || data.user) : context.displayLocation;

        await sendChatMessage(nats, {
          channel: data.channel, network: data.network, instance: data.instance,
          platform: data.platform, text: `Weather for ${displayText}: ${formattedWeather}`, trace: data.trace,
        }, metrics);
      } catch (error) {
        log.error('Failed to process weather command', {
          producer: 'weather', error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  return weatherCommandSub;
}
