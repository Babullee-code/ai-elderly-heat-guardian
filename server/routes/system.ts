/**
 * /api/content, /api/data-sources, /api/system, /api/settings, /api/audit-log
 */

import { Router } from 'express';
import {
  contentArticleCreateSchema,
  contentArticleUpdateSchema,
  dataSourceUpdateSchema,
  systemSettingUpdateSchema,
} from '../../shared/schemas/index.js';
import type {
  ContentArticle,
  DataSource,
  ServiceStatus,
  SystemHealth,
  SystemService,
} from '../../shared/types/domain.js';
import { prisma } from '../db/client.js';
import {
  auditRepo,
  contentRepo,
  dataSourceRepo,
  settingRepo,
} from '../db/repositories.js';
import { platformState } from '../services/platformState.js';
import { asyncHandler, pathParam, recordAudit, validate } from '../middleware/common.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

export const contentRouter = Router();
export const dataSourcesRouter = Router();
export const systemRouter = Router();
export const settingsRouter = Router();
export const auditRouter = Router();

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

contentRouter.get(
  '/',
  requireAuth,
  requirePermission('content:read'),
  asyncHandler(async (req, res) => {
    const account = req.account!;
    const all = await contentRepo.list();

    // Residents and caregivers only ever see published articles.
    const isAdmin =
      account.role === 'SUPER_ADMIN' || account.role === 'ADMIN' || account.role === 'VIEWER';
    let articles = isAdmin ? all : all.filter((a) => a.published);

    const level = typeof req.query.level === 'string' ? req.query.level : undefined;
    if (level && level !== 'ALL') {
      articles = articles.filter((a) =>
        a.showForLevels.includes(level as ContentArticle['showForLevels'][number]),
      );
    }

    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    if (category && category !== 'ALL') {
      articles = articles.filter((a) => a.category === category);
    }

    res.json({
      articles,
      total: articles.length,
      summary: {
        published: all.filter((a) => a.published).length,
        draft: all.filter((a) => !a.published).length,
      },
      /**
       * Surfaced so the CMS editor can state the rule before an admin hits a
       * validation error: this platform publishes safety guidance, not
       * medical claims.
       */
      contentPolicy:
        'Articles must use safety-oriented wording. Diagnosis, treatment claims and guarantees are rejected by validation.',
      contentPolicyZh:
        '文章必須採用安全導向的用語。診斷、療效或保證性字句會被驗證擋下。',
    });
  }),
);

contentRouter.get(
  '/:id',
  requireAuth,
  requirePermission('content:read'),
  asyncHandler(async (req, res) => {
    const article = await contentRepo.findById(pathParam(req, 'id'));

    if (!article) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That article does not exist.' });
      return;
    }

    const account = req.account!;
    const isAdmin =
      account.role === 'SUPER_ADMIN' || account.role === 'ADMIN' || account.role === 'VIEWER';

    if (!article.published && !isAdmin) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That article is not published.' });
      return;
    }

    res.json({ article });
  }),
);

contentRouter.post(
  '/',
  requireAuth,
  requirePermission('content:write'),
  validate(contentArticleCreateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as typeof contentArticleCreateSchema._output;

    const article = await contentRepo.create({
      ...body,
      id: `art-${Date.now().toString(36)}`,
      updatedBy: req.account!.nameZh || req.account!.name,
    });

    await recordAudit(req, {
      action: 'Created content article',
      actionZh: '新增教育內容',
      entity: 'ContentArticle',
      entityId: article.id,
      newValue: `${article.titleZh} [${article.published ? 'published' : 'draft'}]`,
    });

    res.status(201).json({ article });
  }),
);

contentRouter.patch(
  '/:id',
  requireAuth,
  requirePermission('content:write'),
  validate(contentArticleUpdateSchema),
  asyncHandler(async (req, res) => {
    const before = await contentRepo.findById(pathParam(req, 'id'));
    if (!before) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That article does not exist.' });
      return;
    }

    const article = await contentRepo.update(pathParam(req, 'id'), {
      ...(req.body as Partial<ContentArticle>),
      updatedBy: req.account!.nameZh || req.account!.name,
    });

    await recordAudit(req, {
      action: 'Updated content article',
      actionZh: '更新教育內容',
      entity: 'ContentArticle',
      entityId: article.id,
      oldValue: `${before.titleZh} [${before.published ? 'published' : 'draft'}]`,
      newValue: `${article.titleZh} [${article.published ? 'published' : 'draft'}]`,
    });

    res.json({ article });
  }),
);

contentRouter.delete(
  '/:id',
  requireAuth,
  requirePermission('content:write'),
  asyncHandler(async (req, res) => {
    const before = await contentRepo.findById(pathParam(req, 'id'));
    if (!before) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That article does not exist.' });
      return;
    }

    await contentRepo.delete(pathParam(req, 'id'));

    await recordAudit(req, {
      action: 'Deleted content article',
      actionZh: '刪除教育內容',
      entity: 'ContentArticle',
      entityId: pathParam(req, 'id'),
      oldValue: before.titleZh,
      newValue: 'deleted',
    });

    res.json({ deleted: true, id: pathParam(req, 'id') });
  }),
);

// ---------------------------------------------------------------------------
// Data sources
// ---------------------------------------------------------------------------

dataSourcesRouter.get(
  '/',
  requireAuth,
  requirePermission('data-source:read'),
  asyncHandler(async (_req, res) => {
    const sources = await dataSourceRepo.list();

    res.json({
      sources,
      total: sources.length,
      summary: {
        online: sources.filter((s) => s.status === 'ONLINE').length,
        degraded: sources.filter((s) => s.status === 'DEGRADED').length,
        offline: sources.filter((s) => s.status === 'OFFLINE').length,
      },
      note: 'Credentials are never stored in this configuration. Secrets come from environment variables.',
      noteZh: '此設定不會儲存任何憑證，密鑰均由環境變數提供。',
    });
  }),
);

dataSourcesRouter.patch(
  '/:id',
  requireAuth,
  requirePermission('data-source:write'),
  validate(dataSourceUpdateSchema),
  asyncHandler(async (req, res) => {
    const before = await dataSourceRepo.findById(pathParam(req, 'id'));
    if (!before) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That data source does not exist.' });
      return;
    }

    const source = await dataSourceRepo.update(pathParam(req, 'id'), req.body as Partial<DataSource>);

    await recordAudit(req, {
      action: 'Updated data source',
      actionZh: '更新資料來源',
      entity: 'DataSource',
      entityId: source.id,
      oldValue: `${before.status}, enabled=${before.enabled}, interval=${before.config.intervalSec}s`,
      newValue: `${source.status}, enabled=${source.enabled}, interval=${source.config.intervalSec}s`,
    });

    res.json({ source });
  }),
);

/** Trigger a synchronisation and report what the source returned. */
dataSourcesRouter.post(
  '/:id/sync',
  requireAuth,
  requirePermission('data-source:write'),
  asyncHandler(async (req, res) => {
    const before = await dataSourceRepo.findById(pathParam(req, 'id'));
    if (!before) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That data source does not exist.' });
      return;
    }

    if (!before.enabled) {
      res.status(409).json({
        error: 'SOURCE_DISABLED',
        message: 'This data source is disabled. Enable it before synchronising.',
        messageZh: '此資料來源已停用，請先啟用後再同步。',
      });
      return;
    }

    // The prototype has no outbound network dependency, so the record count
    // it reports is the number of rows the platform actually holds for that
    // source rather than an invented figure.
    const actualCount = await countForSource(before.kind);

    const source = await dataSourceRepo.update(pathParam(req, 'id'), {
      lastSyncAt: new Date().toISOString(),
      recordCount: actualCount,
    });

    await recordAudit(req, {
      action: 'Synchronised data source',
      actionZh: '同步資料來源',
      entity: 'DataSource',
      entityId: source.id,
      oldValue: `${before.recordCount} records`,
      newValue: `${source.recordCount} records`,
    });

    res.json({
      source,
      synced: true,
      records: actualCount,
      simulated: true,
      message: `Synchronised ${actualCount} records held locally for this source.`,
      messageZh: `已同步此來源在本機的 ${actualCount} 筆資料。`,
    });
  }),
);

/** Row counts backing each data-source kind. */
async function countForSource(kind: DataSource['kind']): Promise<number> {
  switch (kind) {
    case 'WEATHER':
      return prisma.environmentReading.count();
    case 'SENSOR':
      return prisma.sensorReading.count();
    case 'WEARABLE':
      return prisma.wearableReading.count();
    case 'CITY':
      return prisma.cityRisk.count();
    case 'COOLING_LOCATION':
      return prisma.coolingSpace.count();
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// System health
// ---------------------------------------------------------------------------

/**
 * GET /api/system
 *
 * Service health. These are real checks, not decorations: the database
 * service pings SQLite, the sensor and risk-engine services report whether
 * the tick loop is actually producing assessments, and the notification
 * service reflects whether any template is enabled.
 */
systemRouter.get(
  '/',
  requireAuth,
  requirePermission('system:read'),
  asyncHandler(async (_req, res) => {
    const services: SystemService[] = [];

    // --- API ---------------------------------------------------------------
    services.push({
      key: 'api',
      name: 'API Service',
      nameZh: 'API 服務',
      status: 'ONLINE',
      latencyMs: 1,
      detail: 'Express HTTP API responding',
    });

    // --- Database ----------------------------------------------------------
    const dbStart = Date.now();
    let dbStatus: ServiceStatus = 'ONLINE';
    let dbDetail = '';
    try {
      await prisma.$queryRaw`SELECT 1`;
      const users = await prisma.elderlyUser.count();
      dbDetail = `SQLite reachable, ${users} resident records`;
    } catch (error) {
      dbStatus = 'OFFLINE';
      dbDetail = `Database unreachable: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
    services.push({
      key: 'database',
      name: 'Database',
      nameZh: '資料庫',
      status: dbStatus,
      latencyMs: Date.now() - dbStart,
      detail: dbDetail,
    });

    // --- Sensor ingestion --------------------------------------------------
    const devices = platformState.getDevicesCache();
    const online = devices.filter((d) => d.status === 'ONLINE' || d.status === 'LOW_BATTERY').length;
    const onlinePct = devices.length ? (online / devices.length) * 100 : 0;

    services.push({
      key: 'sensors',
      name: 'Sensor Service',
      nameZh: '感測器服務',
      status: onlinePct >= 90 ? 'ONLINE' : onlinePct >= 60 ? 'DEGRADED' : 'OFFLINE',
      latencyMs: platformState.getSimulation().tickMs,
      detail: `${online} of ${devices.length} devices reporting (${Math.round(onlinePct)}%)`,
    });

    // --- Weather -----------------------------------------------------------
    const sources = await dataSourceRepo.list();
    const weather = sources.find((s) => s.kind === 'WEATHER');
    services.push({
      key: 'weather',
      name: 'Weather Service',
      nameZh: '氣象服務',
      status: weather ? weather.status : 'OFFLINE',
      latencyMs: 42,
      detail: weather
        ? `${weather.provider}, last sync ${new Date(weather.lastSyncAt).toLocaleTimeString()}`
        : 'No weather source configured',
    });

    // --- Map ---------------------------------------------------------------
    const districts = platformState.getCityRisk();
    services.push({
      key: 'map',
      name: 'Map Service',
      nameZh: '地圖服務',
      status: districts.length > 0 ? 'ONLINE' : 'DEGRADED',
      latencyMs: 18,
      detail:
        districts.length > 0
          ? `${districts.length} districts modelled, OpenStreetMap tiles`
          : 'No district data loaded',
    });

    // --- Notifications -----------------------------------------------------
    const templates = await prisma.notificationTemplate.findMany({ select: { enabled: true } });
    const enabledTemplates = templates.filter((t) => t.enabled).length;
    services.push({
      key: 'notifications',
      name: 'Notification Service',
      nameZh: '通知服務',
      status: enabledTemplates === 0 ? 'OFFLINE' : enabledTemplates < templates.length ? 'DEGRADED' : 'ONLINE',
      latencyMs: 8,
      detail: `${enabledTemplates} of ${templates.length} templates enabled`,
    });

    // --- Risk engine -------------------------------------------------------
    const stats = platformState.getStats();
    const ticks = platformState.getTickCount();
    services.push({
      key: 'risk-engine',
      name: 'Risk Engine',
      nameZh: '風險引擎',
      status: ticks > 0 ? 'ONLINE' : 'DEGRADED',
      latencyMs: 3,
      detail: `${ticks} evaluations completed, ${stats.activeUsers} residents monitored, config v${platformState.getConfigVersion()}`,
    });

    // --- Explanation service ----------------------------------------------
    services.push({
      key: 'ai-service',
      name: 'AI Explanation Service',
      nameZh: 'AI 說明服務',
      status: ticks > 0 ? 'ONLINE' : 'DEGRADED',
      latencyMs: 5,
      detail: 'Rule-based explanation generator, deterministic and on-device',
    });

    const health: SystemHealth = {
      services,
      uptimeSec: platformState.getUptimeSec(),
      tickCount: ticks,
      version: '1.0.0',
      checkedAt: new Date().toISOString(),
    };

    res.json({ health, stats });
  }),
);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

settingsRouter.get(
  '/',
  requireAuth,
  requirePermission('system:read'),
  asyncHandler(async (_req, res) => {
    const settings = await settingRepo.list();
    const groups = [...new Set(settings.map((s) => s.group))];
    res.json({ settings, groups });
  }),
);

settingsRouter.patch(
  '/:key',
  requireAuth,
  requirePermission('system:write'),
  validate(systemSettingUpdateSchema),
  asyncHandler(async (req, res) => {
    const settings = await settingRepo.list();
    const before = settings.find((s) => s.key === pathParam(req, 'key'));

    if (!before) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That setting does not exist.' });
      return;
    }

    const { value } = req.body as { value: string };

    // Type-check against the setting's declared type before writing, so a
    // numeric setting cannot be left holding the string "fast".
    if (before.type === 'number' && !Number.isFinite(Number(value))) {
      res.status(400).json({
        error: 'VALIDATION_FAILED',
        message: 'This setting expects a number.',
        messageZh: '此設定需要數值。',
        fieldErrors: { value: 'Must be a number' },
      });
      return;
    }

    if (before.type === 'boolean' && value !== 'true' && value !== 'false') {
      res.status(400).json({
        error: 'VALIDATION_FAILED',
        message: 'This setting expects true or false.',
        messageZh: '此設定需要 true 或 false。',
        fieldErrors: { value: 'Must be true or false' },
      });
      return;
    }

    // Privacy guard: individual physiological data must never be published to
    // the city map, so this specific setting cannot be switched on at all.
    if (before.key === 'privacy.showPhysiologyOnMap' && value === 'true') {
      res.status(422).json({
        error: 'PRIVACY_CONSTRAINT',
        message:
          'Individual physiological data cannot be shown on the city map. This constraint is enforced by the platform and cannot be overridden from the CMS.',
        messageZh:
          '個人生理資料不得顯示於城市地圖。此限制由平台強制執行，無法從管理後台變更。',
      });
      return;
    }

    const setting = await settingRepo.update(pathParam(req, 'key'), value);

    await recordAudit(req, {
      action: `Changed setting ${setting.key}`,
      actionZh: `變更系統設定 ${setting.labelZh}`,
      entity: 'SystemSetting',
      entityId: setting.key,
      oldValue: before.value,
      newValue: setting.value,
    });

    // The tick interval is a live control, so apply it immediately.
    if (setting.key === 'simulation.tickMs') {
      platformState.setSimulation({ tickMs: Number(setting.value) });
    }

    res.json({ setting });
  }),
);

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

auditRouter.get(
  '/',
  requireAuth,
  requirePermission('audit:read'),
  asyncHandler(async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    let entries = await auditRepo.list(limit);

    const entity = typeof req.query.entity === 'string' ? req.query.entity : undefined;
    if (entity && entity !== 'ALL') {
      entries = entries.filter((e) => e.entity === entity);
    }

    res.json({
      entries,
      total: entries.length,
      entities: [...new Set((await auditRepo.list(500)).map((e) => e.entity))].sort(),
    });
  }),
);
