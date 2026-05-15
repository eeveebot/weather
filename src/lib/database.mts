'use strict';

import fs from 'node:fs';
import { log } from '@eeveebot/libeevee';
import Database from 'better-sqlite3';
import type { UserUnits } from './types.mjs';

// Database instance (singleton)
let db: Database.Database | null = null;

// Prepared statements
let getUserLocationStmt: Database.Statement | null = null;
let setUserLocationStmt: Database.Statement | null = null;
let getUserUnitsStmt: Database.Statement | null = null;
let setUserUnitsStmt: Database.Statement | null = null;
let getUserObscurePreferenceStmt: Database.Statement | null = null;
let setUserObscurePreferenceStmt: Database.Statement | null = null;

/**
 * Initialize the weather database. Must be called once at startup.
 */
export function initDatabase(): void {
  try {
    const moduleDataPath = process.env.MODULE_DATA;
    if (!moduleDataPath) {
      throw new Error('MODULE_DATA environment variable not set');
    }

    if (!fs.existsSync(moduleDataPath)) {
      fs.mkdirSync(moduleDataPath, { recursive: true });
    }

    const dbPath = `${moduleDataPath}/weather.db`;
    db = new Database(dbPath);

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

    db.exec(`
      CREATE TABLE IF NOT EXISTS user_units (
        user_ident TEXT PRIMARY KEY,
        units TEXT NOT NULL DEFAULT 'imperial',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        user_ident TEXT PRIMARY KEY,
        obscure BOOLEAN NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Prepare statements
    getUserLocationStmt = db.prepare(
      'SELECT search_string, latitude, longitude FROM user_locations WHERE user_ident = ?'
    );
    setUserLocationStmt = db.prepare(`
      INSERT INTO user_locations (user_ident, search_string, latitude, longitude)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_ident) DO UPDATE SET
        search_string = excluded.search_string,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        updated_at = CURRENT_TIMESTAMP
    `);
    getUserUnitsStmt = db.prepare(
      'SELECT units FROM user_units WHERE user_ident = ?'
    );
    setUserUnitsStmt = db.prepare(`
      INSERT INTO user_units (user_ident, units)
      VALUES (?, ?)
      ON CONFLICT(user_ident) DO UPDATE SET
        units = excluded.units,
        updated_at = CURRENT_TIMESTAMP
    `);
    getUserObscurePreferenceStmt = db.prepare(
      'SELECT obscure FROM user_preferences WHERE user_ident = ?'
    );
    setUserObscurePreferenceStmt = db.prepare(`
      INSERT INTO user_preferences (user_ident, obscure)
      VALUES (?, ?)
      ON CONFLICT(user_ident) DO UPDATE SET
        obscure = excluded.obscure,
        updated_at = CURRENT_TIMESTAMP
    `);

    log.info('Initialized weather database', { producer: 'weather', dbPath });
  } catch (error) {
    log.error('Failed to initialize database', {
      producer: 'weather',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Close the database connection. Called during graceful shutdown.
 */
export function closeDatabase(): void {
  if (db) db.close();
}

/**
 * Get stored location for a user.
 */
export function getUserLocation(
  userIdent: string
): { searchString: string; lat: number; lon: number } | null {
  try {
    if (!getUserLocationStmt) throw new Error('Database not initialized');
    const row = getUserLocationStmt.get(userIdent) as
      | { search_string: string; latitude: number; longitude: number }
      | undefined;
    return row
      ? { searchString: row.search_string, lat: row.latitude, lon: row.longitude }
      : null;
  } catch (error) {
    log.error('Failed to get user location', { producer: 'weather', userIdent, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Set location for a user.
 */
export function setUserLocation(
  userIdent: string,
  searchString: string,
  lat: number,
  lon: number
): void {
  try {
    if (!setUserLocationStmt) throw new Error('Database not initialized');
    setUserLocationStmt.run(userIdent, searchString, lat, lon);
  } catch (error) {
    log.error('Failed to set user location', { producer: 'weather', userIdent, searchString, lat, lon, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Get stored unit preference for a user.
 */
export function getUserUnits(userIdent: string): UserUnits | null {
  try {
    if (!getUserUnitsStmt) throw new Error('Database not initialized');
    const row = getUserUnitsStmt.get(userIdent) as { units: string } | undefined;
    return row ? (row.units as UserUnits) : null;
  } catch (error) {
    log.error('Failed to get user units', { producer: 'weather', userIdent, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Set unit preference for a user.
 */
export function setUserUnits(userIdent: string, units: UserUnits): void {
  try {
    if (!setUserUnitsStmt) throw new Error('Database not initialized');
    setUserUnitsStmt.run(userIdent, units);
  } catch (error) {
    log.error('Failed to set user units', { producer: 'weather', userIdent, units, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Get user's obscure preference.
 */
export function getUserObscurePreference(userIdent: string): boolean {
  try {
    if (!getUserObscurePreferenceStmt) throw new Error('Database not initialized');
    const row = getUserObscurePreferenceStmt.get(userIdent) as { obscure: number } | undefined;
    return row ? Boolean(row.obscure) : false;
  } catch (error) {
    log.error('Failed to get user obscure preference', { producer: 'weather', userIdent, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * Set user's obscure preference.
 */
export function setUserObscurePreference(userIdent: string, obscure: boolean): void {
  try {
    if (!setUserObscurePreferenceStmt) throw new Error('Database not initialized');
    setUserObscurePreferenceStmt.run(userIdent, obscure ? 1 : 0);
  } catch (error) {
    log.error('Failed to set user obscure preference', { producer: 'weather', userIdent, obscure, error: error instanceof Error ? error.message : String(error) });
  }
}
