import type { Element, Node } from "@xmldom/xmldom";

import { parseXmlDocument } from "../domain/xmlDocument.js";

/** Component kinds a decoded AndroidManifest can declare under <application>. */
export const ANDROID_COMPONENT_KINDS = [
  "activity",
  "activity-alias",
  "service",
  "receiver",
  "provider",
] as const;
export type AndroidComponentKind = (typeof ANDROID_COMPONENT_KINDS)[number];

/** Bounds keep a hostile manifest from exhausting the inspection. */
export const ANDROID_MANIFEST_LIMITS = {
  components: 512,
  intentFilters: 32,
  intentValues: 64,
  authorities: 64,
  /** Total bytes of resolved component names, bounding package amplification. */
  resolvedNameBytes: 1024 * 1024,
  authorityBytes: 1024 * 1024,
  /** Total copied permission-value bytes, including inherited defaults. */
  permissionBytes: 1024 * 1024,
} as const;

/** The attribute namespace every component facet uses. */
const ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android";

export interface AndroidManifestComponent {
  readonly kind: AndroidComponentKind;
  /** Class name as written in the manifest. */
  readonly declared_name: string;
  /**
   * Fully qualified name with the manifest package applied, or the declared
   * name unchanged when the resolved-name byte budget was exhausted.
   */
  readonly name: string;
  /**
   * Declared android:exported, or null when the attribute is absent or set
   * to a value other than the literals true or false, whose effective state
   * the parser cannot resolve.
   */
  readonly exported: boolean | null;
  /**
   * Android's default export state when android:exported is absent: the
   * intent-filter rule for activities, services, receivers and aliases, and
   * the target-SDK rule for providers. Null when the provider rule cannot be
   * evaluated because the target SDK is unknown, or when the attribute is
   * present but not a literal boolean, since the default does not govern a
   * declared value.
   */
  readonly exported_default: boolean | null;
  readonly permission: string | null;
  /** Source of the effective permission projection; unknown when its copy is capped. */
  readonly permission_source: "component" | "application" | "none" | "unknown";
  readonly intent_filter_count: number;
  readonly actions: readonly string[];
  readonly categories: readonly string[];
  /** Declared android:foregroundServiceType on services; null otherwise. */
  readonly foreground_service_type: string | null;
  /** Declared android:authorities on providers, split on ";". */
  readonly authorities: readonly string[] | null;
  /** Declared android:targetActivity on activity-alias. */
  readonly target_activity: string | null;
}

export interface AndroidManifestComponentInventory {
  readonly status: "complete" | "partial" | "unavailable";
  readonly items: readonly AndroidManifestComponent[];
  readonly limitations: readonly string[];
}

const PARTIAL_LIMITATION =
  "The decoded manifest text is truncated, so its component inventory is not established; the retained manifest is partial.";

const unavailable = (
  limitation: string,
): AndroidManifestComponentInventory => ({
  status: "unavailable",
  items: [],
  limitations: [limitation],
});

const childNodes = (element: Element): readonly Node[] =>
  Array.from(element.childNodes);

/** Read an unnamespaced attribute, the shape manifest `package` uses. */
const plainAttribute = (element: Element, name: string): string | null => {
  const value = element.getAttribute(name);
  return value === "" ? null : value;
};

/**
 * Read an android-namespaced attribute. XML prefixes are aliases, so a
 * same-local-name attribute from another namespace is never a match.
 */
const androidAttribute = (
  element: Element,
  localName: string,
): string | null => {
  const attributes = element.attributes;
  for (let index = 0; index < attributes.length; index += 1) {
    const node = attributes.item(index);
    if (node === null || node.localName !== localName) continue;
    if (node.namespaceURI === ANDROID_NAMESPACE) return node.nodeValue;
    // Without namespace information (an undeclared prefix), the conventional
    // android: prefix is the only remaining signal.
    if (node.namespaceURI === null && node.prefix === "android")
      return node.nodeValue;
  }
  return null;
};

const trimmed = (element: Element, name: string): string | null => {
  const value = androidAttribute(element, name)?.trim();
  return value === undefined || value.length === 0 ? null : value;
};

/**
 * Android resolves a component name against the manifest package: a leading
 * dot or a name without any dot is relative to the package, while a dotted
 * name is already fully qualified.
 */
export const resolveAndroidComponentName = (
  packageName: string | null,
  declared: string,
): string => {
  if (declared.startsWith(".")) return `${packageName ?? ""}${declared}`;
  if (!declared.includes(".") && packageName !== null)
    return `${packageName}.${declared}`;
  return declared;
};

const isComponentKind = (tag: string): tag is AndroidComponentKind =>
  (ANDROID_COMPONENT_KINDS as readonly string[]).includes(tag);

/**
 * Android's target-SDK rule for an absent android:exported on providers:
 * exported through API 16, not exported from API 17.
 */
export const providerExportedDefault = (
  targetSdk: string | null,
): boolean | null => {
  if (targetSdk === null || !/^\d+$/u.test(targetSdk)) return null;
  const level = Number(targetSdk);
  if (!Number.isSafeInteger(level) || level < 1) return null;
  return level <= 16;
};

const androidTargetSdkLevel = (targetSdk: string | null): number | null => {
  if (targetSdk === null || !/^\d+$/u.test(targetSdk)) return null;
  const level = Number(targetSdk);
  return Number.isSafeInteger(level) && level >= 1 ? level : null;
};

/**
 * Collect unique intent-filter actions and categories. The value budget is
 * shared across both arrays, matching the stated per-component bound.
 */
const intentValues = (
  filters: readonly Element[],
): { actions: string[]; categories: string[]; truncated: boolean } => {
  const actions: string[] = [];
  const categories: string[] = [];
  let truncated = filters.length > ANDROID_MANIFEST_LIMITS.intentFilters;
  let budget = ANDROID_MANIFEST_LIMITS.intentValues;
  for (const filter of filters.slice(0, ANDROID_MANIFEST_LIMITS.intentFilters))
    for (const member of childNodes(filter)) {
      if (member.nodeType !== 1) continue;
      const element = member as Element;
      if (element.nodeName !== "action" && element.nodeName !== "category")
        continue;
      const value = trimmed(element, "name");
      if (value === null) continue;
      const target = element.nodeName === "action" ? actions : categories;
      if (target.includes(value)) continue;
      if (budget <= 0) {
        truncated = true;
        continue;
      }
      budget -= 1;
      target.push(value);
    }
  return { actions, categories, truncated };
};

/** Split a provider authorities declaration within its own bound. */
const providerAuthorities = (
  declared: string,
  byteLimit: number,
): { authorities: string[]; truncated: boolean; bytes: number } => {
  const authorities: string[] = [];
  let truncated = false;
  let bytes = 0;
  let start = 0;
  while (start <= declared.length) {
    const separator = declared.indexOf(";", start);
    const end = separator < 0 ? declared.length : separator;
    const trimmedValue = declared.slice(start, end).trim();
    if (trimmedValue.length === 0) {
      if (separator < 0) break;
      start = separator + 1;
      continue;
    }
    const valueBytes = Buffer.byteLength(trimmedValue);
    if (
      authorities.length >= ANDROID_MANIFEST_LIMITS.authorities ||
      valueBytes > byteLimit - bytes
    ) {
      truncated = true;
      break;
    }
    authorities.push(trimmedValue);
    bytes += valueBytes;
    if (separator < 0) break;
    start = separator + 1;
  }
  return { authorities, truncated, bytes };
};

/**
 * Parse the decoded AndroidManifest XML text into a bounded, deterministic
 * component inventory. The projection is static: it reports declarations and
 * Android's documented export defaults, never merged-manifest or runtime
 * state.
 */
export const parseAndroidManifestComponents = (
  manifestText: string,
  coverage: "complete" | "partial",
  targetSdk: string | null = null,
): AndroidManifestComponentInventory => {
  if (coverage === "partial")
    return {
      status: "partial",
      items: [],
      limitations: [PARTIAL_LIMITATION],
    };
  const parsed = parseXmlDocument(manifestText, {
    doctype: "reject",
    lineEndings: "preserve",
  });
  if (!parsed.ok)
    return unavailable(
      `The decoded manifest is not well-formed XML (${parsed.error.reason}), so its component inventory is unavailable.`,
    );
  const root = parsed.value.documentElement;
  if (root === null || root.nodeName !== "manifest")
    return unavailable(
      "The decoded manifest root is not <manifest>, so its component inventory is unavailable.",
    );
  const packageName = plainAttribute(root, "package")?.trim() || null;
  const packageHasUnresolvedToken =
    packageName?.includes("@") === true ||
    packageName?.includes("?") === true ||
    packageName?.includes("${") === true;
  const limitations: string[] = [];
  const items: AndroidManifestComponent[] = [];
  let truncated = false;
  let applicationSeen = false;
  let unnamed = 0;
  let providerDefaultsUnknown = 0;
  let nonliteralExported = 0;
  let unresolvedNames = 0;
  let unresolvedPackages = 0;
  let unresolvedTokens = 0;
  let invalidExported = 0;
  let unknownFilteredExportDefaults = 0;
  let capacityTruncated = false;
  let permissionBudgetLimited = false;
  let nameBudget = ANDROID_MANIFEST_LIMITS.resolvedNameBytes;
  let authorityBudget = ANDROID_MANIFEST_LIMITS.authorityBytes;
  let permissionBudget = ANDROID_MANIFEST_LIMITS.permissionBytes;
  const targetSdkLevel = androidTargetSdkLevel(targetSdk);
  for (const node of childNodes(root)) {
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    if (element.nodeName !== "application") continue;
    applicationSeen = true;
    const applicationPermission = trimmed(element, "permission");
    const applicationPermissionBytes =
      applicationPermission === null
        ? null
        : Buffer.byteLength(applicationPermission);
    for (const child of childNodes(element)) {
      if (child.nodeType !== 1) continue;
      const component = child as Element;
      if (!isComponentKind(component.nodeName)) continue;
      // Every declaration counts against the bound, named or not, so an
      // unnamed flood cannot exceed it while still reporting complete.
      if (items.length + unnamed >= ANDROID_MANIFEST_LIMITS.components) {
        truncated = true;
        capacityTruncated = true;
        break;
      }
      const declared = trimmed(component, "name");
      if (declared === null) {
        unnamed += 1;
        continue;
      }
      const filters = childNodes(component).filter(
        (entry): entry is Element =>
          entry.nodeType === 1 && entry.nodeName === "intent-filter",
      );
      const collected = intentValues(filters);
      if (collected.truncated) {
        truncated = true;
        capacityTruncated = true;
      }
      // A huge manifest package would be copied into every resolved name;
      // once the byte budget is spent, later names keep their declared form.
      const containsUnresolvedToken =
        declared.startsWith("@") ||
        declared.startsWith("?") ||
        declared.includes("@") ||
        declared.includes("?") ||
        declared.includes("${");
      const needsPackage = declared.startsWith(".") || !declared.includes(".");
      const packageKnown =
        !containsUnresolvedToken &&
        (!needsPackage || (packageName !== null && !packageHasUnresolvedToken));
      const resolvedBytes = needsPackage
        ? Buffer.byteLength(packageName ?? "") +
          (declared.startsWith(".") ? 0 : 1) +
          Buffer.byteLength(declared)
        : Buffer.byteLength(declared);
      const nameFits = packageKnown && resolvedBytes <= nameBudget;
      const name = nameFits
        ? resolveAndroidComponentName(packageName, declared)
        : declared;
      if (containsUnresolvedToken) unresolvedTokens += 1;
      else if (!packageKnown) unresolvedPackages += 1;
      else if (!nameFits) unresolvedNames += 1;
      else nameBudget -= resolvedBytes;
      let authorities: readonly string[] | null = null;
      if (component.nodeName === "provider") {
        const declaredAuthorities = trimmed(component, "authorities");
        if (declaredAuthorities !== null) {
          const split = providerAuthorities(
            declaredAuthorities,
            authorityBudget,
          );
          if (split.truncated) {
            truncated = true;
            capacityTruncated = true;
          }
          authorityBudget -= split.bytes;
          if (authorityBudget < 0) authorityBudget = 0;
          authorities = split.authorities;
        }
      }
      const declaredPermission = androidAttribute(component, "permission");
      const permissionValue =
        declaredPermission === null
          ? applicationPermission
          : declaredPermission.trim() || null;
      const permissionSource =
        permissionValue === null
          ? "none"
          : declaredPermission === null
            ? "application"
            : "component";
      let permission: string | null = permissionValue;
      let effectivePermissionSource:
        | "component"
        | "application"
        | "none"
        | "unknown" = permissionSource;
      if (permissionValue !== null) {
        // Inherited application permission is the same string for every
        // component. Measure it once at its owning boundary rather than
        // rescanning a potentially large decoded value per inherited copy.
        const permissionBytes =
          declaredPermission === null
            ? (applicationPermissionBytes ?? 0)
            : Buffer.byteLength(permissionValue);
        if (permissionBytes > permissionBudget) {
          permission = null;
          effectivePermissionSource = "unknown";
          truncated = true;
          capacityTruncated = true;
          permissionBudgetLimited = true;
        } else permissionBudget -= permissionBytes;
      }
      const providerDefault =
        component.nodeName === "provider"
          ? providerExportedDefault(targetSdk)
          : null;
      const declaredExported = androidAttribute(component, "exported");
      const exportedLiteral =
        declaredExported === "true"
          ? true
          : declaredExported === "false"
            ? false
            : null;
      const exportedNonliteral =
        declaredExported !== null && exportedLiteral === null;
      const explicitExportRequired =
        declaredExported === null &&
        targetSdkLevel !== null &&
        targetSdkLevel >= 31 &&
        filters.length > 0 &&
        (component.nodeName === "activity" ||
          component.nodeName === "activity-alias" ||
          component.nodeName === "service" ||
          component.nodeName === "receiver");
      const filteredExportUnknown =
        declaredExported === null &&
        targetSdkLevel === null &&
        filters.length > 0 &&
        (component.nodeName === "activity" ||
          component.nodeName === "activity-alias" ||
          component.nodeName === "service" ||
          component.nodeName === "receiver");
      // The default only matters when android:exported is absent.
      if (
        component.nodeName === "provider" &&
        providerDefault === null &&
        declaredExported === null
      )
        providerDefaultsUnknown += 1;
      if (exportedNonliteral) nonliteralExported += 1;
      if (explicitExportRequired) invalidExported += 1;
      if (filteredExportUnknown) unknownFilteredExportDefaults += 1;
      items.push({
        kind: component.nodeName,
        declared_name: declared,
        name,
        exported: exportedLiteral,
        exported_default:
          exportedNonliteral || explicitExportRequired || filteredExportUnknown
            ? null
            : component.nodeName === "provider"
              ? providerDefault
              : filters.length > 0,
        permission,
        permission_source: effectivePermissionSource,
        intent_filter_count: filters.length,
        actions: collected.actions,
        categories: collected.categories,
        foreground_service_type:
          component.nodeName === "service"
            ? trimmed(component, "foregroundServiceType")
            : null,
        authorities,
        target_activity:
          component.nodeName === "activity-alias"
            ? trimmed(component, "targetActivity")
            : null,
      });
    }
  }
  if (!applicationSeen)
    limitations.push(
      "The manifest declares no <application> element, so no components were projected.",
    );
  // Dropped declarations mean the inventory is not the whole manifest.
  if (unnamed > 0) {
    limitations.push(
      `${String(unnamed)} component declaration(s) without android:name are omitted from the inventory.`,
    );
    truncated = true;
  }
  if (providerDefaultsUnknown > 0)
    limitations.push(
      `${String(providerDefaultsUnknown)} provider(s) omit android:exported and the target SDK is unknown, so Android's export default for them is not established.`,
    );
  if (nonliteralExported > 0)
    limitations.push(
      `${String(nonliteralExported)} component declaration(s) set android:exported to a value other than the literals true or false (for example a resource reference), so their effective export state is unknown and the Android default does not apply.`,
    );
  if (unresolvedPackages > 0) {
    limitations.push(
      `${String(unresolvedPackages)} relative component name(s) remain unresolved because the manifest package is absent or contains a resource/placeholder token; the declared name is retained.`,
    );
    truncated = true;
  }
  if (unresolvedTokens > 0) {
    limitations.push(
      `${String(unresolvedTokens)} component name(s) contain an unresolved resource or manifest placeholder token; the declared name is retained without claiming a resolved identity.`,
    );
    truncated = true;
  }
  if (permissionBudgetLimited)
    limitations.push(
      `Projected component permission values are capped at ${String(ANDROID_MANIFEST_LIMITS.permissionBytes)} total bytes; omitted copies have permission_source "unknown".`,
    );
  if (invalidExported > 0) {
    limitations.push(
      `${String(invalidExported)} component(s) with intent filters target API 31 or later and omit android:exported; Android requires an explicit value, so the inventory does not infer a default.`,
    );
  }
  if (unknownFilteredExportDefaults > 0)
    limitations.push(
      `${String(unknownFilteredExportDefaults)} filtered component(s) omit android:exported and the target SDK is unknown, so the applicable export rule is not established.`,
    );
  if (unresolvedNames > 0) {
    limitations.push(
      `${String(unresolvedNames)} component name(s) keep their declared form because the resolved-name byte budget (${String(ANDROID_MANIFEST_LIMITS.resolvedNameBytes)}) was exhausted.`,
    );
    truncated = true;
  }
  if (capacityTruncated)
    limitations.push(
      `The component inventory reached a capacity limit: ${String(ANDROID_MANIFEST_LIMITS.components)} declarations, ${String(ANDROID_MANIFEST_LIMITS.intentFilters)} filters or ${String(ANDROID_MANIFEST_LIMITS.intentValues)} values per component, ${String(ANDROID_MANIFEST_LIMITS.authorities)} authorities per provider, ${String(ANDROID_MANIFEST_LIMITS.authorityBytes)} total authority bytes, or ${String(ANDROID_MANIFEST_LIMITS.permissionBytes)} total permission bytes.`,
    );
  return {
    status: truncated ? "partial" : "complete",
    items,
    limitations,
  };
};
