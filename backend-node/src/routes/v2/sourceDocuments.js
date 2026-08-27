const express = require('express');
const multer = require('multer');

const response = require('../../response');
const {
  isSourceDocumentError,
  createSourceDocumentService,
} = require('../../narrative/sourceDocuments');
const { isSourceTextImportError } = require('../../narrative/sourceImport');
const { isSourceStructureError } = require('../../narrative/sourceStructure');
const {
  createV2Repositories,
  V2RepositoryConflictError,
} = require('../../repositories/v2');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 50 * 1024 * 1024, fields: 2 },
});

function parseDramaId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function sourceDocumentRoutes(database, log) {
  const router = express.Router();
  const service = createSourceDocumentService({ repositories: createV2Repositories(database) });

  function handleError(res, error, event) {
    if (isSourceDocumentError(error)) {
      const status = error.code.endsWith('_NOT_FOUND') ? 404 : 400;
      return response.error(res, status, error.code, error.message);
    }
    if (isSourceTextImportError(error) || isSourceStructureError(error)) {
      return response.error(res, 400, error.code, error.message);
    }
    if (error instanceof V2RepositoryConflictError) {
      return response.error(res, 409, 'SOURCE_DOCUMENT_CONFLICT', 'Source document write conflicted');
    }
    log?.error?.(event, { code: 'SOURCE_DOCUMENT_UNEXPECTED' });
    return response.error(res, 500, 'SOURCE_DOCUMENT_UNEXPECTED', 'Source document operation failed');
  }

  function receiveFile(req, res, next) {
    upload.single('file')(req, res, (error) => {
      if (!error) return next();
      if (error.code === 'LIMIT_FILE_SIZE') {
        return response.error(res, 413, 'SOURCE_TEXT_FILE_TOO_LARGE', 'Source text file exceeds the supported limit');
      }
      return response.error(res, 400, 'SOURCE_DOCUMENT_INPUT_INVALID', 'Source document upload is invalid');
    });
  }

  router.post('/dramas/:dramaId/source-documents', receiveFile, (req, res) => {
    try {
      const dramaId = parseDramaId(req.params.dramaId);
      if (dramaId === null || !req.file?.buffer || typeof req.file.originalname !== 'string') {
        return response.error(res, 400, 'SOURCE_DOCUMENT_INPUT_INVALID', 'Source document upload is invalid');
      }
      const result = service.importDocument({
        dramaId,
        fileName: req.file.originalname,
        bytes: req.file.buffer,
        ...(req.body?.encoding ? { encoding: req.body.encoding } : {}),
      });
      return result.status === 'ready' ? response.created(res, result) : response.success(res, result);
    } catch (error) {
      return handleError(res, error, 'source-document-import');
    }
  });

  router.get('/dramas/:dramaId/source-documents', (req, res) => {
    try {
      const dramaId = parseDramaId(req.params.dramaId);
      if (dramaId === null) {
        return response.error(res, 400, 'SOURCE_DOCUMENT_INPUT_INVALID', 'Source document request is invalid');
      }
      return response.success(res, service.listDocuments(dramaId));
    } catch (error) {
      return handleError(res, error, 'source-document-list');
    }
  });

  router.get('/source-documents/:documentUid', (req, res) => {
    try {
      return response.success(res, service.getDocument(req.params.documentUid));
    } catch (error) {
      return handleError(res, error, 'source-document-get');
    }
  });

  router.post('/source-documents/:documentUid/selections', (req, res) => {
    try {
      const body = req.body || {};
      return response.created(res, service.createSelection({
        documentUid: req.params.documentUid,
        startBlockUid: body.start_block_uid,
        endBlockUid: body.end_block_uid,
        startOffset: body.start_offset,
        endOffset: body.end_offset,
      }));
    } catch (error) {
      return handleError(res, error, 'source-selection-create');
    }
  });

  return router;
}

module.exports = sourceDocumentRoutes;
