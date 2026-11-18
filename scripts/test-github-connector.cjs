'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const api = require('../bin/github-api.cjs');
const auth = require('../bin/local-api-auth.cjs');
const mcp = require('../bin/direct-commerce-mcp-server.cjs');
const codec = require('../bin/local-api-credential-codec.cjs');

test('PAT authorization, encrypted runtime, action lanes, API routes and failures', async () => {
  const original = global.fetch;
  const calls = [];
  let status = 200;
  const token = 'ghp_test_token_only';
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), ...init });
    if (status !== 200) return new Response('provider may echo ' + token, { status });
    if (String(url).endsWith('/dispatches')) return new Response(null, { status: 204 });
    return Response.json(String(url).endsWith('/user') ? { login: 'octocat' } : { value: token });
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-github-test-'));
  try {
    assert(auth.SELF_AUTH_PROVIDERS.has('github'));
    const raw = { provider: 'github', metadata: {}, credentials: { access_token: token } };
    const credentials = await auth.authorizeConfigured(raw);
    assert.equal(calls[0].url, 'https://api.github.com/user');
    assert.equal(calls[0].headers.authorization, `Bearer ${token}`);
    const key = crypto.randomBytes(32).toString('base64url');
    const file = path.join(dir, 'credentials');
    codec.writeCredentialFile(file, key, credentials);
    assert(!fs.readFileSync(file, 'utf8').includes(token));
    const env = { ORKAS_LOCAL_API_PROVIDER: 'github', ORKAS_LOCAL_API_METADATA_JSON: '{}', ORKAS_LOCAL_API_CREDENTIAL_FILE: file, ORKAS_LOCAL_API_CREDENTIAL_KEY: key };
    const caps = await mcp.callTool('list_capabilities', {}, env);
    assert(caps.actions.some(a => a.action === 'workflows.dispatch' && a.risk === 'H'));
    assert.equal(caps.identity.login, 'octocat');
    await assert.rejects(mcp.callTool('execute_read', { action: 'workflows.dispatch', parameters: { owner: 'octo', repo: 'app', workflow: 'build.yml', ref: 'main' } }, env), /risk mismatch/);
    const dispatch = await mcp.callTool('execute_high_impact', { action: 'workflows.dispatch', parameters: { owner: 'octo', repo: 'app', workflow: 'build.yml', ref: 'feature/test', inputs: { mode: 'release' } } }, env);
    assert.deepEqual(dispatch.result, { accepted: true });
    let last = calls.at(-1);
    assert.equal(last.url, 'https://api.github.com/repos/octo/app/actions/workflows/build.yml/dispatches');
    assert.deepEqual(JSON.parse(last.body), { ref: 'feature/test', inputs: { mode: 'release' } });
    await mcp.callTool('execute_high_impact', { action: 'repos.create', parameters: { name: 'app', private: true } }, env);
    last = calls.at(-1);
    assert.equal(JSON.parse(last.body).private, true);
    await assert.rejects(mcp.callTool('execute_high_impact', { action: 'repos.create', parameters: { name: 'app' } }, env));
    await assert.rejects(mcp.callTool('execute_read', { action: 'files.get', parameters: { owner: 'octo', repo: 'app', path: '../secret' } }, env));
    await assert.rejects(mcp.callTool('execute_high_impact', { action: 'workflows.dispatch', parameters: { owner: 'octo', repo: 'app', workflow: 'build.yml', ref: 'main', inputs: { foo: 1 } } }, env));
    const repos = await mcp.callTool('execute_read', { action: 'repos.list', parameters: {} }, env);
    assert.equal(repos.result.value, '[redacted]');
    assert.equal(calls.at(-1).url, 'https://api.github.com/user/repos?per_page=100&page=1&sort=updated');
    const read = await mcp.callTool('execute_read', { action: 'runs.get', parameters: { owner: 'octo', repo: 'app', run_id: 12 } }, env);
    assert.equal(read.result.value, '[redacted]');
    status = 401;
    await assert.rejects(api.authorize(raw), e => e.code === 'E_TOOL_CALL_AUTH' && !e.message.includes(token));
    status = 403;
    await assert.rejects(api.execute({ ...raw, credentials }, 'repos.get', { owner: 'octo', repo: 'app' }), e => e.code === 'E_TOOL_CALL_UPSTREAM');
    status = 200;
    assert.throws(() => api.validateBinding({ ...raw, credentials: { ...credentials, access_token: 'different-token' } }));
  } finally {
    global.fetch = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
