/**
 * ZI-Orkas Self-Hosted Cloud & Collaboration Suite.
 *
 * Unlocks self-hosted equivalents of commercial-only Orkas desktop workflows
 * without requiring an Orkas cloud subscription or proprietary server:
 *
 *  1. Web App Publishing & Standalone Bundle Export:
 *     - Export any saved app as a deploy-ready `.zip` (with a standalone
 *       browser `window.orkasApp` runtime shim for storage, data tables, and
 *       file pick/save).
 *     - One-click live publication & updates to GitHub Pages (using an
 *       encrypted user-owned GitHub token or authenticated local `gh` CLI).
 *
 *  2. Project Collaboration Bundles (`.zi-orkas-project.zip`):
 *     - Export a complete project (metadata, ORKAS.md instructions, MEMORY.md,
 *       to-dos, and library files) to share with teammates or other devices.
 *     - Import a shared project bundle with strict zip-slip & size guards.
 *
 *  3. Multi-Device Workspace Sync Snapshots (`.zi-orkas-sync.zip`):
 *     - Export / import user agents, skills, memory, projects, automations,
 *       and saved apps for synchronization via Google Drive, iCloud, OneDrive,
 *       Syncthing, or offline archives (API keys are never included).
 *
 *  4. Self-Hosted GitHub Releases Update Checker:
 *     - Checks `zigorminsk-debug/ZI-orkas` (or `ZI_ORKAS_UPDATE_REPO`) for
 *       newer releases and returns the matching installer asset for the host OS.
 */

import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import { app, BrowserWindow, dialog, type WebContents } from 'electron';

import { createLogger } from '../logger';
import {
  projectDir,
  projectFilesDir,
  projectInstructionsFile,
  projectMemoryFile,
  savedAppDir,
  userAppPublishingDir,
  userCloudRoot,
  userLocalRoot,
} from '../paths';
import { readJsonSync, writeJsonSync } from '../storage';
import * as localSecrets from '../util/local-secret-store';
import * as projects from './projects';
import * as projectFiles from './project_files';
import * as projectTasks from './project_tasks';
import * as savedApps from './saved_apps';

const log = createLogger('zi-orkas-suite');

export const DEFAULT_GITHUB_REPO = 'zigorminsk-debug/ZI-orkas';
const GITHUB_API_BASE = 'https://api.github.com';
const MAX_BUNDLE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_BUNDLE_ENTRIES = 5_000;
const MAX_PAGES_TOTAL_BYTES = 48 * 1024 * 1024;
const MAX_PAGES_FILES = 400;

const SAFE_APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE_REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export interface PublishedAppRecord {
  appId: string;
  title: string;
  repoFullName: string;
  repoName: string;
  branch: string;
  url: string;
  publishedAt: string;
  fileCount: number;
}

interface PublishingStateFile {
  version: 1;
  githubTokenEnc?: string;
  published: Record<string, PublishedAppRecord>;
}

function publishingStateFile(uid: string): string {
  return path.join(userAppPublishingDir(uid), 'zi-orkas-publishing.json');
}

function readPublishingState(uid: string): PublishingStateFile {
  const raw = readJsonSync<Partial<PublishingStateFile> | null>(publishingStateFile(uid));
  if (!raw || typeof raw !== 'object') {
    return { version: 1, published: {} };
  }
  const published = raw.published && typeof raw.published === 'object' && !Array.isArray(raw.published)
    ? (raw.published as Record<string, PublishedAppRecord>)
    : {};
  return {
    version: 1,
    githubTokenEnc: typeof raw.githubTokenEnc === 'string' ? raw.githubTokenEnc : undefined,
    published,
  };
}

function writePublishingState(uid: string, state: PublishingStateFile): void {
  const file = publishingStateFile(uid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonSync(file, state);
}

function tokenSecretCtx(uid: string): localSecrets.LocalSecretContext {
  return {
    namespace: 'zi-orkas-github-pages',
    ownerId: uid,
    recordId: 'github-pat',
  };
}

function readStoredGitHubToken(uid: string): string {
  const state = readPublishingState(uid);
  if (!state.githubTokenEnc) return '';
  try {
    return localSecrets.decryptLocalSecretWithMeta(tokenSecretCtx(uid), state.githubTokenEnc).plaintext.trim();
  } catch {
    return '';
  }
}

function detectGhCliToken(): string {
  try {
    const out = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      windowsHide: true,
    }).trim();
    return out && !/\s/.test(out) ? out : '';
  } catch {
    return '';
  }
}

export function getGitHubAuthStatus(uid: string): {
  hasStoredToken: boolean;
  hasGhCliToken: boolean;
  ready: boolean;
} {
  const hasStoredToken = Boolean(readStoredGitHubToken(uid));
  const hasGhCliToken = hasStoredToken ? false : Boolean(detectGhCliToken());
  return { hasStoredToken, hasGhCliToken, ready: hasStoredToken || hasGhCliToken };
}

export function saveGitHubToken(uid: string, token: string): { ok: true; hasStoredToken: boolean } {
  const trimmed = String(token || '').trim();
  const state = readPublishingState(uid);
  if (!trimmed) {
    delete state.githubTokenEnc;
  } else {
    state.githubTokenEnc = localSecrets.encryptLocalSecret(tokenSecretCtx(uid), trimmed);
  }
  writePublishingState(uid, state);
  return { ok: true, hasStoredToken: Boolean(trimmed) };
}

export function getAppPublishInfo(uid: string, appId: string): {
  ok: true;
  appId: string;
  title: string;
  suggestedRepo: string;
  record: PublishedAppRecord | null;
  auth: { hasStoredToken: boolean; hasGhCliToken: boolean; ready: boolean };
} | { ok: false; error: string } {
  const id = String(appId || '').trim();
  if (!SAFE_APP_ID_RE.test(id)) return { ok: false, error: 'Invalid app ID.' };
  const list = savedApps.listSavedApps(uid);
  const found = list.find((item) => item.id === id);
  if (!found) return { ok: false, error: 'Saved app not found.' };
  const state = readPublishingState(uid);
  const record = state.published[id] || null;
  const suggestedRepo = record?.repoName || `zi-orkas-app-${slugify(found.title, id.slice(0, 8))}`;
  return {
    ok: true,
    appId: id,
    title: found.title,
    suggestedRepo,
    record,
    auth: getGitHubAuthStatus(uid),
  };
}

export function listPublishedApps(uid: string): Record<string, PublishedAppRecord> {
  return readPublishingState(uid).published;
}

function slugify(input: string, fallback = 'app'): string {
  const ascii = String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return ascii || fallback;
}

function ownerWindow(sender?: WebContents): BrowserWindow | undefined {
  if (sender && !sender.isDestroyed()) {
    const win = BrowserWindow.fromWebContents(sender);
    if (win && !win.isDestroyed()) return win;
  }
  const focused = BrowserWindow.getFocusedWindow();
  return focused && !focused.isDestroyed() ? focused : undefined;
}

const STANDALONE_WEB_SDK_SHIM = `/* ZI-Orkas Standalone Web App SDK Shim (browser localStorage runtime) */
(function () {
  'use strict';
  if (window.orkasApp) return;
  const NS = 'zi_orkas_app:' + (location.pathname || '/');
  const kvKey = (k) => NS + ':kv:' + String(k);
  const tblKey = (t) => NS + ':tbl:' + String(t);
  const pickedFiles = new Map();

  function readTable(name) {
    try {
      const raw = localStorage.getItem(tblKey(name));
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
  }
  function writeTable(name, rows) {
    localStorage.setItem(tblKey(name), JSON.stringify(rows));
  }
  function matchesWhere(row, where) {
    if (!where || typeof where !== 'object') return true;
    return Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if ('eq' in v && row[k] !== v.eq) return false;
        if ('ne' in v && row[k] === v.ne) return false;
        if ('gt' in v && !(row[k] > v.gt)) return false;
        if ('gte' in v && !(row[k] >= v.gte)) return false;
        if ('lt' in v && !(row[k] < v.lt)) return false;
        if ('lte' in v && !(row[k] <= v.lte)) return false;
        if ('in' in v && Array.isArray(v.in) && !v.in.includes(row[k])) return false;
        if ('contains' in v && !String(row[k] ?? '').includes(String(v.contains))) return false;
        return true;
      }
      return row[k] === v;
    });
  }
  function genId() {
    return (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
  }

  const handlers = {
    'host.getContext': async () => ({ mode: 'published', edition: 'zi-orkas', locale: navigator.language || 'en' }),
    'capabilities.list': async () => ({
      capabilities: [
        'host.getContext', 'capabilities.list',
        'storage.get', 'storage.set', 'storage.remove', 'storage.keys',
        'data.query', 'data.count', 'data.insert', 'data.insertIf', 'data.update', 'data.delete', 'data.aggregate',
        'files.saveAs', 'files.pick', 'files.readText', 'files.release',
      ],
    }),
    'storage.get': async (a) => {
      const raw = localStorage.getItem(kvKey(a && a.key));
      if (raw === null) return { exists: false, value: null };
      try { return { exists: true, value: JSON.parse(raw) }; } catch (_) { return { exists: true, value: raw }; }
    },
    'storage.set': async (a) => {
      localStorage.setItem(kvKey(a && a.key), JSON.stringify(a ? a.value : null));
      return { ok: true };
    },
    'storage.remove': async (a) => {
      localStorage.removeItem(kvKey(a && a.key));
      return { ok: true };
    },
    'storage.keys': async () => {
      const prefix = NS + ':kv:';
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) keys.push(k.slice(prefix.length));
      }
      return { keys };
    },
    'data.query': async (a) => {
      const args = a || {};
      let rows = readTable(args.table || 'default').filter((r) => matchesWhere(r, args.where));
      if (args.orderBy) {
        const field = typeof args.orderBy === 'string' ? args.orderBy : args.orderBy.field;
        const desc = typeof args.orderBy === 'object' && String(args.orderBy.direction || '').toLowerCase() === 'desc';
        if (field) rows.sort((x, y) => (x[field] > y[field] ? 1 : x[field] < y[field] ? -1 : 0) * (desc ? -1 : 1));
      }
      const offset = Math.max(0, Number(args.offset || 0));
      const limit = args.limit ? Math.max(1, Number(args.limit)) : rows.length;
      return { rows: rows.slice(offset, offset + limit), total: rows.length };
    },
    'data.count': async (a) => {
      const args = a || {};
      return { count: readTable(args.table || 'default').filter((r) => matchesWhere(r, args.where)).length };
    },
    'data.insert': async (a) => {
      const args = a || {};
      const table = args.table || 'default';
      const rows = readTable(table);
      const now = new Date().toISOString();
      const record = Object.assign({ id: genId(), createdAt: now, updatedAt: now }, args.record || args.data || {});
      rows.push(record);
      writeTable(table, rows);
      return { id: record.id, record };
    },
    'data.insertIf': async (a) => {
      const args = a || {};
      const table = args.table || 'default';
      const rows = readTable(table);
      if (args.where && rows.some((r) => matchesWhere(r, args.where))) return { inserted: false };
      const res = await handlers['data.insert'](args);
      return Object.assign({ inserted: true }, res);
    },
    'data.update': async (a) => {
      const args = a || {};
      const table = args.table || 'default';
      const rows = readTable(table);
      const patch = args.patch || args.data || {};
      let updated = 0;
      const where = args.id ? { id: args.id } : args.where;
      for (let i = 0; i < rows.length; i++) {
        if (matchesWhere(rows[i], where)) {
          rows[i] = Object.assign({}, rows[i], patch, { updatedAt: new Date().toISOString() });
          updated++;
        }
      }
      writeTable(table, rows);
      return { updated };
    },
    'data.delete': async (a) => {
      const args = a || {};
      const table = args.table || 'default';
      const rows = readTable(table);
      const where = args.id ? { id: args.id } : args.where;
      const kept = rows.filter((r) => !matchesWhere(r, where));
      writeTable(table, kept);
      return { deleted: rows.length - kept.length };
    },
    'data.aggregate': async (a) => {
      const args = a || {};
      const rows = readTable(args.table || 'default').filter((r) => matchesWhere(r, args.where));
      const field = args.field;
      const nums = field ? rows.map((r) => Number(r[field])).filter(Number.isFinite) : [];
      const sum = nums.reduce((s, n) => s + n, 0);
      return {
        count: rows.length,
        sum,
        avg: nums.length ? sum / nums.length : 0,
        min: nums.length ? Math.min(...nums) : null,
        max: nums.length ? Math.max(...nums) : null,
      };
    },
    'files.saveAs': async (a) => {
      const name = String((a && a.name) || 'download.txt');
      const text = String((a && a.text) || '');
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      return { saved: true, name };
    },
    'files.pick': async (a) => new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (a && a.multiple) input.multiple = true;
      if (a && Array.isArray(a.accept)) input.accept = a.accept.join(',');
      input.onchange = () => {
        const files = Array.from(input.files || []).map((f) => {
          const handle = genId();
          pickedFiles.set(handle, f);
          return { handle, name: f.name, size: f.size, type: f.type };
        });
        resolve({ files });
      };
      input.click();
    }),
    'files.readText': async (a) => {
      const f = pickedFiles.get(a && a.handle);
      if (!f) throw Object.assign(new Error('File handle not found'), { code: 'E_NOT_FOUND' });
      return { text: await f.text(), name: f.name };
    },
    'files.release': async (a) => { pickedFiles.delete(a && a.handle); return { ok: true }; },
  };

  async function call(method, args) {
    const fn = handlers[method];
    if (!fn) {
      throw Object.assign(
        new Error('Desktop capability "' + method + '" is not available in standalone published web mode.'),
        { code: 'E_STANDALONE_UNSUPPORTED' },
      );
    }
    return fn(args || {});
  }

  const api = { version: 1, standalone: true, call };
  for (const name of Object.keys(handlers)) {
    const [group, method] = name.split('.');
    if (!api[group]) api[group] = {};
    api[group][method] = (args) => call(name, args);
  }
  window.orkasApp = Object.freeze(api);
})();
`;

function injectStandaloneSdkIntoHtml(html: string, sdkRelPath: string): string {
  const tag = `<script src="${sdkRelPath}"></script>`;
  if (html.includes('__zi-orkas-standalone-sdk.js')) return html;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}\n  ${tag}`);
  }
  return `${tag}\n${html}`;
}

interface PreparedWebFile {
  relPath: string;
  content: Buffer;
}

function collectSavedAppWebFiles(uid: string, appId: string): {
  ok: true;
  title: string;
  entry: string;
  files: PreparedWebFile[];
  totalBytes: number;
} | { ok: false; error: string } {
  const id = String(appId || '').trim();
  if (!SAFE_APP_ID_RE.test(id)) return { ok: false, error: 'Invalid app ID.' };
  const resolved = savedApps.resolveSavedAppIndex(uid, id);
  if (!resolved.ok) return { ok: false, error: ('error' in resolved && resolved.error) || 'App not found.' };
  const resolvedAbsPath = 'absPath' in resolved ? resolved.absPath : '';

  const root = path.resolve(savedAppDir(uid, id));
  const entryRel = path.relative(root, resolvedAbsPath).split(path.sep).join('/');
  const appInfo = savedApps.listSavedApps(uid).find((item) => item.id === id);
  const title = appInfo?.title || id;

  const files: PreparedWebFile[] = [];
  let totalBytes = 0;

  const walk = (dir: string, relPrefix = ''): void => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (dirent.name === '__orkas-meta.json' || dirent.name === '.DS_Store') continue;
      if (dirent.name.startsWith('.orkas-')) continue;
      if (dirent.isSymbolicLink()) continue;
      const abs = path.join(dir, dirent.name);
      const rel = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        walk(abs, rel);
      } else if (dirent.isFile()) {
        const stat = fs.statSync(abs);
        if (stat.size > MAX_BUNDLE_FILE_BYTES) {
          throw new Error(`File exceeds 64 MB limit: ${rel}`);
        }
        let buf = fs.readFileSync(abs);
        if (/\.html?$/i.test(dirent.name)) {
          const depth = rel.split('/').length - 1;
          const sdkRel = `${depth > 0 ? '../'.repeat(depth) : './'}__zi-orkas-standalone-sdk.js`;
          buf = Buffer.from(injectStandaloneSdkIntoHtml(buf.toString('utf8'), sdkRel), 'utf8');
        }
        totalBytes += buf.length;
        if (totalBytes > MAX_BUNDLE_TOTAL_BYTES) {
          throw new Error('App bundle exceeds size limit.');
        }
        files.push({ relPath: rel, content: buf });
      }
    }
  };

  try {
    walk(root);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  if (files.length === 0) return { ok: false, error: 'App folder has no publishable files.' };

  const shimBuf = Buffer.from(STANDALONE_WEB_SDK_SHIM, 'utf8');
  files.push({ relPath: '__zi-orkas-standalone-sdk.js', content: shimBuf });
  totalBytes += shimBuf.length;

  // If entry is not root index.html, add a lightweight redirect index.html so static hosts serve it cleanly.
  if (entryRel !== 'index.html' && !files.some((f) => f.relPath === 'index.html')) {
    const escaped = entryRel.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c] || c));
    const redirect = Buffer.from(
      `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=./${escaped}"><title>${escaped}</title>`,
      'utf8',
    );
    files.push({ relPath: 'index.html', content: redirect });
    totalBytes += redirect.length;
  }

  files.push({ relPath: '.nojekyll', content: Buffer.alloc(0) });
  return { ok: true, title, entry: entryRel, files, totalBytes };
}

export async function exportSavedAppZip(
  uid: string,
  appId: string,
  sender?: WebContents,
): Promise<{ ok: true; filePath: string; fileCount: number } | { ok: false; canceled?: boolean; error: string }> {
  const prepared = collectSavedAppWebFiles(uid, appId);
  if ('error' in prepared) return { ok: false, error: prepared.error };

  const defaultName = `${slugify(prepared.title, 'zi-orkas-app')}-web.zip`;
  const saveResult = await dialog.showSaveDialog(ownerWindow(sender) as BrowserWindow, {
    title: `Export "${prepared.title}" — Standalone Web App (.zip)`,
    defaultPath: path.join(app.getPath('downloads'), defaultName),
    filters: [{ name: 'ZIP Web Bundle', extensions: ['zip'] }],
  });
  if (saveResult.canceled || !saveResult.filePath) {
    return { ok: false, canceled: true, error: 'Export cancelled.' };
  }

  const zip = new AdmZip();
  for (const file of prepared.files) {
    zip.addFile(file.relPath, file.content);
  }
  zip.writeZip(saveResult.filePath);
  log.info('exported saved app zip', { appId, fileCount: prepared.files.length });
  return { ok: true, filePath: saveResult.filePath, fileCount: prepared.files.length };
}

async function ghRequest<T = any>(
  token: string,
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${GITHUB_API_BASE}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ZI-Orkas-Desktop',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data: any = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { message: text }; }
  }
  return { status: res.status, data };
}

export async function publishSavedAppToGitHubPages(
  uid: string,
  payload: { appId: string; repoName?: string; githubToken?: string; saveToken?: boolean },
): Promise<({ ok: true } & PublishedAppRecord) | { ok: false; error: string }> {
  const appId = String(payload?.appId || '').trim();
  const prepared = collectSavedAppWebFiles(uid, appId);
  if ('error' in prepared) return { ok: false, error: prepared.error };

  if (prepared.files.length > MAX_PAGES_FILES || prepared.totalBytes > MAX_PAGES_TOTAL_BYTES) {
    return {
      ok: false,
      error: 'App exceeds GitHub Pages direct upload limit (48 MB / 400 files). Export as .zip instead.',
    };
  }

  const providedToken = String(payload?.githubToken || '').trim();
  if (providedToken && payload?.saveToken !== false) {
    saveGitHubToken(uid, providedToken);
  }
  const token = providedToken || readStoredGitHubToken(uid) || detectGhCliToken();
  if (!token) {
    return {
      ok: false,
      error: 'GitHub token required. Enter a GitHub Personal Access Token (with repo + pages scope) or sign in via `gh auth login`.',
    };
  }

  // 1. Identify authenticated GitHub user
  const me = await ghRequest<{ login?: string; message?: string }>(token, 'GET', '/user');
  if (me.status !== 200 || !me.data?.login) {
    return { ok: false, error: `GitHub authentication failed (${me.status}): ${me.data?.message || 'invalid token'}` };
  }
  const owner = me.data.login;

  const state = readPublishingState(uid);
  const existingRecord = state.published[appId];
  const requestedRepo = String(payload?.repoName || '').trim()
    || existingRecord?.repoName
    || `zi-orkas-app-${slugify(prepared.title, appId.slice(0, 8))}`;
  if (!SAFE_REPO_NAME_RE.test(requestedRepo) || requestedRepo === '.' || requestedRepo === '..') {
    return { ok: false, error: 'Invalid GitHub repository name.' };
  }

  // 2. Ensure repository exists (auto-init so Git Data API is ready immediately)
  const repoCheck = await ghRequest<{ full_name?: string; default_branch?: string; private?: boolean }>(
    token,
    'GET',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(requestedRepo)}`,
  );
  let branch = 'main';
  if (repoCheck.status === 404) {
    const created = await ghRequest<{ default_branch?: string; message?: string }>(token, 'POST', '/user/repos', {
      name: requestedRepo,
      description: `${prepared.title} — Published with ZI-Orkas`,
      private: false,
      auto_init: true,
      has_issues: false,
      has_wiki: false,
    });
    if (created.status !== 201) {
      return { ok: false, error: `Could not create repository "${requestedRepo}": ${created.data?.message || created.status}` };
    }
    branch = created.data?.default_branch || 'main';
  } else if (repoCheck.status === 200) {
    branch = repoCheck.data?.default_branch || 'main';
  } else {
    return { ok: false, error: `Could not inspect repository "${owner}/${requestedRepo}" (HTTP ${repoCheck.status}).` };
  }

  const repoApi = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(requestedRepo)}`;

  // 3. Upload blobs and commit a clean tree to the default branch
  const treeEntries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = [];
  for (const file of prepared.files) {
    const blob = await ghRequest<{ sha?: string; message?: string }>(token, 'POST', `${repoApi}/git/blobs`, {
      content: file.content.toString('base64'),
      encoding: 'base64',
    });
    if (blob.status !== 201 || !blob.data?.sha) {
      return { ok: false, error: `Failed uploading "${file.relPath}": ${blob.data?.message || blob.status}` };
    }
    treeEntries.push({ path: file.relPath, mode: '100644', type: 'blob', sha: blob.data.sha });
  }

  const tree = await ghRequest<{ sha?: string; message?: string }>(token, 'POST', `${repoApi}/git/trees`, {
    tree: treeEntries,
  });
  if (tree.status !== 201 || !tree.data?.sha) {
    return { ok: false, error: `Failed creating Git tree: ${tree.data?.message || tree.status}` };
  }

  const headRef = await ghRequest<{ object?: { sha?: string } }>(
    token,
    'GET',
    `${repoApi}/git/ref/heads/${encodeURIComponent(branch)}`,
  );
  const parentSha = headRef.status === 200 && headRef.data?.object?.sha ? [headRef.data.object.sha] : [];

  const commit = await ghRequest<{ sha?: string; message?: string }>(token, 'POST', `${repoApi}/git/commits`, {
    message: `Deploy "${prepared.title}" via ZI-Orkas`,
    tree: tree.data.sha,
    parents: parentSha,
  });
  if (commit.status !== 201 || !commit.data?.sha) {
    return { ok: false, error: `Failed creating Git commit: ${commit.data?.message || commit.status}` };
  }

  if (parentSha.length > 0) {
    const upd = await ghRequest(token, 'PATCH', `${repoApi}/git/refs/heads/${encodeURIComponent(branch)}`, {
      sha: commit.data.sha,
      force: true,
    });
    if (upd.status !== 200) {
      return { ok: false, error: `Failed updating branch ${branch} (HTTP ${upd.status}).` };
    }
  } else {
    const crt = await ghRequest(token, 'POST', `${repoApi}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commit.data.sha,
    });
    if (crt.status !== 201) {
      return { ok: false, error: `Failed creating branch ${branch} (HTTP ${crt.status}).` };
    }
  }

  // 4. Enable GitHub Pages (idempotent: 409 means already enabled)
  let publicUrl = `https://${owner.toLowerCase()}.github.io/${requestedRepo}/`;
  const pagesCreate = await ghRequest<{ html_url?: string }>(token, 'POST', `${repoApi}/pages`, {
    source: { branch, path: '/' },
  });
  if ((pagesCreate.status === 201 || pagesCreate.status === 200) && pagesCreate.data?.html_url) {
    publicUrl = pagesCreate.data.html_url;
  } else {
    const pagesGet = await ghRequest<{ html_url?: string }>(token, 'GET', `${repoApi}/pages`);
    if (pagesGet.status === 200 && pagesGet.data?.html_url) {
      publicUrl = pagesGet.data.html_url;
    }
  }

  const record: PublishedAppRecord = {
    appId,
    title: prepared.title,
    repoFullName: `${owner}/${requestedRepo}`,
    repoName: requestedRepo,
    branch,
    url: publicUrl,
    publishedAt: new Date().toISOString(),
    fileCount: prepared.files.length,
  };
  state.published[appId] = record;
  writePublishingState(uid, state);
  log.info('published saved app to GitHub Pages', { appId, repo: record.repoFullName });
  return { ok: true, ...record };
}

export async function unpublishSavedApp(
  uid: string,
  appId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const id = String(appId || '').trim();
  const state = readPublishingState(uid);
  const record = state.published[id];
  if (!record) return { ok: true };

  const token = readStoredGitHubToken(uid) || detectGhCliToken();
  if (token && record.repoFullName.includes('/')) {
    const [owner, repo] = record.repoFullName.split('/', 2);
    try {
      await ghRequest(token, 'DELETE', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pages`);
    } catch { /* best-effort remote unpublish */ }
  }
  delete state.published[id];
  writePublishingState(uid, state);
  return { ok: true };
}

// ── Project Collaboration Bundles (.zi-orkas-project.zip) ────────────────

function isSafeArchiveRelPath(relPath: string): boolean {
  if (!relPath || relPath.length > 512) return false;
  if (relPath.includes('\0') || relPath.includes('\\')) return false;
  if (path.posix.isAbsolute(relPath)) return false;
  const parts = relPath.split('/');
  return parts.every((p) => p.length > 0 && p !== '.' && p !== '..');
}

function addDirectoryToZip(
  zip: AdmZip,
  absDir: string,
  zipPrefix: string,
  skipPredicate?: (relFromDir: string, name: string) => boolean,
): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  if (!fs.existsSync(absDir)) return { files, bytes };

  const walk = (current: string, rel = ''): void => {
    for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
      if (dirent.isSymbolicLink()) continue;
      if (dirent.name === '.DS_Store' || dirent.name.startsWith('.orkas-')) continue;
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (skipPredicate && skipPredicate(childRel, dirent.name)) continue;
      const abs = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        walk(abs, childRel);
      } else if (dirent.isFile()) {
        const stat = fs.statSync(abs);
        if (stat.size > MAX_BUNDLE_FILE_BYTES) continue;
        if (bytes + stat.size > MAX_BUNDLE_TOTAL_BYTES) {
          throw new Error('Archive exceeds 512 MB safety limit.');
        }
        zip.addFile(`${zipPrefix}/${childRel}`, fs.readFileSync(abs));
        files++;
        bytes += stat.size;
      }
    }
  };
  walk(absDir);
  return { files, bytes };
}

export async function exportProjectBundle(
  uid: string,
  projectId: string,
  sender?: WebContents,
): Promise<{ ok: true; filePath: string; taskCount: number; fileCount: number } | { ok: false; canceled?: boolean; error: string }> {
  const pid = String(projectId || '').trim();
  const proj = await projects.getProject(uid, pid);
  if (!proj) return { ok: false, error: 'Project not found.' };

  const defaultName = `${slugify(proj.name, 'project')}.zi-orkas-project.zip`;
  const saveResult = await dialog.showSaveDialog(ownerWindow(sender) as BrowserWindow, {
    title: `Share / Export Project "${proj.name}"`,
    defaultPath: path.join(app.getPath('downloads'), defaultName),
    filters: [{ name: 'ZI-Orkas Project Bundle', extensions: ['zip'] }],
  });
  if (saveResult.canceled || !saveResult.filePath) {
    return { ok: false, canceled: true, error: 'Export cancelled.' };
  }

  const instructions = await projects.readProjectInstructions(uid, pid);
  const memFile = projectMemoryFile(uid, pid);
  const memoryText = fs.existsSync(memFile) ? fs.readFileSync(memFile, 'utf8') : '';
  const tasks = await projectTasks.listTasks(uid, pid);
  const bindings = await projects.getBindings(uid, pid);

  const zip = new AdmZip();
  const filesRoot = projectFilesDir(uid, pid);
  const added = addDirectoryToZip(zip, filesRoot, 'files', (_rel, name) => name.startsWith('.kb'));

  const manifest = {
    format: 'zi-orkas-project-bundle',
    version: 1,
    exportedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    project: {
      name: proj.name,
      instructions: typeof instructions === 'string' ? instructions : (instructions as any)?.content || '',
      memory: memoryText,
      bindings,
      tasks: tasks.map((task) => ({
        title: (task as any).title || '',
        content: (task as any).content || '',
        description: (task as any).description || '',
        status: task.status,
        due_at: task.due_at ?? null,
      })),
    },
    stats: {
      taskCount: tasks.length,
      fileCount: added.files,
      fileBytes: added.bytes,
    },
  };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  zip.writeZip(saveResult.filePath);

  log.info('exported project bundle', { pid, taskCount: tasks.length, fileCount: added.files });
  return { ok: true, filePath: saveResult.filePath, taskCount: tasks.length, fileCount: added.files };
}

export async function importProjectBundle(
  uid: string,
  sender?: WebContents,
): Promise<
  | { ok: true; projectId: string; name: string; taskCount: number; fileCount: number }
  | { ok: false; canceled?: boolean; error: string }
> {
  const pick = await dialog.showOpenDialog(ownerWindow(sender) as BrowserWindow, {
    title: 'Import Shared ZI-Orkas Project Bundle',
    properties: ['openFile'],
    filters: [{ name: 'ZI-Orkas Project Bundle (.zip)', extensions: ['zip'] }],
  });
  if (pick.canceled || !pick.filePaths[0]) {
    return { ok: false, canceled: true, error: 'Import cancelled.' };
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(pick.filePaths[0]);
  } catch (err) {
    return { ok: false, error: `Invalid ZIP archive: ${(err as Error).message}` };
  }

  const entries = zip.getEntries();
  if (entries.length > MAX_BUNDLE_ENTRIES) {
    return { ok: false, error: 'Bundle has too many entries.' };
  }

  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) {
    return { ok: false, error: 'Not a valid ZI-Orkas project bundle (missing manifest.json).' };
  }
  let manifest: any;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch {
    return { ok: false, error: 'Corrupted manifest.json in project bundle.' };
  }
  if (manifest?.format !== 'zi-orkas-project-bundle' || !manifest?.project) {
    return { ok: false, error: 'Unsupported project bundle format.' };
  }

  // Avoid duplicate name collisions
  const baseName = String(manifest.project.name || 'Imported Project').trim().slice(0, 80) || 'Imported Project';
  const existingNames = new Set((await projects.listProjects(uid)).map((p) => p.name.toLowerCase()));
  let finalName = baseName;
  let suffix = 2;
  while (existingNames.has(finalName.toLowerCase()) && suffix < 100) {
    finalName = `${baseName} (${suffix++})`;
  }

  const created = await projects.createProject(uid, finalName);
  if (!(created as any)?.id && !(created as any)?.project?.id) {
    return { ok: false, error: (created as any)?.error || 'Could not create imported project.' };
  }
  const newPid: string = (created as any).id || (created as any).project.id;

  // Restore instructions & memory
  const instr = String(manifest.project.instructions || '');
  if (instr) {
    try {
      await projects.writeProjectInstructions(uid, newPid, instr);
    } catch {
      fs.writeFileSync(projectInstructionsFile(uid, newPid), instr, 'utf8');
    }
  }
  const mem = String(manifest.project.memory || '');
  if (mem) {
    const memTarget = projectMemoryFile(uid, newPid);
    fs.mkdirSync(path.dirname(memTarget), { recursive: true });
    fs.writeFileSync(memTarget, mem, 'utf8');
  }

  // Restore agent bindings (best-effort for locally present agents)
  const agentIds = Array.isArray(manifest.project.bindings?.agentIds)
    ? manifest.project.bindings.agentIds
    : Array.isArray(manifest.project.bindings?.agents)
      ? manifest.project.bindings.agents
      : [];
  for (const aid of agentIds) {
    if (typeof aid === 'string' && aid) {
      try { await projects.addAgentBinding(uid, newPid, aid); } catch { /* optional */ }
    }
  }

  // Restore to-dos
  let taskCount = 0;
  const rawTasks = Array.isArray(manifest.project.tasks) ? manifest.project.tasks : [];
  for (const item of rawTasks.slice(0, 500)) {
    const content = String(item?.content || item?.title || '').trim();
    if (!content) continue;
    try {
      const taskRes = await projectTasks.createTask(uid, newPid, {
        content: content.slice(0, projectTasks.TASK_CONTENT_MAX),
        ...(item?.title ? { title: String(item.title).slice(0, 200) } : {}),
        ...(item?.description ? { description: String(item.description).slice(0, 3500) } : {}),
        ...(item?.due_at ? { due_at: item.due_at } : {}),
      } as any);
      const tid = (taskRes as any)?.task?.id || (taskRes as any)?.id;
      if (tid && item?.status === 'done') {
        try { await projectTasks.completeTask(uid, newPid, tid); } catch { /* ignore */ }
      }
      taskCount++;
    } catch { /* skip malformed task */ }
  }

  // Restore project library files safely
  const targetFilesDir = path.resolve(projectFilesDir(uid, newPid));
  fs.mkdirSync(targetFilesDir, { recursive: true });
  let fileCount = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const entryName = entry.entryName;
    if (!entryName.startsWith('files/')) continue;
    const rel = entryName.slice('files/'.length);
    if (!isSafeArchiveRelPath(rel)) continue;
    const dest = path.resolve(targetFilesDir, ...rel.split('/'));
    if (!dest.startsWith(targetFilesDir + path.sep)) continue;
    const data = entry.getData();
    if (data.length > MAX_BUNDLE_FILE_BYTES) continue;
    totalBytes += data.length;
    if (totalBytes > MAX_BUNDLE_TOTAL_BYTES) break;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    fileCount++;
  }
  projectFiles.invalidateProjectFileTree(uid, newPid);

  // Touch project root timestamp
  try {
    const now = new Date();
    fs.utimesSync(projectDir(uid, newPid), now, now);
  } catch { /* optional */ }

  log.info('imported project bundle', { projectId: newPid, taskCount, fileCount });
  return { ok: true, projectId: newPid, name: finalName, taskCount, fileCount };
}

// ── Multi-Device Workspace Sync Snapshots (.zi-orkas-sync.zip) ───────────

const SYNC_SECTIONS = Object.freeze([
  'memory',
  'agents',
  'skills',
  'projects',
  'tasks',
  'task_attachments',
  'saved_apps',
  'web_apps',
  'auto_tasks',
  'contexts',
  'chats',
  'chat_artifacts',
  'config',
  'commander',
] as const);

export async function exportWorkspaceSnapshot(
  uid: string,
  sender?: WebContents,
): Promise<{ ok: true; filePath: string; fileCount: number; bytes: number } | { ok: false; canceled?: boolean; error: string }> {
  const stamp = new Date().toISOString().slice(0, 10);
  const saveResult = await dialog.showSaveDialog(ownerWindow(sender) as BrowserWindow, {
    title: 'Export ZI-Orkas Workspace Sync Snapshot',
    defaultPath: path.join(app.getPath('downloads'), `zi-orkas-sync-${stamp}.zip`),
    filters: [{ name: 'ZI-Orkas Sync Snapshot (.zip)', extensions: ['zip'] }],
  });
  if (saveResult.canceled || !saveResult.filePath) {
    return { ok: false, canceled: true, error: 'Export cancelled.' };
  }

  const cloudRoot = userCloudRoot(uid);
  const zip = new AdmZip();
  let totalFiles = 0;
  let totalBytes = 0;

  for (const section of SYNC_SECTIONS) {
    const dir = path.join(cloudRoot, section);
    if (!fs.existsSync(dir)) continue;
    const added = addDirectoryToZip(
      zip,
      dir,
      `cloud/${section}`,
      (_rel, name) => name.startsWith('.kb') || name.endsWith('.lock') || name === 'auth-profiles.json',
    );
    totalFiles += added.files;
    totalBytes += added.bytes;
  }

  const manifest = {
    format: 'zi-orkas-workspace-sync',
    version: 1,
    createdAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    sections: SYNC_SECTIONS,
    fileCount: totalFiles,
    totalBytes,
    sha256Seed: crypto.randomBytes(8).toString('hex'),
  };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  zip.writeZip(saveResult.filePath);

  log.info('exported workspace sync snapshot', { fileCount: totalFiles, totalBytes });
  return { ok: true, filePath: saveResult.filePath, fileCount: totalFiles, bytes: totalBytes };
}

export async function importWorkspaceSnapshot(
  uid: string,
  sender?: WebContents,
): Promise<{ ok: true; restoredFiles: number; backupDir: string } | { ok: false; canceled?: boolean; error: string }> {
  const pick = await dialog.showOpenDialog(ownerWindow(sender) as BrowserWindow, {
    title: 'Import ZI-Orkas Workspace Sync Snapshot',
    properties: ['openFile'],
    filters: [{ name: 'ZI-Orkas Sync Snapshot (.zip)', extensions: ['zip'] }],
  });
  if (pick.canceled || !pick.filePaths[0]) {
    return { ok: false, canceled: true, error: 'Import cancelled.' };
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(pick.filePaths[0]);
  } catch (err) {
    return { ok: false, error: `Invalid ZIP archive: ${(err as Error).message}` };
  }

  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) {
    return { ok: false, error: 'Not a valid ZI-Orkas sync snapshot (missing manifest.json).' };
  }
  let manifest: any;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch {
    return { ok: false, error: 'Corrupted manifest.json in sync snapshot.' };
  }
  if (manifest?.format !== 'zi-orkas-workspace-sync') {
    return { ok: false, error: 'Unsupported sync snapshot format.' };
  }

  const allowedSections = new Set<string>(SYNC_SECTIONS);
  const cloudRoot = path.resolve(userCloudRoot(uid));
  const backupDir = path.join(userLocalRoot(uid), 'sync-backups', `pre-import-${Date.now()}`);
  fs.mkdirSync(backupDir, { recursive: true });

  const entries = zip.getEntries();
  if (entries.length > MAX_BUNDLE_ENTRIES * 2) {
    return { ok: false, error: 'Sync snapshot has too many entries.' };
  }

  let restoredFiles = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!entry.entryName.startsWith('cloud/')) continue;
    const rel = entry.entryName.slice('cloud/'.length);
    if (!isSafeArchiveRelPath(rel)) continue;
    const topSection = rel.split('/')[0];
    if (!allowedSections.has(topSection)) continue;
    if (rel.endsWith('auth-profiles.json')) continue;

    const dest = path.resolve(cloudRoot, ...rel.split('/'));
    if (!dest.startsWith(cloudRoot + path.sep)) continue;

    const data = entry.getData();
    if (data.length > MAX_BUNDLE_FILE_BYTES) continue;
    totalBytes += data.length;
    if (totalBytes > MAX_BUNDLE_TOTAL_BYTES) break;

    if (fs.existsSync(dest) && fs.statSync(dest).isFile()) {
      const bak = path.join(backupDir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(bak), { recursive: true });
      try { fs.copyFileSync(dest, bak); } catch { /* best-effort safety copy */ }
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    restoredFiles++;
  }

  projectFiles.invalidateProjectFileTree(uid);
  log.info('imported workspace sync snapshot', { restoredFiles });
  return { ok: true, restoredFiles, backupDir };
}

// ── Self-Hosted GitHub Release Update Checker ────────────────────────────

function normalizeVersionParts(ver: string): number[] {
  return String(ver || '')
    .trim()
    .replace(/^v/i, '')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((part) => Number(part));
}

function isNewerVersion(candidate: string, current: string): boolean {
  const a = normalizeVersionParts(candidate);
  const b = normalizeVersionParts(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

function selectPlatformAsset(assets: Array<{ name?: string; browser_download_url?: string; size?: number }>): {
  name: string;
  url: string;
  size: number;
} | null {
  const valid = assets.filter((a) => typeof a?.name === 'string' && typeof a?.browser_download_url === 'string') as Array<{
    name: string;
    browser_download_url: string;
    size?: number;
  }>;
  const plat = process.platform;
  const arch = process.arch;

  let match: typeof valid[number] | undefined;
  if (plat === 'darwin') {
    match = valid.find((a) => a.name.endsWith('.dmg') && a.name.includes(arch))
      || valid.find((a) => a.name.endsWith('.zip') && a.name.includes(arch))
      || valid.find((a) => a.name.endsWith('.dmg'));
  } else if (plat === 'win32') {
    match = valid.find((a) => a.name.endsWith('.exe') && (a.name.includes(arch) || !a.name.includes('arm64')))
      || valid.find((a) => a.name.endsWith('.exe'));
  } else if (plat === 'linux') {
    match = valid.find((a) => a.name.endsWith('.AppImage') && (a.name.includes(arch) || a.name.includes('x86_64')))
      || valid.find((a) => a.name.endsWith('.deb') && (a.name.includes(arch) || a.name.includes('amd64')))
      || valid.find((a) => a.name.endsWith('.AppImage') || a.name.endsWith('.deb'));
  }
  if (!match) return null;
  return { name: match.name, url: match.browser_download_url, size: Number(match.size || 0) };
}

export async function checkGitHubUpdates(): Promise<{
  ok: true;
  repo: string;
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  downloadUrl: string;
  assetName: string;
  publishedAt: string;
  notes: string;
} | { ok: false; error: string; repo: string; currentVersion: string; releasesPageUrl: string }> {
  const repo = String(process.env.ZI_ORKAS_UPDATE_REPO || DEFAULT_GITHUB_REPO).trim();
  const currentVersion = app.getVersion();
  const releasesPageUrl = `https://github.com/${repo}/releases`;

  try {
    const res = await fetch(`${GITHUB_API_BASE}/repos/${repo}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ZI-Orkas-Desktop',
      },
    });
    if (res.status === 404) {
      return {
        ok: true,
        repo,
        currentVersion,
        latestVersion: currentVersion,
        hasUpdate: false,
        releaseUrl: releasesPageUrl,
        downloadUrl: releasesPageUrl,
        assetName: '',
        publishedAt: '',
        notes: '',
      };
    }
    if (!res.ok) {
      return { ok: false, error: `GitHub API returned HTTP ${res.status}`, repo, currentVersion, releasesPageUrl };
    }
    const data = (await res.json()) as {
      tag_name?: string;
      name?: string;
      html_url?: string;
      published_at?: string;
      body?: string;
      assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>;
    };
    const latestVersion = String(data.tag_name || currentVersion).replace(/^v/i, '');
    const asset = selectPlatformAsset(Array.isArray(data.assets) ? data.assets : []);
    const releaseUrl = data.html_url || releasesPageUrl;
    return {
      ok: true,
      repo,
      currentVersion,
      latestVersion,
      hasUpdate: isNewerVersion(latestVersion, currentVersion),
      releaseUrl,
      downloadUrl: asset?.url || releaseUrl,
      assetName: asset?.name || '',
      publishedAt: String(data.published_at || ''),
      notes: String(data.body || '').slice(0, 2000),
    };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message || 'Network error while checking GitHub Releases',
      repo,
      currentVersion,
      releasesPageUrl,
    };
  }
}
