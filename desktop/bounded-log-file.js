'use strict';

function loadBoundedLogFile() {
  try {
    return require('../backend-node/src/utils/boundedLogFile');
  } catch (_) {
    return require('./backend-app/src/utils/boundedLogFile');
  }
}

module.exports = loadBoundedLogFile();
