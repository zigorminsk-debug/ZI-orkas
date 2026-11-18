/**
 * IPC handlers for ZI-Orkas self-hosted publishing, project collaboration,
 * multi-device workspace sync snapshots, and GitHub Releases updates.
 */
import { app, type WebContents } from 'electron';
import * as ziSuite from '../features/zi_orkas_suite';

type IpcCtx = { userId: string; sender: WebContents };

export const invokeHandlers = {
  'ziOrkas.info': async () => ({
    ok: true,
    edition: 'ZI-Orkas',
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    repo: ziSuite.DEFAULT_GITHUB_REPO,
    releasesUrl: `https://github.com/${ziSuite.DEFAULT_GITHUB_REPO}/releases`,
  }),
  'ziOrkas.appPublishInfo': async (payload: any, ctx: IpcCtx) =>
    ziSuite.getAppPublishInfo(ctx.userId, String(payload?.appId || '')),
  'ziOrkas.publishedApps': async (_payload: any, ctx: IpcCtx) => ({
    published: ziSuite.listPublishedApps(ctx.userId),
  }),
  'ziOrkas.saveGitHubToken': async (payload: any, ctx: IpcCtx) =>
    ziSuite.saveGitHubToken(ctx.userId, String(payload?.token || '')),
  'ziOrkas.exportAppZip': async (payload: any, ctx: IpcCtx) =>
    ziSuite.exportSavedAppZip(ctx.userId, String(payload?.appId || ''), ctx.sender),
  'ziOrkas.publishAppGitHubPages': async (payload: any, ctx: IpcCtx) =>
    ziSuite.publishSavedAppToGitHubPages(ctx.userId, {
      appId: String(payload?.appId || ''),
      repoName: payload?.repoName ? String(payload.repoName) : undefined,
      githubToken: payload?.githubToken ? String(payload.githubToken) : undefined,
      saveToken: payload?.saveToken !== false,
    }),
  'ziOrkas.unpublishApp': async (payload: any, ctx: IpcCtx) =>
    ziSuite.unpublishSavedApp(ctx.userId, String(payload?.appId || '')),
  'ziOrkas.exportProjectBundle': async (payload: any, ctx: IpcCtx) =>
    ziSuite.exportProjectBundle(ctx.userId, String(payload?.projectId || ''), ctx.sender),
  'ziOrkas.importProjectBundle': async (_payload: any, ctx: IpcCtx) =>
    ziSuite.importProjectBundle(ctx.userId, ctx.sender),
  'ziOrkas.exportWorkspaceSnapshot': async (_payload: any, ctx: IpcCtx) =>
    ziSuite.exportWorkspaceSnapshot(ctx.userId, ctx.sender),
  'ziOrkas.importWorkspaceSnapshot': async (_payload: any, ctx: IpcCtx) =>
    ziSuite.importWorkspaceSnapshot(ctx.userId, ctx.sender),
  'ziOrkas.checkUpdates': async () => ziSuite.checkGitHubUpdates(),
};
