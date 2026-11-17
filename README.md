# ZI-Orkas — Полнофункциональная локальная мультиагентная AI-команда

[![Build & Release ZI-Orkas](https://github.com/zigorminsk-debug/ZI-orkas/actions/workflows/build-release.yml/badge.svg)](https://github.com/zigorminsk-debug/ZI-orkas/actions/workflows/build-release.yml)
[![CI](https://github.com/zigorminsk-debug/ZI-orkas/actions/workflows/ci.yml/badge.svg)](https://github.com/zigorminsk-debug/ZI-orkas/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**ZI-Orkas** — самостоятельное десктопное приложение для **Windows**, **macOS (Apple Silicon и Intel)** и **Linux**, реализующее **100% функциональности [Orkas](https://orkas.ai/)** (на базе MIT-ядра `v2026.11.16`) без обязательной регистрации, плюс встроенный **Self-Hosted Suite** (публикация веб-приложений в 1 клик на GitHub Pages и автономный `.zip`-экспорт, совместная работа над проектами через `.zi-orkas-project.zip`, кросс-устройственная синхронизация рабочего пространства через зашифруемые снапшоты и проверка обновлений через GitHub Releases).

Все инсталляторы собираются и проходят автоматическую smoke-проверку запуска (Electron + IPC + SQLite + `sqlite-vec` + локальная ONNX-векторная база знаний BGE) в облаке **GitHub Actions**.

---

## Содержание

- [Скачать готовые сборки](#скачать-готовые-сборки)
- [Полный список возможностей (100% Orkas + Self-Hosted Suite)](#полный-список-возможностей-100-orkas--self-hosted-suite)
- [Сборка в GitHub Actions и выпуск релизов](#сборка-в-github-actions-и-выпуск-релизов)
- [Локальный запуск из исходников](#локальный-запуск-из-исходников)
- [Архитектура репозитория](#архитектура-репозитория)
- [English Summary](#english-summary)
- [Лицензия](#лицензия)

---

## Скачать готовые сборки

Готовые установщики доступны в разделах **[Releases](https://github.com/zigorminsk-debug/ZI-orkas/releases)** и **[Actions -> Build & Release ZI-Orkas](https://github.com/zigorminsk-debug/ZI-orkas/actions/workflows/build-release.yml)** (артефакты каждого прогона + `SHA256SUMS.txt`):

| Платформа | Архитектура | Файлы установщиков |
| --- | --- | --- |
| **Windows 10 / 11** | `x64` | `ZI-Orkas-Setup-<version>-win-x64.exe` (NSIS-установщик с встроенным VC++ Runtime) |
| **macOS 13+** | `arm64` (Apple Silicon M1–M4) | `ZI-Orkas-<version>-mac-arm64.dmg`, `ZI-Orkas-<version>-mac-arm64.zip` |
| **macOS 13+** | `x64` (Intel) | `ZI-Orkas-<version>-mac-x64.dmg`, `ZI-Orkas-<version>-mac-x64.zip` |
| **Linux** (Ubuntu 22.04+, glibc >= 2.34) | `x64` | `ZI-Orkas-<version>-linux-x64.AppImage`, `ZI-Orkas-<version>-linux-x64.deb` |

> **Первый запуск на macOS (ad-hoc подпись с entitlements):**
> ```bash
> xattr -dr com.apple.quarantine /Applications/ZI-Orkas.app
> ```

---

## Полный список возможностей (100% Orkas + Self-Hosted Suite)

### 1. Мультиагентное ядро и 16 специализированных агентов
- **Commander** — главный оркестратор, планирующий задачи, распределяющий их между профильными агентами и ведущий групповые чаты с `@упоминаниями`.
- **Аналитика и ресёрч**: `DeepResearcher`, `SeoGeoAgent`, `StockAnalyser`.
- **Контент и дизайн**: `ContentWriter`, `PptMaker`, `ImageStudio`, `VideoStudio`, `VoiceStudio`, `UIDesigner`.
- **Разработка и офис**: `ProductDeveloper`, `OfficeWorker` (DOCX / XLSX / PPTX / PDF через встроенный `OfficeCLI v1.0.142` и локальный рендерер).
- **E-Commerce команда**: `ECommerceResearcher`, `ECommerceWriter`, `ECommerceReviewer`, `ECommerceAnalyzer`, `ECommerceOperator`.
- **Встроенный Marketplace**: 5 системных навыков, 15 готовых агентов, 24 навыка и 2 встроенных приложения + создание и кастомизация собственных агентов и `SKILL.md`-навыков.

### 2. Подключение локальных CLI-агентов
Нативная оркестрация локально установленных CLI-агентов прямо в проектах и групповых чатах:
- **Claude Code** (`claude`), **Codex** (`codex`), **OpenCode** (`opencode`), **OpenClaw** (`openclaw`), **Hermes** (`hermes`).

### 3. Проекты, задачи, Auto-Advance и планировщик автоматизаций
- **Projects & To-dos** — рабочие пространства с собственными инструкциями, файлами, библиотекой контекста, канбан/списком задач и режимом **Auto** (автоматическое продвижение задач командой агентов).
- **Scheduled Automations** — регулярные задачи по расписанию (cron/интервалы) с фоновым запуском, историей выполнений и системными уведомлениями в трее.

### 4. Локальная база знаний (RAG), долговременная память и медиа-движки
- **Knowledge Base** — гибридный семантический поиск на базе `better-sqlite3` + `sqlite-vec` + офлайн ONNX-модели `fast-bge-small-zh-v1.5` (`onnxruntime-node` + `@anush008/tokenizers`).
- **Memory & Reflection** — долговременная память пользователя/проекта (`MEMORY.md`, `USER.md`) с фоновой рефлексией и корзиной восстановления (Recycle Bin).
- **Встроенные локальные рантаймы**: изолированные `Node.js`, `Python`, `uv`, `FFmpeg`/`FFprobe`, `Whisper` (`ggml-base-q5_1` для голосового ввода и транскрибации видео), `LibRaw 0.22.3` (RAW-фото на Windows/macOS), `Sharp`/`libvips`, `ag-psd` (PSD), `xlrd` (XLS), `OfficeCLI`.

### 5. Web Assist Browser, коннекторы и Web Apps SDK
- **Web Assist** — встроенный управляемый браузер для агентов с изоляцией сессий и поддержкой аппаратных/телефонных passkeys (`caBLE` helper на macOS, нативный WebAuthn на Windows).
- **30+ коннекторов** — MCP-серверы, OAuth-интеграции, мессенджеры, облачные сервисы и e-commerce площадки.
- **Local Web Apps & SDK** — генерация, предпросмотр, редактирование, ревизии и сохранение интерактивных веб-приложений с `window.orkasApp` SDK.
- **BYO-провайдеры моделей (без привязки к аккаунту)** — OpenAI, Anthropic, Google Gemini, DeepSeek, Qwen, xAI, OpenRouter, Ollama, LM Studio, любые OpenAI/Anthropic-совместимые эндпоинты, OAuth-профили и `orkas-api` с собственным ключом.
- **19 языков интерфейса**, включая полноценный **русский (`ru`)** и **английский (`en`)**.

### 6. ZI-Orkas Self-Hosted Suite (замена облачных функций без подписки)
Все функции, которые в официальном релизе Orkas привязаны к проприетарному облаку, в **ZI-Orkas** реализованы автономно (`src/main/features/zi_orkas_suite.ts`, `src/renderer/modules/zi-orkas-suite.js`):
1. **Публикация веб-приложений в 1 клик на GitHub Pages** — создаёт/обновляет публичный репозиторий через GitHub Git Data API, включает GitHub Pages и выдаёт прямую публичную ссылку `https://<user>.github.io/<repo>/`. Токен шифруется локально через OS keychain (`safeStorage`) или подхватывается из `gh auth token`.
2. **Автономный `.zip`-экспорт веб-приложений** — упаковывает приложение вместе с браузерным `localStorage`-шимом `window.orkasApp` для размещения на любом хостинге (Cloudflare Pages, Netlify, Vercel, Nginx, S3) или открытия офлайн.
3. **Совместная работа над проектами (`.zi-orkas-project.zip`)** — полный экспорт и импорт проектов со всеми инструкциями, файлами, задачами и контекстом прямо из меню проекта (*Пригласить участников / Совместный доступ*).
4. **Синхронизация рабочего пространства между устройствами** (*Настройки -> Данные*) — экспорт и безопасный импорт снапшотов (агенты, навыки, память, проекты, задачи, сохранённые приложения, автоматизации, чаты и настройки) с автоматическим созданием резервной копии перед восстановлением (исключая секретные ключи `auth-profiles.json`).
5. **Проверка обновлений через GitHub Releases** (*Настройки -> Общие*) — сравнивает текущую версию приложения со свежим релизом `zigorminsk-debug/ZI-orkas` и предлагает установщик под текущую ОС и архитектуру.

---

## Сборка в GitHub Actions и выпуск релизов

В репозитории настроены три workflow в `.github/workflows/`:

1. **`build-release.yml` (`Build & Release ZI-Orkas`)** — полная кроссплатформенная сборка для 4 платформ (`win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64`):
   - Запускается автоматически при `push` в `main`, при пуше тега `v*` (например, `git tag v2026.11.16 && git push origin v2026.11.16`), а также вручную через **Actions -> Build & Release ZI-Orkas -> Run workflow**.
   - Для публикации готового релиза на странице **Releases** вручную: откройте workflow, нажмите **Run workflow** и включите флажок `publish_release = true` (при необходимости укажите `release_tag`).
   - На каждой платформе выполняются строгие проверки контрактов нативных модулей (`native-package-gate`), графа зависимостей (`packaged-dependency-gate`), ресурсов (`packaged-resource-gate`), политики безопасности `OfficeCLI` и реальный smoke-запуск собранного бинарника с тестом векторной БД.
   - В финальном шаге формируется единый файл контрольных сумм `SHA256SUMS.txt`.
2. **`ci.yml` (`CI`)** — быстрая проверка TypeScript (`main` + `core-agent`), контракта Web App SDK, манифеста встроенных ресурсов, синтаксиса модулей и кроссплатформенных гейтов при каждом пуше и Pull Request.
3. **`sync-upstream.yml` (`Check Upstream Orkas Release`)** — ручная проверка выхода новых версий в апстрим-репозитории `Orkas-AI/Orkas` с отчётом в Summary.

---

## Локальный запуск из исходников

Требования: **Node.js >= 22.12.0** (рекомендуется Node.js 24 LTS) и **npm >= 10**.

```bash
git clone https://github.com/zigorminsk-debug/ZI-orkas.git
cd ZI-orkas
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci
npm run runtime:prepare:dev
npm start
```

Проверка типов и контрактов:

```bash
npm run typecheck
npm run web-app-sdk:check
npm run builtin:manifest:check
npm run officecli:policy-check
```

---

## Архитектура репозитория

```text
├── bootstrap.cjs                 # Загрузчик Electron + tsx для main-процесса
├── bin/                          # Контрактные гейты сборки, рантаймов и коннекторов
├── scripts/                      # Подготовка нативных модулей (Win/macOS/Linux), FFmpeg, Whisper, LibRaw, OfficeCLI, codesign
├── product/signing/              # macOS entitlements (JIT, микрофон, дочерние рантаймы)
├── resources/
│   ├── builtin/                  # 16 встроенных агентов, системные навыки, каталог Marketplace и встроенные приложения
│   ├── connectors/               # Адаптеры и схемы коннекторов
│   ├── mac-locales/              # Локализованные InfoPlist.strings (19 языков)
│   └── xls-reader/               # Офлайн-ридер таблиц XLS
├── src/
│   ├── core-agent/               # Ядро агентного цикла, инструментов и сессий процессов
│   ├── main/                     # Electron main-процесс, IPC, RAG/KB, память, браузер, OfficeCLI
│   │   ├── features/zi_orkas_suite.ts  # Self-hosted GitHub Pages, ZIP-экспорт, проектные бандлы, синк и апдейтер
│   │   └── ipc/zi_orkas.ts             # IPC-каналы ziOrkas.*
│   ├── renderer/                 # UI приложения, 19 локалей (включая ru.json), редактор/хост веб-приложений
│   │   └── modules/zi-orkas-suite.js   # Модальные окна публикации, коллаборации, синхронизации и обновлений
│   └── resources/                # Иконки приложения (.ico, .icns, .png) и ассеты
├── vendor/                       # SHA-256 контракты и лицензии Whisper, LibRaw, OpenBLAS, VC Runtime
└── .github/workflows/            # GitHub Actions: CI, кроссплатформенный Build & Release, проверка апстрима
```

---

## English Summary

**ZI-Orkas** is a full-featured, local-first multi-agent desktop application for **Windows x64**, **macOS (Apple Silicon & Intel)**, and **Linux x64**, built on the MIT-licensed [Orkas](https://github.com/Orkas-AI/Orkas) codebase (`v2026.11.16`) with zero login walls plus a built-in **Self-Hosted Suite**:

- **100% Orkas desktop feature parity**: Commander + all 16 specialist agents, built-in Marketplace, local CLI agent backends (`claude`, `codex`, `opencode`, `openclaw`, `hermes`), Projects with To-dos & Auto-advance, Scheduled Automations, 30+ MCP/OAuth/commerce connectors, hybrid SQLite + `sqlite-vec` + offline BGE ONNX Knowledge Base, long-term Memory & Reflection, Web Assist browser with passkey support, OfficeCLI document engine, bundled FFmpeg/Whisper/LibRaw runtimes, BYO model keys, and 19 UI languages (including Russian and English).
- **Self-Hosted Suite**: 1-click Web App deployment to GitHub Pages, standalone `.zip` Web App export with a browser `localStorage` SDK shim, portable `.zi-orkas-project.zip` collaboration bundles, cross-device workspace sync snapshots with automatic backups, and GitHub Releases update checks.
- **Automated GitHub Actions builds**: `.github/workflows/build-release.yml` builds, verifies, smoke-tests, and packages Windows `.exe`, macOS `arm64`/`x64` `.dmg` & `.zip`, and Linux `x64` `.AppImage` & `.deb` installers along with `SHA256SUMS.txt`.

---

## Лицензия

Распространяется по лицензии **[MIT](./LICENSE)**. Основано на открытом проекте [Orkas-AI/Orkas](https://github.com/Orkas-AI/Orkas) (Copyright (c) Orkas Contributors, MIT License).
