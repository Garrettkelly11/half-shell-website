/**
 * Toast POS Sync Endpoint
 *
 * This module handles syncing oyster availability from Toast POS to Firebase.
 * It's designed to be called either:
 * 1. Manually via POST /api/sync-toast-menu from employee.html
 * 2. Automatically via scheduled task (GitHub Actions or Cloud Function)
 *
 * Setup Instructions:
 * 1. Add Toast API credentials to GitHub Secrets:
 *    - TOAST_API_KEY: Your Toast API key
 *    - TOAST_LOCATION_ID: Your restaurant location ID
 *
 * 2. Deploy this as a Cloud Function or integrate with your backend
 */

const admin = require('firebase-admin');

/**
 * Initialize Firebase Admin SDK (if running in Cloud Functions)
 * For local testing, ensure credentials are available
 */
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.database();

/**
 * Check if Toast API is configured
 */
function isToastConfigured() {
  const TOAST_API_KEY = process.env.TOAST_API_KEY || '';
  const TOAST_LOCATION_ID = process.env.TOAST_LOCATION_ID || '';
  return !!(TOAST_API_KEY && TOAST_LOCATION_ID);
}

/**
 * Fetch oyster availability from Toast API
 * Returns array of oyster IDs currently available in Toast
 * Returns empty array if Toast is not configured
 */
async function fetchFromToastAPI() {
  const TOAST_API_KEY = process.env.TOAST_API_KEY || '';
  const TOAST_LOCATION_ID = process.env.TOAST_LOCATION_ID || '';

  // Graceful degradation: if Toast not configured, return empty list
  if (!TOAST_API_KEY || !TOAST_LOCATION_ID) {
    console.warn('Toast API not configured. Returning empty oyster list. Configure TOAST_API_KEY and TOAST_LOCATION_ID to enable syncing.');
    return [];
  }

  try {
    const response = await fetch('https://api.toasttab.com/v2/inventory', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOAST_API_KEY}`,
        'Toast-Restaurant-External-ID': TOAST_LOCATION_ID
      }
    });

    if (!response.ok) {
      console.error(`Toast API error: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = await response.json();

    // Parse Toast response to extract oyster IDs
    // This assumes Toast items have a custom field linking to our oyster IDs
    // Adjust based on your actual Toast data structure
    const oysterIds = (data.items || [])
      .filter(item => item.categories && item.categories.some(cat => cat.name === 'Oysters'))
      .map(item => item.externalId || item.guid)
      .filter(id => id); // Remove null/undefined

    return oysterIds;
  } catch (error) {
    console.error('Failed to fetch from Toast API:', error);
    // Return empty list on error instead of throwing
    return [];
  }
}

/**
 * Fetch oyster IDs from Toast (does NOT write to Firebase)
 * Staff reviews results, then clicks "Save Menu" to persist
 *
 * Returns: { success: boolean, oysterIds: array, configured: boolean, error?: string }
 */
async function fetchToastOysterList() {
  try {
    const oysterIds = await fetchFromToastAPI();

    return {
      success: true,
      oysterIds: oysterIds,
      configured: isToastConfigured(),
      count: oysterIds.length
    };
  } catch (error) {
    console.error('Failed to fetch Toast menu:', error);
    return {
      success: false,
      oysterIds: [],
      configured: isToastConfigured(),
      error: error.message
    };
  }
}

/**
 * Sync oysters from Toast to Firebase (only called during scheduled/automatic sync)
 * Updates Firebase /menu/serving with oysters from Toast
 * NOT called by manual "Sync Toast" button on employee.html
 *
 * Returns: { success: boolean, timestamp: number, added: number, updated: number, total: number, error?: string }
 */
async function syncToastToFirebase() {
  const now = Date.now();

  try {
    // Fetch current menu from Firebase
    const snapshot = await db.ref('menu/serving').once('value');
    const currentMenu = snapshot.val() || {};

    // Fetch oyster IDs from Toast
    const toastOysterIds = await fetchFromToastAPI();

    // Only proceed if Toast returned data
    if (toastOysterIds.length === 0) {
      return {
        success: true,
        timestamp: now,
        added: 0,
        updated: 0,
        total: 0,
        note: 'No oysters returned from Toast (not configured or API error)'
      };
    }

    // Prepare updates
    const updates = {};
    let addCount = 0;
    let updateCount = 0;

    toastOysterIds.forEach((oysterId) => {
      if (currentMenu[oysterId]) {
        // Oyster already on menu - update timestamp
        updates[oysterId] = {
          addedAt: currentMenu[oysterId].addedAt, // Keep original addedAt
          lastUpdated: now,
          source: 'toast'
        };
        updateCount++;
      } else {
        // New oyster from Toast - add it
        updates[oysterId] = {
          addedAt: now,
          lastUpdated: now,
          source: 'toast'
        };
        addCount++;
      }
    });

    // Perform bulk update
    if (Object.keys(updates).length > 0) {
      await db.ref('menu/serving').update(updates);
    }

    // Log the sync
    await db.ref('audit-log').push({
      timestamp: now,
      action: 'toast_sync',
      oysterId: null,
      details: `synced_${addCount}_added_${updateCount}_updated`,
      actor: 'Toast API (automatic)',
      readable_timestamp: new Date(now).toISOString()
    });

    return {
      success: true,
      timestamp: now,
      added: addCount,
      updated: updateCount,
      total: toastOysterIds.length
    };
  } catch (error) {
    console.error('Sync failed:', error);

    // Log error
    await db.ref('audit-log').push({
      timestamp: now,
      action: 'toast_sync_error',
      oysterId: null,
      details: error.message,
      actor: 'Toast API (automatic)',
      readable_timestamp: new Date(now).toISOString()
    }).catch(err => console.error('Failed to log error:', err));

    return {
      success: false,
      timestamp: now,
      error: error.message
    };
  }
}

/**
 * Express.js Route Handlers
 *
 * Usage:
 *   POST /api/sync-toast-menu → Fetch Toast list (for employee.html preview)
 *   POST /api/sync-toast-automatic → Automatic sync to Firebase (for scheduled tasks)
 *
 * Example Express integration:
 * ```javascript
 * const express = require('express');
 * const app = express();
 * const { fetchToastOysterList, syncToastToFirebase } = require('./sync-toast-endpoint');
 *
 * // Manual sync (called by employee.html, returns list for preview)
 * app.post('/api/sync-toast-menu', async (req, res) => {
 *   try {
 *     const result = await fetchToastOysterList();
 *     res.json(result);
 *   } catch (error) {
 *     res.status(500).json({ success: false, error: error.message });
 *   }
 * });
 *
 * // Automatic sync (called by scheduled task, writes to Firebase)
 * app.post('/api/sync-toast-automatic', async (req, res) => {
 *   try {
 *     const result = await syncToastToFirebase();
 *     res.json(result);
 *   } catch (error) {
 *     res.status(500).json({ success: false, error: error.message });
 *   }
 * });
 * ```
 */

/**
 * HTTP Handler for Manual Sync (called by employee.html)
 * Returns oyster list from Toast for staff to review
 * Does NOT write to Firebase - staff must click "Save Menu"
 */
async function syncToastMenuHTTP(req, res) {
  try {
    const result = await fetchToastOysterList();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * HTTP Handler for Automatic Sync (called by scheduled tasks)
 * Fetches from Toast and writes to Firebase immediately
 */
async function syncToastMenuAutomaticHTTP(req, res) {
  try {
    const result = await syncToastToFirebase();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * Scheduled Function Handler (for Cloud Scheduler or similar)
 * Runs periodically (e.g., every 15 minutes during service hours)
 * Always writes to Firebase (automatic sync)
 */
async function syncToastMenuScheduled(req, res) {
  try {
    const now = new Date();
    const hour = now.getHours();

    // Only sync during service hours (11 AM - 11 PM)
    if (hour < 11 || hour >= 23) {
      return res.json({
        success: true,
        skipped: true,
        reason: `Outside service hours (${hour}:00). Service hours: 11 AM - 11 PM`
      });
    }

    const result = await syncToastToFirebase();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

// Export for use in different environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isToastConfigured,
    fetchFromToastAPI,
    fetchToastOysterList,
    syncToastToFirebase,
    syncToastMenuHTTP,
    syncToastMenuAutomaticHTTP,
    syncToastMenuScheduled
  };
}
