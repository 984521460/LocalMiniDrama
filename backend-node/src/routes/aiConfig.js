const aiConfigService = require('../services/aiConfigService');
const response = require('../response');
const {
  projectPublicAiConfig,
  redactAiConfigErrorText,
} = require('../security/aiConfigSecrets');
const { createAiConfigRedactedLogger } = require('../security/aiConfigRedactedLogger');

function resolveOperationConfig(db, body, res) {
  const resolved = aiConfigService.resolveConfigForOperation(db, body);
  if (resolved.status === 'invalid_id') {
    response.badRequest(res, '无效的配置ID');
    return null;
  }
  if (resolved.status === 'not_found') {
    response.notFound(res, '配置不存在');
    return null;
  }
  return resolved.config;
}

function list(db) {
  return (req, res) => {
    const list = aiConfigService.listConfigs(db, req.query.service_type);
    response.success(res, list.map(projectPublicAiConfig));
  };
}

function get(db) {
  return (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return response.badRequest(res, '无效的配置ID');
    const config = aiConfigService.getConfig(db, id);
    if (!config) return response.notFound(res, '配置不存在');
    response.success(res, projectPublicAiConfig(config));
  };
}

function vendorLock(cfg) {
  return (req, res) => {
    const status = aiConfigService.getVendorLockStatus(cfg);
    response.success(res, status);
  };
}

function create(db, log, cfg) {
  return (req, res) => {
    if (aiConfigService.getVendorLockStatus(cfg).enabled) {
      return response.badRequest(res, '当前为厂商锁定模式，不允许添加配置');
    }
    const body = req.body || {};
    if (!body.service_type || !body.name || !body.provider || !body.base_url) {
      return response.badRequest(res, '缺少必填字段: service_type, name, provider, base_url');
    }
    try {
      const config = aiConfigService.createConfig(db, log, {
        ...body,
        model: body.model ?? [],
      });
      response.created(res, projectPublicAiConfig(config));
    } catch (err) {
      log.errorw('Create AI config failed', { error: err.message });
      response.internalError(res, '创建失败');
    }
  };
}

function update(db, log, cfg) {
  return (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return response.badRequest(res, '无效的配置ID');

    let body = req.body || {};
    // 锁定模式下只允许修改 api_key、default_model、is_default
    if (aiConfigService.getVendorLockStatus(cfg).enabled) {
      const allowed = {};
      if (body.api_key !== undefined) allowed.api_key = body.api_key;
      if (body.default_model !== undefined) allowed.default_model = body.default_model;
      if (body.is_default !== undefined) allowed.is_default = body.is_default;
      body = allowed;
    }

    const config = aiConfigService.updateConfig(db, log, id, body);
    if (!config) return response.notFound(res, '配置不存在');
    response.success(res, projectPublicAiConfig(config));
  };
}

function remove(db, log, cfg) {
  return (req, res) => {
    if (aiConfigService.getVendorLockStatus(cfg).enabled) {
      return response.badRequest(res, '当前为厂商锁定模式，不允许删除配置');
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return response.badRequest(res, '无效的配置ID');
    const ok = aiConfigService.deleteConfig(db, log, id);
    if (!ok) return response.notFound(res, '配置不存在');
    response.success(res, { message: '删除成功' });
  };
}

function bulkUpdateKey(db, log, cfg) {
  return (req, res) => {
    if (!aiConfigService.getVendorLockStatus(cfg).enabled) {
      return response.badRequest(res, '批量换Key仅在厂商锁定模式下可用');
    }
    const { api_key } = req.body || {};
    if (!api_key || !api_key.trim()) {
      return response.badRequest(res, '请提供新的 API Key');
    }
    try {
      const count = aiConfigService.bulkUpdateApiKey(db, log, api_key.trim());
      response.success(res, { updated: count, message: `已更新 ${count} 条配置的 API Key` });
    } catch (err) {
      log.error('Bulk update api_key failed', { error: err.message });
      response.internalError(res, '批量换Key失败');
    }
  };
}

function testConnection(db, log) {
  return async (req, res) => {
    const body = req.body || {};
    const config = resolveOperationConfig(db, body, res);
    if (!config) return;
    if (!config.base_url || !config.api_key) {
      return response.badRequest(res, '缺少 base_url 或 api_key');
    }
    try {
      await aiConfigService.testConnection({
        base_url: config.base_url,
        api_key: config.api_key,
        model: config.model,
        provider: config.provider,
        endpoint: config.endpoint,
        service_type: config.service_type,
        settings: config.settings,
      });
      response.success(res, { message: '连接测试成功' });
    } catch (err) {
      const safeError = redactAiConfigErrorText(err.message || '未知错误', config);
      log.error('AI config test connection failed', { error: safeError });
      response.badRequest(res, '连接测试失败: ' + safeError);
    }
  };
}

/** ModelArk / 方舟私有资产库：代理调用 CreateAssetGroup、ListAssets 等（与官方 Action 名一致） */
function modelArkAsset(db, log) {
  return async (req, res) => {
    const body = req.body || {};
    const action = (body.action || '').toString().trim();
    let operationConfig = null;
    try {
      operationConfig = resolveOperationConfig(db, body, res);
      if (!operationConfig) return;
      const settings = operationConfig.settings || {};
      const modelArkAssetProxyService = require('../services/modelArkAssetProxyService');
      const data = await modelArkAssetProxyService.callModelArkAsset(
        {
          base_url: operationConfig.base_url,
          api_key: operationConfig.api_key,
          action,
          body: operationConfig.payload,
          path_mode: operationConfig.path_mode || settings.path_mode,
          http_method: operationConfig.http_method || settings.http_method,
          api_version: operationConfig.api_version || settings.api_version,
          auth_mode: operationConfig.auth_mode || settings.auth_mode,
          access_key_id: operationConfig.access_key_id || settings.access_key_id,
          secret_access_key: operationConfig.secret_access_key || settings.secret_access_key,
          sign_region: operationConfig.sign_region || settings.sign_region,
          sign_service: operationConfig.sign_service || settings.sign_service,
          session_token: operationConfig.session_token || settings.session_token,
          project_name: operationConfig.project_name || settings.project_name,
        },
        createAiConfigRedactedLogger(log, operationConfig)
      );
      response.success(res, data);
    } catch (err) {
      const safeError = redactAiConfigErrorText(err.message || '请求失败', operationConfig || {});
      log.error('model-ark-asset proxy failed', { error: safeError, action });
      const status = err.status >= 400 && err.status < 600 ? err.status : 400;
      return response.error(res, status, 'MODEL_ARK_ASSET', safeError);
    }
  };
}

/** 即梦2角色认证：代理 GET 素材列表（表单未保存也可用当前填写的网关与 Token） */
function listJimeng2MaterialAssets(db, log) {
  return async (req, res) => {
    const body = req.body || {};
    const config = resolveOperationConfig(db, body, res);
    if (!config) return;
    const base_url = (config.base_url || '').toString().trim().replace(/\/$/, '');
    const { normalizeMaterialHubToken } = require('../services/jimengMaterialHubService');
    const api_key = normalizeMaterialHubToken(config.api_key || '');
    if (!base_url || !api_key) {
      return response.badRequest(res, '请先填写网关 URL 与 Token');
    }
    const jimengMaterialHubService = require('../services/jimengMaterialHubService');
    const ctx = { baseUrl: base_url, token: api_key };
    const safeLog = createAiConfigRedactedLogger(log, config);
    const r = await jimengMaterialHubService.listAssets(ctx, { limit: config.limit, cursor: config.cursor }, safeLog);
    if (!r.ok) {
      const safeError = redactAiConfigErrorText(r.error || '列出素材失败', config);
      return response.badRequest(res, safeError.slice(0, 800));
    }
    response.success(res, r.data);
  };
}

module.exports = function aiConfigRoutes(db, log, cfg) {
  return {
    list: list(db),
    get: get(db),
    vendorLock: vendorLock(cfg),
    create: create(db, log, cfg),
    update: update(db, log, cfg),
    delete: remove(db, log, cfg),
    testConnection: testConnection(db, log),
    listJimeng2MaterialAssets: listJimeng2MaterialAssets(db, log),
    modelArkAsset: modelArkAsset(db, log),
    bulkUpdateKey: bulkUpdateKey(db, log, cfg),
  };
};
