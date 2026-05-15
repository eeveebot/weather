'use strict';

import { log, NatsClient, sendChatMessage, createModuleMetrics, NatsSubscriptionResult } from '@eeveebot/libeevee';
import { getUserObscurePreference } from '../lib/database.mjs';
import { fetchForecastData } from '../lib/api.mjs';
import { formatForecastData } from '../lib/formatting.mjs';
import { parseCommandContext } from '../lib/context.mjs';

const metrics = createModuleMetrics('weather');

export interface CommandHandlerParams {
  nats: InstanceType<typeof NatsClient>;
  commandUUID: string;
}

export async function handleForecastCommand({
  nats,
  commandUUID,
}: CommandHandlerParams): Promise<NatsSubscriptionResult> {
  const forecastCommandSub = nats.subscribe(
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

        log.info('Received command.execute for forecast', {
          producer: 'weather', platform: data.platform, instance: data.instance,
          channel: data.channel, user: data.user, originalText: data.originalText,
        });

        // Strip "forecast" or "fivecast" prefix from text
        const commandText = data.text.trim().replace(/^(forecast|fivecast)\s*/i, '').trim();
        const context = await parseCommandContext(commandText, data, 'forecast');

        if (typeof context === 'string') {
          sendError(context);
          return;
        }

        const forecastData = await fetchForecastData(context.coordinates.lat, context.coordinates.lon, context.apiUnits);
        if (!forecastData) {
          sendError('Unable to fetch forecast data. Please try again later.');
          return;
        }

        const formattedForecast = formatForecastData(forecastData, data.platform, context.units);
        const obscureEnabled = getUserObscurePreference(context.userIdent);
        const displayText = obscureEnabled ? (data.nick || data.user) : context.displayLocation;

        await sendChatMessage(nats, {
          channel: data.channel, network: data.network, instance: data.instance,
          platform: data.platform, text: `5-Day Forecast for ${displayText}: ${formattedForecast}`, trace: data.trace,
        }, metrics);
      } catch (error) {
        log.error('Failed to process forecast command', {
          producer: 'weather', error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  return forecastCommandSub;
}
