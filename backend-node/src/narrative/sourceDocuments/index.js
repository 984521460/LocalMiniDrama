const { createSourceDocumentService } = require('./service');
const {
  SourceDocumentError,
  isSourceDocumentError,
  sourceDocumentError,
} = require('./errors');

module.exports = {
  SourceDocumentError,
  createSourceDocumentService,
  isSourceDocumentError,
  sourceDocumentError,
};
