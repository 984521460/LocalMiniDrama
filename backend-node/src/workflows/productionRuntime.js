'use strict';

const { createV2Repositories } = require('../repositories/v2');
const { createWorkflowRunService } = require('./runService');
const {
  SUPPORTED_MATERIALIZED_NODE_TYPES,
  createMaterializedNodeExecutor,
} = require('./materializedNodeExecutor');

function createProductionWorkflowRuntime({ database } = {}) {
  const repositories = createV2Repositories(database);
  const runService = createWorkflowRunService({ repositories });
  const executeNode = createMaterializedNodeExecutor({ repositories, runService });
  return Object.freeze({
    workflows: Object.freeze({
      executeNode,
      supportedNodeTypes: SUPPORTED_MATERIALIZED_NODE_TYPES,
    }),
  });
}

module.exports = Object.freeze({ createProductionWorkflowRuntime });
