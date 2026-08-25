'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildHubContext,
  createImageAsset,
  hubBusinessErrorMessage,
  listAssets,
  normalizeMaterialHubToken,
  tokenFingerprint,
  unwrapMaterialHubAssetView,
} = require('../src/services/jimengMaterialHubService');

describe('jimengMaterialHub response parsing', () => {
  it('hubBusinessErrorMessage detects model_ark 200+error body', () => {
    const msg = hubBusinessErrorMessage({
      error: '[Failed to download media from the provided URL.]',
    });
    assert.match(msg, /download media/i);
  });

  it('unwrapMaterialHubAssetView parses flat AssetView', () => {
    const asset = unwrapMaterialHubAssetView({
      id: 'asset-20260602203139-2vr49',
      asset_url: 'asset://asset-20260602203139-2vr49',
      status: 'processing',
    });
    assert.equal(asset.id, 'asset-20260602203139-2vr49');
    assert.equal(asset.status, 'processing');
  });

  it('unwrapMaterialHubAssetView parses data wrapper', () => {
    const asset = unwrapMaterialHubAssetView({
      data: { asset_id: 'AST-1', status: 'active', asset_url: 'asset://x' },
    });
    assert.equal(asset.id, 'AST-1');
  });

  it('unwrapMaterialHubAssetView returns null when only error field', () => {
    assert.equal(unwrapMaterialHubAssetView({ error: 'failed' }), null);
  });

  it('normalizeMaterialHubToken strips Bearer and zero-width chars', () => {
    const t = normalizeMaterialHubToken('Bearer sk-test\u200bkey\u200b');
    assert.equal(t, 'sk-testkey');
  });

  it('tokenFingerprint shows head and tail only', () => {
    assert.equal(tokenFingerprint('sk-abcdefghijklmnop'), 'sk-abcd…mnop');
  });

  it('forces redaction at the service boundary even with a raw caller logger', async (t) => {
    const originalFetch = global.fetch;
    const secret = 'fixture-service-boundary-token';
    const logged = [];
    const rawLogger = {
      info(message, fields) { logged.push(['info', message, fields]); },
      warn(message, fields) { logged.push(['warn', message, fields]); },
    };
    global.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {
        return JSON.stringify({ error: `upstream echoed ${secret}` });
      },
    });
    t.after(() => {
      global.fetch = originalFetch;
    });

    const result = await listAssets(
      { baseUrl: 'https://hub.invalid', token: secret },
      { limit: 1 },
      rawLogger,
    );
    const serialized = JSON.stringify([result, logged]);

    assert.equal(result.ok, false);
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.match(serialized, /\[redacted\]/);
  });

  it('does not place token fingerprints in context diagnostics or logs', () => {
    const secret = 'fixture-context-secret-token';
    const logged = [];
    const ctx = buildHubContext(
      { jimeng_material_hub: { base_url: 'https://hub.invalid', token: secret } },
      null,
      { info(message, fields) { logged.push([message, fields]); } },
    );
    const serialized = JSON.stringify([ctx.hubAuthDiag, ctx.tokenFingerprint, logged]);

    assert.equal(Object.hasOwn(ctx.hubAuthDiag, 'token_fingerprint'), false);
    assert.equal(Object.hasOwn(ctx, 'tokenFingerprint'), false);
    assert.doesNotMatch(serialized, /fixture-|secret-token/);
  });

  it('redacts malformed successful responses before createImageAsset logs them', async (t) => {
    const originalFetch = global.fetch;
    const secret = 'fixture-malformed-success-token';
    const logged = [];
    global.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {
        return JSON.stringify({ unexpected: `echo ${secret}` });
      },
    });
    t.after(() => {
      global.fetch = originalFetch;
    });

    const result = await createImageAsset(
      { baseUrl: 'https://hub.invalid', token: secret },
      { url: 'https://image.invalid/a.png', name: 'fixture' },
      { warn(message, fields) { logged.push([message, fields]); }, info() {} },
    );

    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(logged), new RegExp(secret));
  });
});
