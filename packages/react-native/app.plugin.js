// Expo loads a package plugin from this file with Node's require().
const plugin = require('./plugin/build/index.js');

module.exports = plugin.default ?? plugin;
