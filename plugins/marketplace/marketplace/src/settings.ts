/**
 * Plugin settings parsing (CONTRACT-0.44 §3).
 *
 * `registry_url` is declared required, but activation still succeeds without
 * it: the UI needs to load to show "configure registry_url" instead of the
 * whole page disappearing behind `plugin_activation_failed`.
 *
 * `vessel_version` is an optional pass-through used by the install-time
 * engines check (CONTRACT-0.44 §3 step 5). It is deliberately not rendered as
 * a user setting: the host/loader is the source of truth when it is absent.
 *
 * @module @vessel-agent/plugin-marketplace/settings
 */

export const DEFAULT_REGISTRY_URL = 'https://egg-rolls.github.io/vessel-plugins/index.json';

export type InstallScope = 'user' | 'project';

export interface MarketplaceSettings {
  /** `undefined` when unset; RPCs then fail with `registry_url_missing`. */
  registryUrl?: string;
  proxy?: string;
  installScope: InstallScope;
  allowPrerelease: boolean;
  /** Absolute project root for `install_scope: project` (Errata E4). */
  projectRoot?: string;
  /** Optional current Vessel version for install-time `engines.vessel` checks. */
  vesselVersion?: string;
}

export interface ParsedSettings {
  settings: MarketplaceSettings;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(
  raw: Record<string, unknown>,
  key: string,
  warnings: string[],
): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    warnings.push(`${key} must be a non-empty string; ignored`);
    return undefined;
  }
  return value.trim();
}

/** Parse `plugin.activate.params.settings`. Invalid values fall back with a warning. */
export function parseSettings(raw: unknown): ParsedSettings {
  const warnings: string[] = [];
  const object = isRecord(raw) ? raw : {};
  if (raw !== undefined && !isRecord(raw))
    warnings.push('settings must be an object; using defaults');

  const registryUrl = optionalString(object, 'registry_url', warnings);
  if (registryUrl === undefined) {
    warnings.push('registry_url is required; set it in config.yaml plugins[].config');
  }

  const proxy = optionalString(object, 'proxy', warnings);

  let installScope: InstallScope = 'user';
  const scopeRaw = object.install_scope;
  if (scopeRaw !== undefined && scopeRaw !== null) {
    if (scopeRaw === 'user' || scopeRaw === 'project') {
      installScope = scopeRaw;
    } else {
      warnings.push("install_scope must be 'user' or 'project'; using 'user'");
    }
  }

  let allowPrerelease = false;
  const prereleaseRaw = object.allow_prerelease;
  if (prereleaseRaw !== undefined && prereleaseRaw !== null) {
    if (typeof prereleaseRaw === 'boolean') {
      allowPrerelease = prereleaseRaw;
    } else {
      warnings.push('allow_prerelease must be a boolean; using false');
    }
  }

  const projectRoot = optionalString(object, 'project_root', warnings);
  const vesselVersion = optionalString(object, 'vessel_version', warnings);

  return {
    settings: {
      ...(registryUrl !== undefined ? { registryUrl } : {}),
      ...(proxy !== undefined ? { proxy } : {}),
      installScope,
      allowPrerelease,
      ...(projectRoot !== undefined ? { projectRoot } : {}),
      ...(vesselVersion !== undefined ? { vesselVersion } : {}),
    },
    warnings,
  };
}
