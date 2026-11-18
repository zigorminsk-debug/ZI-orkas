# Аудит авторизации коннекторов ZI-Orkas — 18 ноября 2026

## Область и ограничения

Проверены локальный каталог (197 записей), маршрутизация и исходный код запуска и завершения авторизации. Список ниже — снимок исходного каталога на момент проверки, без возможных записей удалённой конфигурации и без учёта динамических выключателей Google. 129 записей Composio/платных отфильтрованы функцией `connectorCatalog`; остальные 68 проходят этот фильтр, но отдельная карточка ещё может быть скрыта динамическими настройками. Это **статический аудит**, а не успешные реальные входы. Без аккаунтов поставщиков, зарегистрированных OAuth-приложений, их разрешений и работающей инфраструктуры нельзя подтвердить конечную работоспособность каждого сервиса. Запросы на сторонние сайты в этой среде ограничены; онлайн-доступность и политики поставщиков не проверялись. GitHub проверен тестом с имитацией ответов, не реальным входом.

## Основные неисправности

1. **Серверный OAuth (8 записей):** `apiBase()` в `src/main/features/marketplace.ts` по умолчанию пуст; `startOAuth` в `oauth.ts` создаёт URL из этого значения. Без настроенного реального сервера авторизации корректный абсолютный URL не формируется. Slack, Google Workspace и его отдельные сервисы, Bing Webmaster не могут надёжно запустить этот поток. Комментарий о глобальном production-сервере в коде не соответствует текущему значению. E2E-переменные — только тестовый путь, не готовый сервер для обычного пользователя.
2. **MCP OAuth/DCR (16 записей):** обнаружение поставщика и динамическая регистрация есть, но redirect URI и обмен кодом зависят от `accountApiBase()` и серверных endpoint `dcr-callback`/`dcr-exchange`. При пустом base формируется относительный callback, а работающего relay в данном репозитории нет. Это касается и пользовательских MCP OAuth-серверов. Поддержка регистрации и самого MCP у конкретных сервисов не проверена.
3. **Merchant OAuth (16 записей):** у Shopee, TikTok Shop и 14 провайдеров из `BROWSER_OAUTH_PROVIDERS` для обычной конфигурации указан `http://127.0.0.1/oauth/callback`, но локальный слушатель не запускается. Обработчик ожидает `exchange_code` от внешнего relay; `ZI_ORKAS_OAUTH_RELAY_BASE` по умолчанию пуст. Поэтому завершение входа по умолчанию не обеспечено. Поставщик дополнительно может потребовать зарегистрированный HTTPS callback, собственное приложение или одобрение.
4. **WooCommerce:** при предоставлении собственных API-ключей используется другой путь, но вход через страницу магазина зависит от отдельного relay, производного от того же локального адреса, для которого в приложении нет обработчика. Установка переменной сама по себе не создаёт relay и не подтверждает безопасность или совместимость.
5. **Composio (129 записей):** сейчас скрыты `connectorCatalog()`; даже при снятии фильтра этот режим зависит от серверного сервиса и его конфигурации. Восстанавливать показ без реальной инфраструктуры нельзя.

Другие `local_api` используют учётные данные или, для Constant Contact, Device Flow; `local_cli` — CLI. Нельзя безопасно предположить, что любой из них должен перенаправлять на страницу входа: способы входа определяет поставщик. Наличие реализации не означает, что учётные данные, разрешения, сетевые запросы, сохранение или восстановление соединения проверены в реальной среде.

## Что нужно для исправления

- Выбрать и развернуть собственный HTTPS OAuth/relay backend с проверкой state, одноразовыми короткоживущими кодами, привязкой к устройству и безопасным завершением в приложении, либо реализовать отдельный loopback/PKCE-поток только для поставщиков, которые его допускают. Нельзя просто подставить произвольный URL: callback должен совпадать с регистрацией у поставщика, а не все поддерживают localhost или динамическую регистрацию.
- Для server-bridge потребуются собственные OAuth-приложения и секреты на backend, согласия и при необходимости верификация у поставщиков. Для DCR — совместимая инфраструктура callback и проверка возможностей каждого поставщика. Для merchant-потоков и WooCommerce — подходящие callbacks и интеграционные контракты.
- Для каждого коннектора провести изолированный тест с тестовым аккаунтом: старт, открытие официальной страницы, согласие, возврат, обмен, проверка доступа, перезапуск, обновление токена, отказ и отмена. Секреты и одноразовые коды не записывать в отчёты.

## Перечень каталога

Статус описывает выявленный путь, а не гарантию работы.

| Коннектор (ID) | Тип | Результат статической проверки |
|---|---|---|
| Google Drive (gdrive) | composio | Скрыт фильтром каталога; не проверялся |
| Outlook (outlook) | composio | Скрыт фильтром каталога; не проверялся |
| Microsoft 365 Mail (m365-mail) | composio | Скрыт фильтром каталога; не проверялся |
| Microsoft 365 Calendar (m365-calendar) | composio | Скрыт фильтром каталога; не проверялся |
| OneDrive (onedrive) | composio | Скрыт фильтром каталога; не проверялся |
| BaseLinker (baselinker) | composio | Скрыт фильтром каталога; не проверялся |
| Order Desk (order-desk) | composio | Скрыт фильтром каталога; не проверялся |
| Printify (printify) | composio | Скрыт фильтром каталога; не проверялся |
| ShipEngine (shipengine) | composio | Скрыт фильтром каталога; не проверялся |
| Shippo (shippo) | composio | Скрыт фильтром каталога; не проверялся |
| Gorgias (gorgias) | composio | Скрыт фильтром каталога; не проверялся |
| Gumroad (gumroad) | composio | Скрыт фильтром каталога; не проверялся |
| Lemon Squeezy (lemon-squeezy) | composio | Скрыт фильтром каталога; не проверялся |
| Loyverse (loyverse) | composio | Скрыт фильтром каталога; не проверялся |
| Gelato (gelato) | composio | Скрыт фильтром каталога; не проверялся |
| Gift Up (gift-up) | composio | Скрыт фильтром каталога; не проверялся |
| Goody (goody) | composio | Скрыт фильтром каталога; не проверялся |
| Starshipit (starshipit) | composio | Скрыт фильтром каталога; не проверялся |
| FraudLabs Pro (fraudlabs-pro) | composio | Скрыт фильтром каталога; не проверялся |
| CloudCart (cloudcart) | composio | Скрыт фильтром каталога; не проверялся |
| Memberstack (memberstack) | composio | Скрыт фильтром каталога; не проверялся |
| FinerWorks (finerworks) | composio | Скрыт фильтром каталога; не проверялся |
| Shipday (shipday) | composio | Скрыт фильтром каталога; не проверялся |
| BTCPay Server (btcpay-server) | composio | Скрыт фильтром каталога; не проверялся |
| Quaderno (quaderno) | composio | Скрыт фильтром каталога; не проверялся |
| Intercom (intercom) | composio | Скрыт фильтром каталога; не проверялся |
| Mailchimp (mailchimp) | composio | Скрыт фильтром каталога; не проверялся |
| QuickBooks (quickbooks) | composio | Скрыт фильтром каталога; не проверялся |
| HubSpot (hubspot) | composio | Скрыт фильтром каталога; не проверялся |
| Google Ads (google-ads) | composio | Скрыт фильтром каталога; не проверялся |
| Facebook (facebook) | composio | Скрыт фильтром каталога; не проверялся |
| Zendesk (zendesk) | composio | Скрыт фильтром каталога; не проверялся |
| Google Analytics (google-analytics) | composio | Скрыт фильтром каталога; не проверялся |
| Salesforce (salesforce) | composio | Скрыт фильтром каталога; не проверялся |
| Pinterest (pinterest) | composio | Скрыт фильтром каталога; не проверялся |
| ActiveCampaign (active-campaign) | composio | Скрыт фильтром каталога; не проверялся |
| Customer.io (customer-io) | composio | Скрыт фильтром каталога; не проверялся |
| Kit (kit) | composio | Скрыт фильтром каталога; не проверялся |
| Segment (segment) | composio | Скрыт фильтром каталога; не проверялся |
| SendGrid (sendgrid) | composio | Скрыт фильтром каталога; не проверялся |
| Wix (wix) | composio | Скрыт фильтром каталога; не проверялся |
| Fingertip (fingertip) | composio | Скрыт фильтром каталога; не проверялся |
| MerchantPro (merchantpro) | composio | Скрыт фильтром каталога; не проверялся |
| Payhip (payhip) | composio | Скрыт фильтром каталога; не проверялся |
| Zylvie (zylvie) | composio | Скрыт фильтром каталога; не проверялся |
| DPD (dpd2) | composio | Скрыт фильтром каталога; не проверялся |
| Addresszen (addresszen) | composio | Скрыт фильтром каталога; не проверялся |
| Bluebarry (bluebarry) | composio | Скрыт фильтром каталога; не проверялся |
| HitPay (hitpay) | composio | Скрыт фильтром каталога; не проверялся |
| Poof (poof) | composio | Скрыт фильтром каталога; не проверялся |
| ASIN Data API (asin-data-api) | composio | Скрыт фильтром каталога; не проверялся |
| Best Buy (bestbuy) | composio | Скрыт фильтром каталога; не проверялся |
| Countdown API (countdown-api) | composio | Скрыт фильтром каталога; не проверялся |
| Jungle Scout (jungle-scout) | composio | Скрыт фильтром каталога; не проверялся |
| OpenSea (opensea) | composio | Скрыт фильтром каталога; не проверялся |
| RedCircle API (redcircle-api) | composio | Скрыт фильтром каталога; не проверялся |
| Retailed (retailed) | composio | Скрыт фильтром каталога; не проверялся |
| CDR Platform (cdr-platform) | composio | Скрыт фильтром каталога; не проверялся |
| TaxJar (taxjar) | composio | Скрыт фильтром каталога; не проверялся |
| Apaleo (apaleo) | composio | Скрыт фильтром каталога; не проверялся |
| Asana (asana) | composio | Скрыт фильтром каталога; не проверялся |
| Attio (attio) | composio | Скрыт фильтром каталога; не проверялся |
| Bitbucket (bitbucket) | composio | Скрыт фильтром каталога; не проверялся |
| Blackbaud (blackbaud) | composio | Скрыт фильтром каталога; не проверялся |
| BoldSign (boldsign) | composio | Скрыт фильтром каталога; не проверялся |
| Box (box) | composio | Скрыт фильтром каталога; не проверялся |
| Cal.com (cal-com) | composio | Скрыт фильтром каталога; не проверялся |
| Calendly (calendly) | composio | Скрыт фильтром каталога; не проверялся |
| Canva (canva) | composio | Скрыт фильтром каталога; не проверялся |
| Capsule CRM (capsule-crm) | composio | Скрыт фильтром каталога; не проверялся |
| ClickUp (clickup) | composio | Скрыт фильтром каталога; не проверялся |
| Contentful (contentful) | composio | Скрыт фильтром каталога; не проверялся |
| Crowdin (crowdin) | composio | Скрыт фильтром каталога; не проверялся |
| Dart (dart) | composio | Скрыт фильтром каталога; не проверялся |
| Dialpad (dialpad) | composio | Скрыт фильтром каталога; не проверялся |
| Dropbox (dropbox) | composio | Скрыт фильтром каталога; не проверялся |
| Dub (dub) | composio | Скрыт фильтром каталога; не проверялся |
| Eventbrite (eventbrite) | composio | Скрыт фильтром каталога; не проверялся |
| Microsoft Excel (excel) | composio | Скрыт фильтром каталога; не проверялся |
| Exist (exist) | composio | Скрыт фильтром каталога; не проверялся |
| Fathom (fathom) | composio | Скрыт фильтром каталога; не проверялся |
| Figma (figma) | composio | Скрыт фильтром каталога; не проверялся |
| FreshBooks (freshbooks) | composio | Скрыт фильтром каталога; не проверялся |
| Google Classroom (google-classroom) | composio | Скрыт фильтром каталога; не проверялся |
| Google Maps (google-maps) | composio | Скрыт фильтром каталога; не проверялся |
| Google BigQuery (google-bigquery) | composio | Скрыт фильтром каталога; не проверялся |
| Google Meet (google-meet) | composio | Скрыт фильтром каталога; не проверялся |
| Google Photos (google-photos) | composio | Скрыт фильтром каталога; не проверялся |
| Google Slides (google-slides) | composio | Скрыт фильтром каталога; не проверялся |
| Google Tasks (google-tasks) | composio | Скрыт фильтром каталога; не проверялся |
| Greenhouse (greenhouse) | composio | Скрыт фильтром каталога; не проверялся |
| Harvest (harvest) | composio | Скрыт фильтром каталога; не проверялся |
| Hugging Face (hugging-face) | composio | Скрыт фильтром каталога; не проверялся |
| Instagram (instagram) | composio | Скрыт фильтром каталога; не проверялся |
| LinkedIn (linkedin) | composio | Скрыт фильтром каталога; не проверялся |
| Linkhut (linkhut) | composio | Скрыт фильтром каталога; не проверялся |
| Microsoft Teams (microsoft-teams) | composio | Скрыт фильтром каталога; не проверялся |
| Miro (miro) | composio | Скрыт фильтром каталога; не проверялся |
| monday.com (monday) | composio | Скрыт фильтром каталога; не проверялся |
| Moneybird (moneybird) | composio | Скрыт фильтром каталога; не проверялся |
| Mural (mural) | composio | Скрыт фильтром каталога; не проверялся |
| Omnisend (omnisend) | composio | Скрыт фильтром каталога; не проверялся |
| PagerDuty (pagerduty) | composio | Скрыт фильтром каталога; не проверялся |
| Pinterest Ads (pinterest-ads) | composio | Скрыт фильтром каталога; не проверялся |
| Prisma (prisma) | composio | Скрыт фильтром каталога; не проверялся |
| Productboard (productboard) | composio | Скрыт фильтром каталога; не проверялся |
| Pushbullet (pushbullet) | composio | Скрыт фильтром каталога; не проверялся |
| Reddit (reddit) | composio | Скрыт фильтром каталога; не проверялся |
| Reddit Ads (reddit-ads) | composio | Скрыт фильтром каталога; не проверялся |
| Roam (roam) | composio | Скрыт фильтром каталога; не проверялся |
| ServiceM8 (servicem8) | composio | Скрыт фильтром каталога; не проверялся |
| Splitwise (splitwise) | composio | Скрыт фильтром каталога; не проверялся |
| Stack Exchange (stack-exchange) | composio | Скрыт фильтром каталога; не проверялся |
| Ticketmaster (ticketmaster) | composio | Скрыт фильтром каталога; не проверялся |
| TickTick (ticktick) | composio | Скрыт фильтром каталога; не проверялся |
| Timely (timely) | composio | Скрыт фильтром каталога; не проверялся |
| Todoist (todoist) | composio | Скрыт фильтром каталога; не проверялся |
| Trello (trello) | composio | Скрыт фильтром каталога; не проверялся |
| Twitch (twitch) | composio | Скрыт фильтром каталога; не проверялся |
| Typeform (typeform) | composio | Скрыт фильтром каталога; не проверялся |
| WakaTime (wakatime) | composio | Скрыт фильтром каталога; не проверялся |
| Webex (webex) | composio | Скрыт фильтром каталога; не проверялся |
| Wrike (wrike) | composio | Скрыт фильтром каталога; не проверялся |
| Yandex (yandex) | composio | Скрыт фильтром каталога; не проверялся |
| YNAB (ynab) | composio | Скрыт фильтром каталога; не проверялся |
| YouTube (youtube) | composio | Скрыт фильтром каталога; не проверялся |
| Zeplin (zeplin) | composio | Скрыт фильтром каталога; не проверялся |
| Zoom (zoom) | composio | Скрыт фильтром каталога; не проверялся |
| Shopee (shopee) | local_api | OAuth на сайт; callback по умолчанию не работает |
| TikTok Shop (tiktok-shop) | local_api | OAuth на сайт; callback по умолчанию не работает |
| BigCommerce (bigcommerce) | local_api | Учётные данные/API; не проверен на сервисе |
| SHOPLINE (shopline) | local_api | Учётные данные/API; не проверен на сервисе |
| Shoplazza (shoplazza) | local_api | Учётные данные/API; не проверен на сервисе |
| Magento / Adobe Commerce (magento) | local_api | Учётные данные/API; не проверен на сервисе |
| Temu (temu-seller) | local_api | Учётные данные/API; не проверен на сервисе |
| Lazada (lazada-seller) | local_api | OAuth на сайт; callback по умолчанию не работает |
| SHEIN (shein-seller) | local_api | OAuth на сайт; callback по умолчанию не работает |
| Alibaba.com (alibaba-com-seller) | local_api | OAuth на сайт; callback по умолчанию не работает |
| AliExpress (aliexpress-seller) | local_api | OAuth на сайт; callback по умолчанию не работает |
| Rakuten RMS (rakuten-rms) | local_api | Учётные данные/API; не проверен на сервисе |
| BASE (base-shop) | local_api | OAuth на сайт; callback по умолчанию не работает |
| Qoo10 Japan (qoo10-japan) | local_api | Учётные данные/API; не проверен на сервисе |
| futureshop (futureshop) | local_api | Учётные данные/API; не проверен на сервисе |
| Yahoo! Shopping (yahoo-shopping) | local_api | OAuth на сайт; callback по умолчанию не работает |
| Commerce Layer (commerce-layer) | local_api | Учётные данные/API; не проверен на сервисе |
| Shopify Admin (shopify-admin) | local_api | Учётные данные/API; не проверен на сервисе |
| Constant Contact (constant-contact) | local_api | Device Flow; не проверен на сервисе |
| Lightspeed Retail X-Series (lightspeed-x) | local_api | Учётные данные/API; не проверен на сервисе |
| Square (square) | local_api | Учётные данные/API; не проверен на сервисе |
| Instacart Shopping (instacart-shopping) | local_api | Учётные данные/API; не проверен на сервисе |
| Reloadly (reloadly) | local_api | Учётные данные/API; не проверен на сервисе |
| WooCommerce (woocommerce) | local_api | Через ключи или WooCommerce relay (relay по умолчанию отсутствует) |
| Walmart Marketplace (walmart-marketplace) | local_api | Учётные данные/API; не проверен на сервисе |
| eBay Seller (ebay-seller) | local_api | OAuth на сайт; callback по умолчанию не работает |
| Etsy Seller (etsy-seller) | local_api | OAuth на сайт; callback по умолчанию не работает |
| Amazon Seller Central (amazon-seller-central) | local_api | Учётные данные/API; не проверен на сервисе |
| Mercado Libre Global Selling (mercado-libre-global-selling) | local_api | OAuth на сайт; callback по умолчанию не работает |
| Taobao / Tmall Seller (taobao-tmall-seller) | local_api | OAuth на сайт; callback по умолчанию не работает |
| 1688 Seller (alibaba-1688-seller) | local_api | OAuth на сайт; callback по умолчанию не работает |
| JD.com Seller (jd-seller) | local_api | OAuth на сайт; callback по умолчанию не работает |
| Pinduoduo Seller (pinduoduo-seller) | local_api | OAuth на сайт; callback по умолчанию не работает |
| Douyin Shop Seller (douyin-shop-seller) | local_api | Учётные данные/API; не проверен на сервисе |
| Kuaishou Shop Seller (kuaishou-shop-seller) | local_api | OAuth на сайт; callback по умолчанию не работает |
| Youzan Seller (youzan-seller) | local_api | Учётные данные/API; не проверен на сервисе |
| Weimob WOS Seller (weimob-wos-seller) | local_api | Учётные данные/API; не проверен на сервисе |
| Xiaohongshu Seller (xiaohongshu-seller) | local_api | Учётные данные/API; не проверен на сервисе |
| Klaviyo (klaviyo) | mcp_dcr | Зависит от отсутствующего DCR relay |
| PayPal (paypal) | mcp_dcr | Зависит от отсутствующего DCR relay |
| PayPal Sandbox (paypal-sandbox) | mcp_dcr | Зависит от отсутствующего DCR relay |
| Oracle NetSuite (netsuite) | mcp_dcr | Зависит от отсутствующего DCR relay |
| Color Me Shop (colorme-shop) | mcp_dcr | Зависит от отсутствующего DCR relay |
| Xero (xero) | local_cli | Авторизация через CLI; не проверена на сервисе |
| 企业微信 (wecom) | local_cli | Авторизация через CLI; не проверена на сервисе |
| 飞书 (feishu) | local_cli | Авторизация через CLI; не проверена на сервисе |
| Lark (lark) | local_cli | Авторизация через CLI; не проверена на сервисе |
| 钉钉 (dingtalk) | local_cli | Авторизация через CLI; не проверена на сервисе |
| GitHub (github) | local_api | Учётные данные/API; не проверен на сервисе |
| Notion (notion) | mcp_dcr | Зависит от отсутствующего DCR relay |
| Linear (linear) | mcp_dcr | Зависит от отсутствующего DCR relay |
| Atlassian (atlassian) | mcp_dcr | Зависит от отсутствующего DCR relay |
| Airtable (airtable) | mcp_dcr | Зависит от отсутствующего DCR relay |
| GitLab (gitlab) | mcp_dcr | Зависит от отсутствующего DCR relay |
| Sentry (sentry) | mcp_dcr | Зависит от отсутствующего DCR relay |
| Cloudflare (cloudflare) | mcp_dcr | Зависит от отсутствующего DCR relay |
| Stripe (stripe) | mcp_dcr | Зависит от отсутствующего DCR relay |
| Supabase (supabase) | mcp_dcr | Зависит от отсутствующего DCR relay |
| Close (close) | mcp_dcr | Зависит от отсутствующего DCR relay |
| Webflow (webflow) | mcp_dcr | Зависит от отсутствующего DCR relay |
| Slack (slack) | server_bridge | Зависит от отсутствующего OAuth bridge |
| Gmail (gmail) | composio | Скрыт фильтром каталога; не проверялся |
| Google Workspace (google-workspace) | server_bridge | Зависит от отсутствующего OAuth bridge |
| Google Calendar (gcal) | server_bridge | Зависит от отсутствующего OAuth bridge |
| Google Docs (gdocs) | server_bridge | Зависит от отсутствующего OAuth bridge |
| Google Sheets (gsheets) | server_bridge | Зависит от отсутствующего OAuth bridge |
| Google Tasks (gtasks) | server_bridge | Зависит от отсутствующего OAuth bridge |
| Google Search Console (gsearch-console) | server_bridge | Зависит от отсутствующего OAuth bridge |
| Bing Webmaster Tools (bing-webmaster) | server_bridge | Зависит от отсутствующего OAuth bridge |
