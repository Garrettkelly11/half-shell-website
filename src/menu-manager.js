/**
 * Menu Manager Module
 * Handles reading/writing oyster menu entries in Firebase
 * Manages timestamps and conflict resolution
 */

class MenuManager {
  constructor(servingRef, auditLogRef) {
    this.servingRef = servingRef;
    this.auditLogRef = auditLogRef;
  }

  /**
   * Get current menu as an object: {oyster-id: {addedAt, lastUpdated, source}}
   */
  async getCurrentMenu() {
    try {
      const snapshot = await this.servingRef.once('value');
      return snapshot.val() || {};
    } catch (error) {
      console.error('Failed to fetch current menu:', error);
      return {};
    }
  }

  /**
   * Get list of oyster IDs currently on the menu
   */
  async getMenuIds() {
    const menu = await this.getCurrentMenu();
    return Object.keys(menu);
  }

  /**
   * Add or toggle an oyster on the menu (staff action)
   * @param {string} oysterId - Oyster ID to toggle
   * @param {boolean} isAdding - True to add, false to remove
   * @param {string} staffName - Name of staff member making change (for audit log)
   */
  async toggleOyster(oysterId, isAdding, staffName = 'Unknown') {
    const now = Date.now();

    try {
      if (isAdding) {
        // Add oyster to menu
        await this.servingRef.child(oysterId).set({
          addedAt: now,
          lastUpdated: now,
          source: 'staff'
        });
      } else {
        // Remove oyster from menu
        await this.servingRef.child(oysterId).remove();
      }

      // Log the action
      await this.logChange('staff_toggle', oysterId, isAdding ? 'added' : 'removed', staffName, now);

      return { success: true, timestamp: now };
    } catch (error) {
      console.error(`Failed to toggle oyster ${oysterId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Sync oysters from Toast API
   * Updates or adds oysters based on Toast list
   * @param {Array} toastOysters - Array of oyster IDs from Toast
   * @param {string} syncSource - Usually "toast_api"
   */
  async syncFromToast(toastOysters, syncSource = 'toast_api') {
    const now = Date.now();
    const currentMenu = await this.getCurrentMenu();
    const updates = {};
    let addCount = 0;
    let updateCount = 0;
    const syncedIds = new Set();

    try {
      // Process each oyster from Toast
      toastOysters.forEach((oysterId) => {
        syncedIds.add(oysterId);

        if (currentMenu[oysterId]) {
          // Oyster already on menu - update timestamp and source
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
        await this.servingRef.update(updates);
      }

      // Log the sync action
      await this.logChange('toast_sync', null, `synced_${addCount}_added_${updateCount}_updated`, 'Toast API', now);

      return {
        success: true,
        timestamp: now,
        added: addCount,
        updated: updateCount,
        total: syncedIds.size
      };
    } catch (error) {
      console.error('Failed to sync from Toast:', error);
      await this.logChange('toast_sync_error', null, error.message, 'Toast API', now);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Log a change to the audit log
   * @param {string} action - Type of action (staff_toggle, toast_sync, toast_sync_error, etc.)
   * @param {string} oysterId - Which oyster was affected (null for batch operations)
   * @param {string} details - Details about what happened
   * @param {string} actor - Who/what made the change (staff name or "Toast API")
   * @param {number} timestamp - When it happened (Date.now())
   */
  async logChange(action, oysterId, details, actor, timestamp) {
    try {
      const logEntry = {
        timestamp,
        action,
        oysterId,
        details,
        actor,
        readable_timestamp: new Date(timestamp).toISOString()
      };

      // Append to audit log (using child.push() creates a unique key)
      await this.auditLogRef.push(logEntry);
    } catch (error) {
      console.error('Failed to log change:', error);
      // Don't throw - audit log failure shouldn't block menu updates
    }
  }

  /**
   * Get recent audit log entries
   * @param {number} limit - How many recent entries to fetch (default 50)
   */
  async getAuditLog(limit = 50) {
    try {
      const snapshot = await this.auditLogRef
        .orderByChild('timestamp')
        .limitToLast(limit)
        .once('value');

      const log = [];
      snapshot.forEach((child) => {
        log.unshift(child.val()); // Reverse order so newest is first
      });
      return log;
    } catch (error) {
      console.error('Failed to fetch audit log:', error);
      return [];
    }
  }

  /**
   * Check if an oyster is currently on the menu
   */
  async isOnMenu(oysterId) {
    try {
      const snapshot = await this.servingRef.child(oysterId).once('value');
      return snapshot.exists();
    } catch (error) {
      console.error(`Failed to check if ${oysterId} is on menu:`, error);
      return false;
    }
  }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MenuManager;
}
