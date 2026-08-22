import type { Principal } from "../storage/identity-store.ts";
import { readSignupSettings } from "../storage/identity-store.ts";
import { hasAllowedEntitlement, type EntitlementResourceType } from "../storage/policy-store.ts";
import type { RouteConfig } from "@model-proxy/contracts/schemas/routing.ts";

export class AccessDeniedError extends Error {
  constructor(
    readonly resourceType: EntitlementResourceType,
    readonly resourceId: string,
  ) {
    super(`Access denied for ${resourceType} '${resourceId}'`);
    this.name = "AccessDeniedError";
  }
}

export function canUseLogicalModel(p: Principal | undefined, modelId: string): boolean {
  return canUseResource(p, "model", modelId);
}

export function canListModel(p: Principal | undefined, modelId: string): boolean {
  return canUseLogicalModel(p, modelId);
}

export function canUseAudioModel(p: Principal | undefined, modelId: string): boolean {
  return canUseResource(p, "audio_model", modelId);
}

export function canUseFusionInternalModel(p: Principal | undefined, modelId: string): boolean {
  return canUseResource(p, "fusion_model", modelId) || canUseResource(p, "model", modelId);
}

export function canUseRouteConfig(
  p: Principal | undefined,
  sourceLogicalModel: string,
  route: RouteConfig,
): boolean {
  if (!canUseLogicalModel(p, sourceLogicalModel)) return false;
  if (p === undefined || p.ownerBypass || p.isOwner || p.userId === undefined) return true;
  const explicitIds = [
    route.route_id,
    ...(route.access_tags ?? []).map((tag) => `tag:${tag}`),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  if (explicitIds.length === 0) return true;
  return explicitIds.some((id) => hasAllowedEntitlement(p.userId!, "route", id));
}

export function assertCanUseLogicalModel(p: Principal | undefined, modelId: string): void {
  if (!canUseLogicalModel(p, modelId)) throw new AccessDeniedError("model", modelId);
}

export function assertCanUseAudioModel(p: Principal | undefined, modelId: string): void {
  if (!canUseAudioModel(p, modelId)) throw new AccessDeniedError("audio_model", modelId);
}

function canUseResource(
  p: Principal | undefined,
  resourceType: EntitlementResourceType,
  resourceId: string,
): boolean {
  if (p === undefined) return true;
  if (p.ownerBypass || p.isOwner) return true;
  if (p.userId === undefined) return false;
  if (!readSignupSettings().multiUserEnabled) return false;
  return hasAllowedEntitlement(p.userId, resourceType, resourceId);
}
