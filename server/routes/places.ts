/**
 * /api/cooling-spaces, /api/city-risk
 *
 * Disabling a cooling space here removes it from user recommendations on the
 * next evaluation - the recommendation engine filters on ACTIVE status, so the
 * CMS toggle is the real control.
 */

import { Router } from 'express';
import {
  coolingSpaceCreateSchema,
  coolingSpaceImportSchema,
  coolingSpaceUpdateSchema,
} from '../../shared/schemas/index.js';
import type { CoolingSpace } from '../../shared/types/domain.js';
import {
  COOLING_SPACE_LABELS,
  isOpenNow,
  recommendCoolingSpaces,
} from '../../shared/domain/coolingSpaces.js';
import { cityRiskRepo, coolingSpaceRepo, userRepo } from '../db/repositories.js';
import { platformState } from '../services/platformState.js';
import { asyncHandler, pathParam, recordAudit, validate } from '../middleware/common.js';
import { requireAuth, requirePermission, requireUserScope } from '../middleware/auth.js';

export const coolingSpacesRouter = Router();
export const cityRiskRouter = Router();

// ---------------------------------------------------------------------------
// Cooling spaces
// ---------------------------------------------------------------------------

coolingSpacesRouter.get(
  '/',
  requireAuth,
  requirePermission('cooling-space:read'),
  asyncHandler(async (req, res) => {
    const all = await coolingSpaceRepo.list();

    // Non-admin roles never see disabled locations; an admin needs to see
    // them in order to manage them.
    const account = req.account!;
    const isAdmin = account.role === 'SUPER_ADMIN' || account.role === 'ADMIN' || account.role === 'VIEWER';
    const spaces = isAdmin ? all : all.filter((s) => s.status === 'ACTIVE');

    res.json({
      spaces: spaces.map((s) => ({ ...s, openNow: isOpenNow(s) })),
      total: spaces.length,
      types: COOLING_SPACE_LABELS,
      summary: {
        active: all.filter((s) => s.status === 'ACTIVE').length,
        disabled: all.filter((s) => s.status === 'DISABLED').length,
        airConditioned: all.filter((s) => s.airConditioned && s.status === 'ACTIVE').length,
        accessible: all.filter((s) => s.accessible && s.status === 'ACTIVE').length,
        openNow: all.filter((s) => s.status === 'ACTIVE' && isOpenNow(s)).length,
      },
    });
  }),
);

/**
 * GET /api/cooling-spaces/recommend/:userId
 *
 * Ranked recommendations for one resident. Returns an explicit reason when the
 * list is empty, because "no results" and "location sharing is switched off"
 * are different situations the UI must distinguish.
 */
coolingSpacesRouter.get(
  '/recommend/:userId',
  requireAuth,
  requireUserScope((req) => pathParam(req, 'userId')),
  asyncHandler(async (req, res) => {
    const user = await userRepo.findById(pathParam(req, 'userId'));

    if (!user) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That resident does not exist.' });
      return;
    }

    if (!user.permissions.locationSharing) {
      res.json({
        recommendations: [],
        blocked: true,
        reason: 'Location sharing is switched off, so nearby locations cannot be suggested.',
        reasonZh: '位置分享已關閉，因此無法建議附近的涼適空間。',
      });
      return;
    }

    const spaces = await coolingSpaceRepo.list();
    const level = platformState.getAssessment(user.id)?.level ?? 'LOW';

    const maxDistanceKm = Number(req.query.maxDistanceKm) || 5;

    const recommendations = recommendCoolingSpaces({
      user,
      spaces,
      level,
      maxDistanceKm,
      limit: Number(req.query.limit) || 8,
    });

    res.json({
      recommendations,
      blocked: false,
      level,
      // When nothing is within range the client needs to say so honestly
      // rather than showing an empty list with no explanation.
      reason:
        recommendations.length === 0
          ? `No active cooling location is within ${maxDistanceKm} km.`
          : undefined,
      reasonZh:
        recommendations.length === 0
          ? `${maxDistanceKm} 公里內沒有啟用的涼適空間。`
          : undefined,
    });
  }),
);

coolingSpacesRouter.post(
  '/',
  requireAuth,
  requirePermission('cooling-space:write'),
  validate(coolingSpaceCreateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as typeof coolingSpaceCreateSchema._output;
    const existing = await coolingSpaceRepo.list();

    const space = await coolingSpaceRepo.create({
      ...body,
      id: `cool-${String(existing.length + 1).padStart(3, '0')}-${Date.now().toString(36)}`,
    });

    await recordAudit(req, {
      action: 'Created cooling location',
      actionZh: '新增涼適空間',
      entity: 'CoolingSpace',
      entityId: space.id,
      newValue: `${space.name} (${space.type}), ${space.district}`,
    });

    await platformState.reloadCoolingSpaces();
    res.status(201).json({ space });
  }),
);

coolingSpacesRouter.patch(
  '/:id',
  requireAuth,
  requirePermission('cooling-space:write'),
  validate(coolingSpaceUpdateSchema),
  asyncHandler(async (req, res) => {
    const before = await coolingSpaceRepo.findById(pathParam(req, 'id'));
    if (!before) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That location does not exist.' });
      return;
    }

    const space = await coolingSpaceRepo.update(pathParam(req, 'id'), req.body as Partial<CoolingSpace>);

    await recordAudit(req, {
      action: 'Updated cooling location',
      actionZh: '更新涼適空間',
      entity: 'CoolingSpace',
      entityId: space.id,
      oldValue: summarise(before),
      newValue: summarise(space),
    });

    await platformState.reloadCoolingSpaces();
    res.json({ space });
  }),
);

/** Enable or disable. A disabled location leaves user recommendations. */
coolingSpacesRouter.post(
  '/:id/toggle',
  requireAuth,
  requirePermission('cooling-space:write'),
  asyncHandler(async (req, res) => {
    const before = await coolingSpaceRepo.findById(pathParam(req, 'id'));
    if (!before) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That location does not exist.' });
      return;
    }

    const status = before.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    const space = await coolingSpaceRepo.update(pathParam(req, 'id'), { status });

    await recordAudit(req, {
      action: status === 'ACTIVE' ? 'Enabled cooling location' : 'Disabled cooling location',
      actionZh: status === 'ACTIVE' ? '啟用涼適空間' : '停用涼適空間',
      entity: 'CoolingSpace',
      entityId: space.id,
      oldValue: before.status,
      newValue: status,
    });

    await platformState.reloadCoolingSpaces();
    res.json({ space, activeCount: platformState.getStats().activeCoolingSpaces });
  }),
);

coolingSpacesRouter.delete(
  '/:id',
  requireAuth,
  requirePermission('cooling-space:write'),
  asyncHandler(async (req, res) => {
    const before = await coolingSpaceRepo.findById(pathParam(req, 'id'));
    if (!before) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That location does not exist.' });
      return;
    }

    await coolingSpaceRepo.delete(pathParam(req, 'id'));

    await recordAudit(req, {
      action: 'Deleted cooling location',
      actionZh: '刪除涼適空間',
      entity: 'CoolingSpace',
      entityId: pathParam(req, 'id'),
      oldValue: summarise(before),
      newValue: 'deleted',
    });

    await platformState.reloadCoolingSpaces();
    res.json({ deleted: true, id: pathParam(req, 'id') });
  }),
);

/** Bulk import, e.g. from a municipal facility register. */
coolingSpacesRouter.post(
  '/import',
  requireAuth,
  requirePermission('cooling-space:write'),
  validate(coolingSpaceImportSchema),
  asyncHandler(async (req, res) => {
    const { spaces } = req.body as typeof coolingSpaceImportSchema._output;
    const existing = await coolingSpaceRepo.list();
    const existingNames = new Set(existing.map((s) => s.name));

    const created: string[] = [];
    const skipped: string[] = [];

    for (const [index, incoming] of spaces.entries()) {
      // Skip duplicates by name rather than creating a second copy of a
      // location that is already in the register.
      if (existingNames.has(incoming.name)) {
        skipped.push(incoming.name);
        continue;
      }

      const space = await coolingSpaceRepo.create({
        ...incoming,
        id: `cool-import-${Date.now().toString(36)}-${index}`,
      });
      created.push(space.name);
      existingNames.add(space.name);
    }

    await recordAudit(req, {
      action: 'Imported cooling locations',
      actionZh: '匯入涼適空間',
      entity: 'CoolingSpace',
      entityId: 'import',
      newValue: `${created.length} created, ${skipped.length} skipped as duplicates`,
    });

    await platformState.reloadCoolingSpaces();
    res.status(201).json({ created: created.length, skipped, createdNames: created });
  }),
);

// ---------------------------------------------------------------------------
// City risk
// ---------------------------------------------------------------------------

/**
 * GET /api/city-risk
 *
 * District-level heat risk for the map and the CMS. Values come from the live
 * in-memory model so the map moves during a scenario.
 *
 * PRIVACY: this response deliberately carries no individual physiological
 * data. Districts report a resident COUNT only - never a named person, a
 * heart rate or a location precise enough to identify a household.
 */
cityRiskRouter.get(
  '/',
  requireAuth,
  requirePermission('city-risk:read'),
  asyncHandler(async (_req, res) => {
    const live = platformState.getCityRisk();
    const stored = await cityRiskRepo.list();

    const districts = live.length > 0 ? live : stored;
    const spaces = await coolingSpaceRepo.list();

    res.json({
      districts: districts.map((d) => ({
        ...d,
        coolingSpaceCount: spaces.filter((s) => s.district === d.district && s.status === 'ACTIVE')
          .length,
      })),
      city: districts[0]?.city ?? '台北市',
      stats: platformState.getStats(),
      privacyNotice:
        'District-level aggregates only. No individual physiological data is exposed on the city map.',
      privacyNoticeZh: '僅顯示行政區層級的彙總資料，城市地圖不會呈現任何個人生理資訊。',
    });
  }),
);

/** Persist the current live district values back to the database. */
cityRiskRouter.post(
  '/sync',
  requireAuth,
  requirePermission('city-risk:write'),
  asyncHandler(async (req, res) => {
    const live = platformState.getCityRisk();
    await cityRiskRepo.upsertMany(live);

    await recordAudit(req, {
      action: 'Synced city heat-risk data',
      actionZh: '同步城市熱風險資料',
      entity: 'CityRisk',
      entityId: 'taipei',
      newValue: `${live.length} districts updated`,
    });

    res.json({ synced: live.length, districts: live });
  }),
);

function summarise(space: CoolingSpace): string {
  return `${space.name} [${space.status}] AC=${space.airConditioned} accessible=${space.accessible} hours=${space.openingHours} risk=${space.riskLevel}`;
}
