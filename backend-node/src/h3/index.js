'use strict';

const { createMinimaxH3ApiProvider } = require('./apiProvider');
const { createMinimaxH3ApiService } = require('./apiService');
const { H3ContractError, isH3ContractError } = require('./errors');
const {
  normalizeH3GenerationSpec,
  h3FramesForDuration,
  validateH3GenerationSpec,
} = require('./generationSpec');
const { H3_PROFILE } = require('./profile');
const { createH3GenerationHistoryService } = require('./generationHistoryService');
const { createH3ExecutionIntent, validateH3ExecutionIntent } = require('./executionIntent');
const { createH3ExecutionIntentService } = require('./executionIntentService');
const { createH3LocalVideoInspector } = require('./localVideoInspector');
const {
  createH3LocalExecutionService,
  parseH3LocalExecutionResult,
} = require('./localExecutionService');
const { H3_REAL_VALIDATION_MATRIX } = require('./realValidationMatrix');
const {
  H3_PHASE_7_ENVIRONMENT_SHA256,
  validateH3RealGpuEnvironment,
} = require('./realValidationEnvironment');
const {
  H3_PHASE_7_REQUIRED_MODES,
  createH3RealValidationCollector,
  evaluateH3Phase7Evidence,
  validateH3RealValidationReceipt,
} = require('./realValidationEvidence');
const { validateH3VideoEvidence, validateH3VideoOutput } = require('./outputValidation');
const { compileH3ShotPrompt } = require('./promptCompiler');
const {
  compileH3GenerationWorkflow,
  createH3TextToVideoWorkflowBundle,
} = require('./workflowBundle');
const {
  H3_OFFICIAL_WORKFLOW_SOURCES,
  compileH3WorkflowCandidate,
  createH3WorkflowCandidateBundle,
} = require('./workflowCandidates');
const {
  H3_PHASE_7_VALIDATION_MODES,
  createH3Phase7ValidationPlan,
  validateH3Phase7ValidationPlan,
} = require('./realValidationPlan');

module.exports = Object.freeze({
  H3_PROFILE,
  H3_OFFICIAL_WORKFLOW_SOURCES,
  H3_PHASE_7_ENVIRONMENT_SHA256,
  H3_PHASE_7_REQUIRED_MODES,
  H3_PHASE_7_VALIDATION_MODES,
  H3_REAL_VALIDATION_MATRIX,
  H3ContractError,
  compileH3GenerationWorkflow,
  compileH3WorkflowCandidate,
  compileH3ShotPrompt,
  createMinimaxH3ApiProvider,
  createMinimaxH3ApiService,
  createH3GenerationHistoryService,
  createH3ExecutionIntent,
  createH3ExecutionIntentService,
  validateH3ExecutionIntent,
  createH3LocalVideoInspector,
  createH3LocalExecutionService,
  createH3Phase7ValidationPlan,
  createH3RealValidationCollector,
  createH3TextToVideoWorkflowBundle,
  createH3WorkflowCandidateBundle,
  h3FramesForDuration,
  isH3ContractError,
  normalizeH3GenerationSpec,
  parseH3LocalExecutionResult,
  evaluateH3Phase7Evidence,
  validateH3RealValidationReceipt,
  validateH3RealGpuEnvironment,
  validateH3GenerationSpec,
  validateH3Phase7ValidationPlan,
  validateH3VideoEvidence,
  validateH3VideoOutput,
});
