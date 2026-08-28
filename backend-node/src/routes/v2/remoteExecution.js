'use strict';

const express = require('express');

const remoteEnvironmentRoutes = require('./remoteEnvironment');
const remoteTaskRoutes = require('./remoteTasks');

function remoteExecutionRoutes(log, runtime = {}, database) {
  const router = express.Router();
  router.use(remoteEnvironmentRoutes(log, runtime));
  router.use(remoteTaskRoutes(log, runtime, database));
  return router;
}

module.exports = remoteExecutionRoutes;
