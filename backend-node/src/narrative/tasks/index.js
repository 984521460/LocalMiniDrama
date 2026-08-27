const {
  NarrativeTaskError,
  narrativeTaskError,
} = require('./errors');
const {
  createEpisodeAdaptationTask,
} = require('./episodeAdaptationTask');
const {
  createNovelExtractionTask,
} = require('./novelExtractionTask');
const {
  createPromptSemanticTask,
} = require('./promptSemanticTask');
const {
  createScriptFormattingTask,
} = require('./scriptFormattingTask');
const {
  createShotPlanningTask,
} = require('./shotPlanningTask');

module.exports = {
  NarrativeTaskError,
  createEpisodeAdaptationTask,
  createNovelExtractionTask,
  createPromptSemanticTask,
  createScriptFormattingTask,
  createShotPlanningTask,
  narrativeTaskError,
};
