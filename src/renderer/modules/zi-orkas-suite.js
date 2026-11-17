/**
 * ZI-Orkas Self-Hosted Suite UI:
 *  - Web App Publishing modal (1-click GitHub Pages live deploy + standalone .zip bundle)
 *  - Project Collaboration modal (export / import portable .zi-orkas-project.zip bundles)
 *  - Multi-Device Workspace Sync Snapshot controls in Settings > Data
 *  - Self-Hosted GitHub Releases update checker in Settings > General
 */
(function () {
  'use strict';

  const STRINGS = {
    ru: {
      close: 'Закрыть',
      cancel: 'Отмена',
      copy: 'Копировать',
      copied: 'Скопировано!',
      openLink: 'Открыть сайт',
      publishTitle: 'Публикация приложения',
      publishSub: 'Опубликуйте приложение по публичной HTTPS-ссылке через GitHub Pages или скачайте автономный ZIP-архив для любого хостинга (Cloudflare Pages, Netlify, Vercel, Nginx).',
      liveLabel: 'Опубликовано онлайн:',
      repoLabel: 'Имя репозитория GitHub Pages',
      tokenLabel: 'GitHub Personal Access Token (права repo)',
      tokenPlaceholderStored: 'Токен сохранён (зашифрован локально) — оставьте пустым или обновите',
      tokenPlaceholderGh: 'Обнаружена авторизация GitHub CLI (gh) — токен не обязателен',
      tokenPlaceholderNew: 'ghp_... или github_pat_...',
      publishBtn: 'Опубликовать на GitHub Pages',
      publishingBtn: 'Публикация...',
      unpublishBtn: 'Снять с публикации',
      exportZipTitle: 'Автономный веб-пакет (.zip)',
      exportZipSub: 'Включает встроенный браузерный SDK (storage, таблицы данных и сохранение файлов).',
      exportZipBtn: 'Скачать .zip пакет',
      exportDone: 'Веб-пакет сохранён: ',
      publishDone: 'Приложение опубликовано! Ссылка GitHub Pages активируется в течение 30–60 секунд:',
      unpublishDone: 'Приложение снято с публикации.',
      collabTitle: 'Совместная работа и обмен проектом',
      collabSub: 'Поделитесь полным пакетом проекта (цели, правила ORKAS.md, память, задачи To-do и файлы библиотеки) с коллегами или перенесите на другое устройство.',
      exportProjBtn: 'Экспортировать проект (.zip)',
      importProjBtn: 'Импортировать проект из .zip',
      exportProjDone: 'Пакет проекта сохранён: ',
      importProjDone: 'Проект успешно импортирован: ',
      syncTitle: 'Синхронизация и резервная копия (ZI-Orkas)',
      syncHint: 'Между устройствами',
      syncRowTitle: 'Снимок рабочего пространства (.zip)',
      syncRowSub: 'Экспорт и импорт агентов, навыков, памяти, проектов, задач, автоматизаций и приложений для синхронизации через Google Drive, iCloud, OneDrive или Syncthing. API-ключи не включаются в архив.',
      syncExportBtn: 'Экспорт',
      syncImportBtn: 'Импорт',
      syncExporting: 'Экспорт...',
      syncImporting: 'Импорт...',
      syncExportDone: 'Снимок сохранён ({files} файлов): {path}',
      syncImportDone: 'Восстановлено файлов: {files}. Перезапустите или обновите раздел для отображения.',
      updateTitle: 'Обновления ZI-Orkas (GitHub Releases)',
      updateSub: 'Текущая версия: {ver} · Проверка свежих сборок в репозитории {repo}.',
      updateBtn: 'Проверить обновления',
      updateChecking: 'Проверка...',
      updateLatest: 'Установлена актуальная версия ({ver}).',
      updateAvailable: 'Доступна новая версия {latest} (у вас {cur}). Скачать установщик?',
      updateDownload: 'Скачать',
      openReleases: 'Релизы GitHub',
      errorPrefix: 'Ошибка: ',
    },
    en: {
      close: 'Close',
      cancel: 'Cancel',
      copy: 'Copy link',
      copied: 'Copied!',
      openLink: 'Open live URL',
      publishTitle: 'Publish & Export Web App',
      publishSub: 'Deploy live to a public HTTPS URL on GitHub Pages in one click, or export a standalone .zip bundle ready for Cloudflare Pages, Netlify, Vercel, or any static host.',
      liveLabel: 'Live URL:',
      repoLabel: 'GitHub Pages repository name',
      tokenLabel: 'GitHub Personal Access Token (repo scope)',
      tokenPlaceholderStored: 'Saved (encrypted on this device) — leave blank or paste to replace',
      tokenPlaceholderGh: 'Local GitHub CLI (gh) auth detected — token optional',
      tokenPlaceholderNew: 'ghp_... or github_pat_...',
      publishBtn: 'Publish to GitHub Pages',
      publishingBtn: 'Publishing...',
      unpublishBtn: 'Unpublish',
      exportZipTitle: 'Standalone Web Bundle (.zip)',
      exportZipSub: 'Includes a self-contained browser runtime shim for storage, data tables, and file save/pick.',
      exportZipBtn: 'Export .zip bundle',
      exportDone: 'Web bundle saved to: ',
      publishDone: 'Published! GitHub Pages typically goes live within 30–60 seconds:',
      unpublishDone: 'App unpublished.',
      collabTitle: 'Share & Collaborate on Project',
      collabSub: 'Export the complete project (goals, ORKAS.md instructions, memory, To-dos, and Library files) as a portable bundle for teammates or other devices, or import a shared bundle.',
      exportProjBtn: 'Export project bundle (.zip)',
      importProjBtn: 'Import shared bundle (.zip)',
      exportProjDone: 'Project bundle saved to: ',
      importProjDone: 'Project imported: ',
      syncTitle: 'Multi-Device Sync & Backup (ZI-Orkas)',
      syncHint: 'Portable snapshot',
      syncRowTitle: 'Workspace sync snapshot (.zip)',
      syncRowSub: 'Export or import custom Agents, Skills, Memory, Projects, To-dos, Automations, and Saved Apps for syncing via Google Drive, iCloud, OneDrive, or Syncthing. API keys stay on this device.',
      syncExportBtn: 'Export',
      syncImportBtn: 'Import',
      syncExporting: 'Exporting...',
      syncImporting: 'Importing...',
      syncExportDone: 'Snapshot exported ({files} files): {path}',
      syncImportDone: 'Restored {files} files. Reload views to see imported items.',
      updateTitle: 'ZI-Orkas Updates (GitHub Releases)',
      updateSub: 'Current version: {ver} · Checks builds from {repo}.',
      updateBtn: 'Check for updates',
      updateChecking: 'Checking...',
      updateLatest: 'You are on the latest version ({ver}).',
      updateAvailable: 'New version {latest} is available (current: {cur}). Download installer?',
      updateDownload: 'Download',
      openReleases: 'GitHub Releases',
      errorPrefix: 'Error: ',
    },
  };

  function isRussian() {
    try {
      const lang = typeof window.getLang === 'function' ? String(window.getLang() || '') : (document.documentElement.lang || '');
      return lang.toLowerCase().startsWith('ru');
    } catch (_) {
      return false;
    }
  }

  function s(key, vars) {
    const dict = isRussian() ? STRINGS.ru : STRINGS.en;
    let out = dict[key] || STRINGS.en[key] || key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        out = out.replaceAll('{' + k + '}', String(v));
      }
    }
    return out;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function openExternalUrl(url) {
    return window.orkas.invoke('auth.openExternal', { url });
  }

  function createModalShell(titleText, subtitleText) {
    const prevFocus = document.activeElement;
    const backdrop = el('div', 'zi-modal-backdrop');
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');

    const card = el('div', 'zi-modal-card');
    const head = el('div', 'zi-modal-head');
    const titleWrap = el('div', 'zi-modal-title-wrap');
    titleWrap.appendChild(el('h3', 'zi-modal-title', titleText));
    if (subtitleText) titleWrap.appendChild(el('p', 'zi-modal-sub', subtitleText));
    const closeBtn = el('button', 'btn btn-sm zi-modal-close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', s('close'));
    head.appendChild(titleWrap);
    head.appendChild(closeBtn);

    const body = el('div', 'zi-modal-body');
    const status = el('div', 'zi-modal-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    card.appendChild(head);
    card.appendChild(body);
    card.appendChild(status);
    backdrop.appendChild(card);

    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') {
        try { prevFocus.focus({ preventScroll: true }); } catch (_) {}
      }
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        close();
      }
    };
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) close();
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(backdrop);

    const setStatus = (msg, isError) => {
      status.textContent = msg || '';
      status.classList.toggle('is-error', Boolean(isError));
    };

    return { backdrop, body, status, setStatus, close };
  }

  async function openAppPublishDialog(appId) {
    if (!appId) {
      const info = await window.orkas.invoke('ziOrkas.info');
      if (info?.releasesUrl) await openExternalUrl(info.releasesUrl);
      return;
    }
    const info = await window.orkas.invoke('ziOrkas.appPublishInfo', { appId });
    if (!info || !info.ok) {
      if (typeof window.uiAlert === 'function') {
        await window.uiAlert(s('errorPrefix') + (info?.error || 'App not found'));
      }
      return;
    }

    const modal = createModalShell(
      s('publishTitle') + ' — ' + info.title,
      s('publishSub'),
    );

    const liveBanner = el('div', 'zi-live-banner');
    const renderLive = (record) => {
      liveBanner.replaceChildren();
      if (!record || !record.url) {
        liveBanner.hidden = true;
        return;
      }
      liveBanner.hidden = false;
      const row = el('div', 'zi-live-row');
      row.appendChild(el('span', 'zi-live-label', s('liveLabel')));
      const link = el('a', 'zi-live-link', record.url);
      link.href = record.url;
      link.addEventListener('click', (ev) => {
        ev.preventDefault();
        void openExternalUrl(record.url);
      });
      row.appendChild(link);
      const actions = el('div', 'zi-inline-actions');
      const copyBtn = el('button', 'btn btn-sm', s('copy'));
      copyBtn.type = 'button';
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(record.url);
          copyBtn.textContent = s('copied');
          setTimeout(() => { copyBtn.textContent = s('copy'); }, 1500);
        } catch (_) {}
      });
      const openBtn = el('button', 'btn btn-sm', s('openLink'));
      openBtn.type = 'button';
      openBtn.addEventListener('click', () => void openExternalUrl(record.url));
      const unpubBtn = el('button', 'btn btn-sm', s('unpublishBtn'));
      unpubBtn.type = 'button';
      unpubBtn.addEventListener('click', async () => {
        unpubBtn.disabled = true;
        const r = await window.orkas.invoke('ziOrkas.unpublishApp', { appId });
        unpubBtn.disabled = false;
        if (r?.ok) {
          renderLive(null);
          modal.setStatus(s('unpublishDone'), false);
        } else {
          modal.setStatus(s('errorPrefix') + (r?.error || 'failed'), true);
        }
      });
      actions.append(copyBtn, openBtn, unpubBtn);
      liveBanner.append(row, actions);
    };
    renderLive(info.record);
    modal.body.appendChild(liveBanner);

    // GitHub Pages box
    const ghBox = el('div', 'zi-modal-section');
    const repoField = el('label', 'zi-field');
    repoField.appendChild(el('span', 'zi-field-label', s('repoLabel')));
    const repoInput = el('input', 'zi-input');
    repoInput.type = 'text';
    repoInput.value = info.suggestedRepo || '';
    repoField.appendChild(repoInput);

    const tokenField = el('label', 'zi-field');
    tokenField.appendChild(el('span', 'zi-field-label', s('tokenLabel')));
    const tokenInput = el('input', 'zi-input');
    tokenInput.type = 'password';
    tokenInput.autocomplete = 'off';
    tokenInput.placeholder = info.auth?.hasStoredToken
      ? s('tokenPlaceholderStored')
      : info.auth?.hasGhCliToken
        ? s('tokenPlaceholderGh')
        : s('tokenPlaceholderNew');
    tokenField.appendChild(tokenInput);

    const publishBtn = el('button', 'btn btn-primary btn-sm', s('publishBtn'));
    publishBtn.type = 'button';
    publishBtn.addEventListener('click', async () => {
      publishBtn.disabled = true;
      publishBtn.textContent = s('publishingBtn');
      modal.setStatus('', false);
      try {
        const res = await window.orkas.invoke('ziOrkas.publishAppGitHubPages', {
          appId,
          repoName: repoInput.value.trim(),
          githubToken: tokenInput.value.trim() || undefined,
          saveToken: true,
        });
        if (res && res.ok) {
          tokenInput.value = '';
          tokenInput.placeholder = s('tokenPlaceholderStored');
          renderLive(res);
          modal.setStatus(s('publishDone') + ' ' + res.url, false);
        } else {
          modal.setStatus(s('errorPrefix') + (res?.error || 'Publish failed'), true);
        }
      } catch (err) {
        modal.setStatus(s('errorPrefix') + (err?.message || String(err)), true);
      } finally {
        publishBtn.disabled = false;
        publishBtn.textContent = s('publishBtn');
      }
    });

    ghBox.append(repoField, tokenField, publishBtn);
    modal.body.appendChild(ghBox);

    // ZIP Export box
    const zipBox = el('div', 'zi-modal-section zi-modal-section-row');
    const zipCopy = el('div', 'zi-modal-section-copy');
    zipCopy.appendChild(el('div', 'settings-row-title', s('exportZipTitle')));
    zipCopy.appendChild(el('div', 'settings-row-desc', s('exportZipSub')));
    const zipBtn = el('button', 'btn btn-sm', s('exportZipBtn'));
    zipBtn.type = 'button';
    zipBtn.addEventListener('click', async () => {
      zipBtn.disabled = true;
      try {
        const res = await window.orkas.invoke('ziOrkas.exportAppZip', { appId });
        if (res?.ok) {
          modal.setStatus(s('exportDone') + res.filePath, false);
        } else if (!res?.canceled) {
          modal.setStatus(s('errorPrefix') + (res?.error || 'Export failed'), true);
        }
      } finally {
        zipBtn.disabled = false;
      }
    });
    zipBox.append(zipCopy, zipBtn);
    modal.body.appendChild(zipBox);
  }

  async function openProjectCollaborationDialog(projectId) {
    const modal = createModalShell(s('collabTitle'), s('collabSub'));
    const actions = el('div', 'zi-inline-actions');

    if (projectId) {
      const exportBtn = el('button', 'btn btn-primary btn-sm', s('exportProjBtn'));
      exportBtn.type = 'button';
      exportBtn.addEventListener('click', async () => {
        exportBtn.disabled = true;
        modal.setStatus('', false);
        try {
          const res = await window.orkas.invoke('ziOrkas.exportProjectBundle', { projectId });
          if (res?.ok) {
            modal.setStatus(s('exportProjDone') + res.filePath, false);
          } else if (!res?.canceled) {
            modal.setStatus(s('errorPrefix') + (res?.error || 'Export failed'), true);
          }
        } finally {
          exportBtn.disabled = false;
        }
      });
      actions.appendChild(exportBtn);
    }

    const importBtn = el('button', 'btn btn-sm', s('importProjBtn'));
    importBtn.type = 'button';
    importBtn.addEventListener('click', async () => {
      importBtn.disabled = true;
      modal.setStatus('', false);
      try {
        const res = await window.orkas.invoke('ziOrkas.importProjectBundle', {});
        if (res?.ok) {
          modal.setStatus(s('importProjDone') + res.name, false);
          if (typeof window.loadProjects === 'function') {
            try { await window.loadProjects(); } catch (_) {}
          }
          if (typeof window.renderProjectsSection === 'function') {
            try { window.renderProjectsSection(); } catch (_) {}
          }
        } else if (!res?.canceled) {
          modal.setStatus(s('errorPrefix') + (res?.error || 'Import failed'), true);
        }
      } finally {
        importBtn.disabled = false;
      }
    });
    actions.appendChild(importBtn);
    modal.body.appendChild(actions);
  }

  let cachedInfo = { version: '', repo: 'zigorminsk-debug/ZI-orkas', releasesUrl: 'https://github.com/zigorminsk-debug/ZI-orkas/releases' };

  function mountSettingsEnhancements() {
    // 1. Settings > Data: Multi-Device Sync Snapshot
    const localSection = document.getElementById('settings-section-local');
    if (localSection && !document.getElementById('settings-section-zi-sync')) {
      const sec = el('section', 'settings-section');
      sec.id = 'settings-section-zi-sync';

      const head = el('div', 'settings-section-title');
      const h2 = el('h2', '', s('syncTitle'));
      const hint = el('span', 'settings-section-hint', s('syncHint'));
      head.append(h2, hint);

      const sheet = el('div', 'settings-sheet');
      const row = el('div', 'settings-row');
      const copy = el('div', 'settings-row-copy');
      const rowTitle = el('div', 'settings-row-title', s('syncRowTitle'));
      const rowDesc = el('div', 'settings-row-desc', s('syncRowSub'));
      const rowStatus = el('span', 'settings-status muted');
      copy.append(rowTitle, rowDesc, rowStatus);

      const btns = el('div', 'zi-inline-actions');
      const expBtn = el('button', 'btn btn-sm', s('syncExportBtn'));
      expBtn.type = 'button';
      const impBtn = el('button', 'btn btn-sm', s('syncImportBtn'));
      impBtn.type = 'button';

      expBtn.addEventListener('click', async () => {
        expBtn.disabled = true;
        expBtn.textContent = s('syncExporting');
        try {
          const r = await window.orkas.invoke('ziOrkas.exportWorkspaceSnapshot', {});
          if (r?.ok) {
            rowStatus.textContent = s('syncExportDone', { files: r.fileCount, path: r.filePath });
          } else if (!r?.canceled) {
            rowStatus.textContent = s('errorPrefix') + (r?.error || 'Export failed');
          }
        } finally {
          expBtn.disabled = false;
          expBtn.textContent = s('syncExportBtn');
        }
      });

      impBtn.addEventListener('click', async () => {
        impBtn.disabled = true;
        impBtn.textContent = s('syncImporting');
        try {
          const r = await window.orkas.invoke('ziOrkas.importWorkspaceSnapshot', {});
          if (r?.ok) {
            rowStatus.textContent = s('syncImportDone', { files: r.restoredFiles });
            if (typeof window.loadProjects === 'function') {
              try { await window.loadProjects(); } catch (_) {}
            }
          } else if (!r?.canceled) {
            rowStatus.textContent = s('errorPrefix') + (r?.error || 'Import failed');
          }
        } finally {
          impBtn.disabled = false;
          impBtn.textContent = s('syncImportBtn');
        }
      });

      btns.append(expBtn, impBtn);
      row.append(copy, btns);
      sheet.appendChild(row);
      sec.append(head, sheet);
      localSection.insertAdjacentElement('afterend', sec);

      sec._refreshLang = () => {
        h2.textContent = s('syncTitle');
        hint.textContent = s('syncHint');
        rowTitle.textContent = s('syncRowTitle');
        rowDesc.textContent = s('syncRowSub');
        expBtn.textContent = s('syncExportBtn');
        impBtn.textContent = s('syncImportBtn');
      };
    }

    // 2. Settings > General: GitHub Releases Updater
    const langRow = document.getElementById('settings-language-row');
    const prefSheet = langRow && langRow.closest('.settings-sheet');
    if (prefSheet && !document.getElementById('settings-zi-update-row')) {
      const row = el('div', 'settings-row');
      row.id = 'settings-zi-update-row';
      const copy = el('div', 'settings-row-copy');
      const title = el('div', 'settings-row-title', s('updateTitle'));
      const desc = el('div', 'settings-row-desc', s('updateSub', { ver: cachedInfo.version || '—', repo: cachedInfo.repo }));
      const status = el('span', 'settings-status muted');
      copy.append(title, desc, status);

      const btns = el('div', 'zi-inline-actions');
      const checkBtn = el('button', 'btn btn-sm', s('updateBtn'));
      checkBtn.type = 'button';
      const relBtn = el('button', 'btn btn-sm', s('openReleases'));
      relBtn.type = 'button';

      checkBtn.addEventListener('click', async () => {
        checkBtn.disabled = true;
        checkBtn.textContent = s('updateChecking');
        status.textContent = '';
        try {
          const r = await window.orkas.invoke('ziOrkas.checkUpdates', {});
          if (!r?.ok) {
            status.textContent = s('errorPrefix') + (r?.error || 'Check failed');
          } else if (!r.hasUpdate) {
            status.textContent = s('updateLatest', { ver: r.currentVersion });
          } else if (typeof window.uiConfirm === 'function') {
            const ok = await window.uiConfirm({
              message: s('updateAvailable', { latest: r.latestVersion, cur: r.currentVersion }),
              okLabel: s('updateDownload'),
              cancelLabel: s('cancel'),
            });
            if (ok) await openExternalUrl(r.downloadUrl || r.releaseUrl);
          } else {
            await openExternalUrl(r.downloadUrl || r.releaseUrl);
          }
        } finally {
          checkBtn.disabled = false;
          checkBtn.textContent = s('updateBtn');
        }
      });

      relBtn.addEventListener('click', () => void openExternalUrl(cachedInfo.releasesUrl));

      btns.append(checkBtn, relBtn);
      row.append(copy, btns);
      prefSheet.appendChild(row);

      row._refreshLang = () => {
        title.textContent = s('updateTitle');
        desc.textContent = s('updateSub', { ver: cachedInfo.version || '—', repo: cachedInfo.repo });
        checkBtn.textContent = s('updateBtn');
        relBtn.textContent = s('openReleases');
      };
    }
  }

  async function init() {
    try {
      const res = await window.orkas.invoke('ziOrkas.info', {});
      if (res?.ok) {
        cachedInfo = {
          version: res.version || '',
          repo: res.repo || cachedInfo.repo,
          releasesUrl: res.releasesUrl || cachedInfo.releasesUrl,
        };
      }
    } catch (_) {}
    mountSettingsEnhancements();
    const upd = document.getElementById('settings-zi-update-row');
    if (upd && typeof upd._refreshLang === 'function') upd._refreshLang();
  }

  window.addEventListener('i18n-change', () => {
    const syncSec = document.getElementById('settings-section-zi-sync');
    if (syncSec && typeof syncSec._refreshLang === 'function') syncSec._refreshLang();
    const updRow = document.getElementById('settings-zi-update-row');
    if (updRow && typeof updRow._refreshLang === 'function') updRow._refreshLang();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void init());
  } else {
    void init();
  }

  window.ZIOrkasSuite = Object.freeze({
    openAppPublishDialog,
    openProjectCollaborationDialog,
  });
})();
