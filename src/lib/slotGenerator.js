/**
 * @deprecated Use slot.js instead
 * This file exists for backwards compatibility with legacy routes.
 * All new code should use ./slot.js
 */

const slot = require('./slot');

// Re-export from slot.js for backwards compatibility
module.exports = {
  getSlots: slot.getSlots,
  getScheduleConfig: slot.getScheduleConfig
};
