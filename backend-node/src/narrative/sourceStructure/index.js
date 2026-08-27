const { isSourceStructureError } = require('./errors');
const { mapModelRangeToSource, parseSourceStructure } = require('./parser');

module.exports = {
  isSourceStructureError,
  mapModelRangeToSource,
  parseSourceStructure,
};
