'use strict';

// Reviewed GitHub REST endpoints only. No arbitrary URL, headers or HTTP methods.
const crypto = require('node:crypto');
const { requestFetch, requestFailureCode, httpFailureCode } = require('./commerce-request-context.cjs');
const { readBody } = require('./storefront-admin-api.cjs');
const BASE = 'https://api.github.com';
const isProvider = p => p === 'github';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const object = v => v && typeof v === 'object' && !Array.isArray(v);
function apiBase(provider, metadata) {
  if (!isProvider(provider) || !object(metadata) || Object.keys(metadata).length) fail('E_BAD_INPUT', 'Invalid GitHub binding');
  return BASE;
}
function setup(config) {
  apiBase(config.provider, config.metadata);
  const token = config.credentials?.access_token;
  if (typeof token !== 'string' || token.length < 8 || token.length > 4096 || /[^\x21-\x7e]/.test(token)) fail('E_TOOL_CALL_AUTH', 'Invalid GitHub token');
}
const fingerprint = config => crypto.createHash('sha256').update(config.credentials.access_token).digest('hex');
function validateBinding(config) {
  setup(config);
  if (config.credentials.provider !== 'github' || config.credentials.identity?.fingerprint !== fingerprint(config)) fail('E_TOOL_CALL_AUTH', 'GitHub credentials changed; reconnect');
}
async function request(config, route, { method = 'GET', query, body } = {}) {
  setup(config);
  const url = new URL(BASE + route);
  if (url.origin !== BASE) fail('E_BAD_INPUT', 'Invalid GitHub route');
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const deadline = AbortSignal.timeout(60000);
  let response;
  try {
    response = await requestFetch(url.toString(), { method, redirect: 'error', signal: deadline,
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${config.credentials.access_token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'ZI-Orkas', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch (err) { fail(requestFailureCode(err, deadline), 'GitHub request failed. Check GitHub before retrying an uncertain write.'); }
  if (!response.ok) fail(response.status === 403 ? 'E_TOOL_CALL_UPSTREAM' : httpFailureCode(response.status), `GitHub request failed (HTTP ${response.status}). Check token permissions, repository access and Actions settings.`);
  if (response.status === 204) return { accepted: true };
  let source;
  try { source = await readBody(response); } catch (err) { fail(err?.code === 'E_CONNECTOR_RESPONSE_TOO_LARGE' ? 'E_TOOL_CALL_UPSTREAM' : requestFailureCode(err, deadline), 'Could not read GitHub response'); }
  try { return JSON.parse(source); } catch { fail('E_TOOL_CALL_UPSTREAM', 'GitHub returned invalid data'); }
}
const str = maxLength => ({ type: 'string', minLength: 1, maxLength });
const segment = { ...str(100), pattern: '^[A-Za-z0-9_][A-Za-z0-9_.-]*$' };
const filePath = { ...str(500), pattern: '^[A-Za-z0-9_.@/-]+$' };
const page = { type: 'integer', minimum: 1, maximum: 1000 };
const number = { type: 'integer', minimum: 1, maximum: 2147483647 };
const repo = { owner: segment, repo: segment };
const action = (risk, description, properties, required) => ({ risk, description, input_schema: { type: 'object', properties, required, additionalProperties: false } });
const actions = {
  'repos.list': action('R', 'List repositories accessible to the token; page size 100.', { page }, []),
  'repos.get': action('R', 'Get one repository.', repo, ['owner', 'repo']),
  'repos.create': action('H', 'Create a repository for the authenticated user. Explicitly choose private true or false.', { name: segment, private: { type: 'boolean' }, description: { type: 'string', maxLength: 350 }, auto_init: { type: 'boolean' } }, ['name', 'private']),
  'issues.list': action('R', 'List repository issues (GitHub may include pull requests).', { ...repo, page }, ['owner', 'repo']),
  'issues.create': action('W', 'Create an issue.', { ...repo, title: str(256), body: { type: 'string', maxLength: 50000 } }, ['owner', 'repo', 'title']),
  'pulls.list': action('R', 'List pull requests.', { ...repo, page }, ['owner', 'repo']),
  'pulls.create': action('W', 'Create a pull request.', { ...repo, title: str(256), head: str(255), base: str(255), body: { type: 'string', maxLength: 50000 } }, ['owner', 'repo', 'title', 'head', 'base']),
  'files.get': action('R', 'Read a repository file or directory; optionally select a branch or commit.', { ...repo, path: filePath, ref: str(255) }, ['owner', 'repo', 'path']),
  'files.put': action('H', 'Create or update a file. Supply the existing blob sha for updates. Content is UTF-8 text.', { ...repo, path: filePath, message: str(500), content: { type: 'string', maxLength: 500000 }, branch: str(255), sha: { type: 'string', pattern: '^[a-fA-F0-9]{40}$' } }, ['owner', 'repo', 'path', 'message', 'content']),
  'workflows.list': action('R', 'List Actions workflows; page size 100.', { ...repo, page }, ['owner', 'repo']),
  'workflows.dispatch': action('H', 'Queue a workflow_dispatch run. The workflow must support workflow_dispatch and exist on the default branch. This only queues, not confirms a successful build.', { ...repo, workflow: { ...str(100), pattern: '^[A-Za-z0-9_][A-Za-z0-9_.-]*$' }, ref: str(255), inputs: { type: 'object', maxProperties: 25, additionalProperties: { type: 'string', maxLength: 1000 } } }, ['owner', 'repo', 'workflow', 'ref']),
  'runs.list': action('R', 'List Actions runs; page size 100.', { ...repo, page }, ['owner', 'repo']),
  'runs.get': action('R', 'Get one Actions run and its status and conclusion.', { ...repo, run_id: number }, ['owner', 'repo', 'run_id']),
};
function valid(value, schema) {
  if (schema.type === 'object') {
    if (!object(value) || (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties)) return false;
    if ((schema.required || []).some(key => !Object.hasOwn(value, key))) return false;
    return Object.entries(value).every(([key, child]) => {
      const descriptor = schema.properties?.[key];
      if (descriptor) return valid(child, descriptor);
      if (schema.additionalProperties === false) return false;
      return typeof schema.additionalProperties === 'object' ? valid(child, schema.additionalProperties) : true;
    });
  }
  if (schema.type === 'string') return typeof value === 'string'
    && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity)
    && (!schema.pattern || new RegExp(schema.pattern).test(value));
  if (schema.type === 'integer') return Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
  if (schema.type === 'boolean') return typeof value === 'boolean';
  return false;
}
const actionsFor = () => actions;
function encodedPath(path) {
  const parts = path.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) fail('E_BAD_INPUT', 'Invalid file path');
  return parts.map(encodeURIComponent).join('/');
}
function sanitize(value, token, depth = 0) {
  if (depth > 40) fail('E_TOOL_CALL_UPSTREAM', 'GitHub response too deeply nested');
  if (typeof value === 'string') return value.split(token).join('[redacted]');
  if (Array.isArray(value)) return value.map(v => sanitize(v, token, depth + 1));
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, token, depth + 1)]));
}
async function execute(config, name, p = {}) {
  validateBinding(config);
  if (!Object.hasOwn(actions, name) || !valid(p, actions[name].input_schema)) fail('E_BAD_INPUT', 'Invalid or unsupported GitHub action parameters');
  const root = p.owner ? `/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}` : '';
  const paging = { per_page: 100, page: p.page || 1 };
  let data;
  switch (name) {
    case 'repos.list': data = await request(config, '/user/repos', { query: { ...paging, sort: 'updated' } }); break;
    case 'repos.get': data = await request(config, root); break;
    case 'repos.create': data = await request(config, '/user/repos', { method: 'POST', body: { name: p.name, private: p.private, ...(p.description !== undefined ? { description: p.description } : {}), auto_init: p.auto_init ?? false } }); break;
    case 'issues.list': case 'pulls.list': data = await request(config, `${root}/${name.split('.')[0]}`, { query: paging }); break;
    case 'issues.create': data = await request(config, `${root}/issues`, { method: 'POST', body: { title: p.title, ...(p.body !== undefined ? { body: p.body } : {}) } }); break;
    case 'pulls.create': data = await request(config, `${root}/pulls`, { method: 'POST', body: { title: p.title, head: p.head, base: p.base, ...(p.body !== undefined ? { body: p.body } : {}) } }); break;
    case 'files.get': data = await request(config, `${root}/contents/${encodedPath(p.path)}`, { query: { ref: p.ref } }); break;
    case 'files.put': data = await request(config, `${root}/contents/${encodedPath(p.path)}`, { method: 'PUT', body: { message: p.message, content: Buffer.from(p.content, 'utf8').toString('base64'), ...(p.sha ? { sha: p.sha } : {}), ...(p.branch ? { branch: p.branch } : {}) } }); break;
    case 'workflows.list': data = await request(config, `${root}/actions/workflows`, { query: paging }); break;
    case 'workflows.dispatch': data = await request(config, `${root}/actions/workflows/${encodeURIComponent(p.workflow)}/dispatches`, { method: 'POST', body: { ref: p.ref, ...(p.inputs ? { inputs: p.inputs } : {}) } }); break;
    case 'runs.list': data = await request(config, `${root}/actions/runs`, { query: paging }); break;
    case 'runs.get': data = await request(config, `${root}/actions/runs/${p.run_id}`); break;
  }
  return sanitize(data, config.credentials.access_token);
}
async function identity(config) {
  validateBinding(config);
  const user = await request(config, '/user');
  if (!object(user) || typeof user.login !== 'string' || !user.login) fail('E_TOOL_CALL_AUTH', 'GitHub account verification failed');
  return { login: sanitize(user.login, config.credentials.access_token), authorization_verified: true };
}
async function authorize(config) {
  setup(config);
  const credentials = { provider: 'github', access_token: config.credentials.access_token, identity: { fingerprint: fingerprint(config) } };
  await identity({ ...config, credentials });
  return credentials;
}
module.exports = { isProvider, apiBase, actionsFor, validateBinding, identity, execute, authorize };
