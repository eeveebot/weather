'use strict';

import type { UserUnits, ApiUnits } from './types.mjs';
import { getUserLocation, setUserLocation, getUserUnits, setUserUnits, getUserObscurePreference, setUserObscurePreference } from './database.mjs';
import { zipcodeToCoordinates } from './api.mjs';

export interface ParsedContext {
  units: UserUnits;
  apiUnits: ApiUnits;
  coordinates: { lat: number; lon: number };
  displayLocation: string;
  userIdent: string;
}

/**
 * Parse flags and resolve location for a weather/forecast command.
 * Handles -c/-f/-k unit flags, -o obscure toggle, and location lookup.
 * Returns ParsedContext on success, or an error string on failure.
 */
export async function parseCommandContext(
  commandText: string,
  data: Record<string, unknown>,
  defaultCommandName: string
): Promise<ParsedContext | string> {
  let units: UserUnits = 'imperial';
  let locationSearch = commandText;
  let toggleObscure = false;
  const userIdent = `${data['platform']}:${data['network']}:${data['user']}`;

  // Check for -o flag (obscure)
  if (commandText.includes('-o')) {
    toggleObscure = true;
    locationSearch = commandText.replace('-o', '').trim();
  }

  // Check for unit flags
  if (locationSearch.includes('-k')) {
    units = 'kelvin';
    locationSearch = locationSearch.replace('-k', '').trim();
  } else if (locationSearch.includes('-c')) {
    units = 'metric';
    locationSearch = locationSearch.replace('-c', '').trim();
  } else if (locationSearch.includes('-f')) {
    units = 'imperial';
    locationSearch = locationSearch.replace('-f', '').trim();
  } else {
    const storedUnits = getUserUnits(userIdent);
    if (storedUnits) units = storedUnits;
  }

  // Save unit preference if flags were used
  if (commandText !== locationSearch) {
    setUserUnits(userIdent, units);
  }

  // Toggle obscure preference
  if (toggleObscure) {
    const currentObscure = getUserObscurePreference(userIdent);
    setUserObscurePreference(userIdent, !currentObscure);
  }

  // Resolve coordinates
  let coordinates: { lat: number; lon: number } | null = null;
  let displayLocation = '';

  if (locationSearch) {
    coordinates = await zipcodeToCoordinates(locationSearch);
    if (!coordinates) {
      return `Unable to find location for "${locationSearch}"`;
    }
    displayLocation = locationSearch;
    setUserLocation(userIdent, locationSearch, coordinates.lat, coordinates.lon);
  } else {
    const storedLocation = getUserLocation(userIdent);
    if (storedLocation) {
      coordinates = { lat: storedLocation.lat, lon: storedLocation.lon };
      displayLocation = storedLocation.searchString;
    } else {
      return `Please provide a location or set one with "${defaultCommandName} <location>" first`;
    }
  }

  const apiUnits: ApiUnits = units === 'metric' || units === 'kelvin' ? 'si' : 'us';

  return { units, apiUnits, coordinates, displayLocation, userIdent };
}
