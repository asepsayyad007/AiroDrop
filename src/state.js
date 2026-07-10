const os = require('os');

const state = {
  // Config files paths (set in init)
  CONFIG_FILE: '',
  HISTORY_FILE: '',
  SCRATCHPAD_FILE: '',

  // Server Settings
  PORT: 3478,
  SAVE_DIR: '',
  SHARE_DIR: '',
  TEMPORARY_MODE: false,
  DEVICE_NAME: os.hostname(),
  RATE_LIMIT_ENABLED: true,
  NOTIFICATIONS_ENABLED: true,
  TEMPORARY_MODE_HOURS: 2,
  AUTO_OPEN_LINKS: false,
  LAUNCH_ON_STARTUP: false,
  AUTO_UPDATE: true,

  // Screencast Security Settings
  privacyPause: false,

  // In-Memory Data Stores
  history: [],
  scratchpadText: '',
  bookmarks: [],
  pendingForPhone: [],
  sseClients: new Set(),
  logHistory: [],
  rateLimitMap: new Map(),

  // Server Lifecycle Instances
  serverInstance: null,
  wss: null,
  screencastStopTimeout: null
};

module.exports = state;
