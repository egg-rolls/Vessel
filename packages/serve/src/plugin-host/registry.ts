/**
 * 动态 RPC 注册表（CONTRACT-0.43 §2.4）。
 *
 * plugin 只能注册 `plugin.<id>.<name>`；`id` / `name` 各有独立正则，宿主拼名，
 * 不允许 plugin 自带点号或直接写全名。方法在 activate 时加入、deactivate 时删除，
 * 静态方法表不受影响。
 *
 * @module @vessel-agent/serve/plugin-host
 */

import { type RpcDynamicMethodSource, RpcError, type RpcMethodDefinition } from '../rpc.js';
import { jsonByteLength, jsonDtoViolation, MAX_PLUGIN_MESSAGE_BYTES } from './dto.js';
import { PluginHostError, pluginError } from './errors.js';
import type { PluginRpcContribution } from './types.js';

/** manifest id 规则（contract §1） */
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** rpc 方法名规则（contract §1：不能带点） */
export const PLUGIN_METHOD_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** 拼出 canonical 方法名；非法输入抛 `plugin_manifest_invalid`。 */
export function pluginRpcName(pluginId: string, name: string): string {
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    throw pluginError('plugin_manifest_invalid', `Invalid plugin id: ${pluginId}`);
  }
  if (!PLUGIN_METHOD_NAME_PATTERN.test(name)) {
    throw pluginError('plugin_manifest_invalid', `Invalid plugin rpc name: ${name}`, { name });
  }
  return `plugin.${pluginId}.${name}`;
}

export type PluginRpcHandler = (name: string, params: Record<string, unknown>) => Promise<unknown>;

interface Registration {
  pluginId: string;
  handler: PluginRpcHandler;
  names: string[];
}

function toRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  if (error instanceof PluginHostError) {
    if (error.code === 'plugin_payload_too_large') {
      return new RpcError('invalid_params', 'Plugin payload exceeds 1 MiB.', {
        plugin_error: error.code,
        ...error.details,
      });
    }
    return new RpcError('internal', error.message, {
      plugin_error: error.code,
      ...error.details,
    });
  }
  return new RpcError('internal', error instanceof Error ? error.message : String(error), {
    plugin_error: 'plugin_rpc_failed',
  });
}

function validateParams(params: Record<string, unknown>, method: string): void {
  const violation = jsonDtoViolation(params, 'params');
  if (violation !== null) {
    throw new RpcError('invalid_params', `Invalid JSON DTO: ${violation}`, { method });
  }
  if (jsonByteLength(params) > MAX_PLUGIN_MESSAGE_BYTES) {
    throw new RpcError('invalid_params', 'Plugin payload exceeds 1 MiB.', {
      method,
      plugin_error: 'plugin_payload_too_large',
    });
  }
}

function validateResult(result: unknown, method: string): void {
  const violation = jsonDtoViolation(result, 'result');
  if (violation !== null) {
    throw new RpcError('internal', 'Plugin returned a non-JSON DTO.', {
      method,
      plugin_error: 'plugin_rpc_denied',
      detail: violation,
    });
  }
  if (jsonByteLength(result) > MAX_PLUGIN_MESSAGE_BYTES) {
    throw new RpcError('internal', 'Plugin payload exceeds 1 MiB.', {
      method,
      plugin_error: 'plugin_payload_too_large',
    });
  }
}

/** 动态方法源：dispatcher 静态表未命中时回退到这里。 */
export class PluginRpcRegistry implements RpcDynamicMethodSource {
  private readonly byName = new Map<
    string,
    { pluginId: string; definition: RpcMethodDefinition }
  >();
  private readonly byPlugin = new Map<string, Registration>();

  /** 注册一组方法；任何校验失败都不产生部分注册。 */
  register(
    pluginId: string,
    methods: readonly PluginRpcContribution[],
    handler: PluginRpcHandler,
  ): string[] {
    if (!PLUGIN_ID_PATTERN.test(pluginId)) {
      throw pluginError('plugin_manifest_invalid', `Invalid plugin id: ${pluginId}`);
    }
    if (this.byPlugin.has(pluginId)) {
      throw pluginError('plugin_id_conflict', `Plugin rpc already registered: ${pluginId}`);
    }
    const names: string[] = [];
    const definitions: Array<{ fullName: string; definition: RpcMethodDefinition }> = [];
    const seen = new Set<string>();
    for (const method of methods) {
      if (typeof method.name !== 'string' || !PLUGIN_METHOD_NAME_PATTERN.test(method.name)) {
        throw pluginError(
          'plugin_manifest_invalid',
          `Invalid plugin rpc name: ${String(method.name)}`,
          {
            pluginId,
          },
        );
      }
      if (seen.has(method.name)) {
        throw pluginError('plugin_manifest_invalid', `Duplicate plugin rpc name: ${method.name}`, {
          pluginId,
        });
      }
      seen.add(method.name);
      const fullName = pluginRpcName(pluginId, method.name);
      if (this.byName.has(fullName)) {
        throw pluginError('plugin_id_conflict', `RPC method already registered: ${fullName}`);
      }
      // 运行期复检：loader 注入的 JS 对象可能绕过 TS 联合类型。
      const permission = method.permission ?? 'read';
      if (permission !== 'read' && permission !== 'write' && permission !== 'admin') {
        throw pluginError(
          'plugin_manifest_invalid',
          `Invalid rpc permission: ${String(permission)}`,
          {
            pluginId,
            method: method.name,
          },
        );
      }
      const definition: RpcMethodDefinition = {
        name: fullName,
        permission,
        handler: async (params) => {
          validateParams(params, fullName);
          try {
            const result = await handler(method.name, params);
            validateResult(result, fullName);
            return result;
          } catch (error) {
            throw toRpcError(error);
          }
        },
      };
      names.push(fullName);
      definitions.push({ fullName, definition });
    }
    if (names.length === 0) return [];
    this.byPlugin.set(pluginId, { pluginId, handler, names });
    for (const item of definitions)
      this.byName.set(item.fullName, { pluginId, definition: item.definition });
    return names;
  }

  /** 删除该 plugin 的全部方法；返回删除数量。幂等。 */
  unregister(pluginId: string): number {
    const registration = this.byPlugin.get(pluginId);
    if (registration === undefined) return 0;
    for (const name of registration.names) this.byName.delete(name);
    this.byPlugin.delete(pluginId);
    return registration.names.length;
  }

  /** 该 plugin 注册的方法名（canonical）。 */
  namesFor(pluginId: string): readonly string[] {
    return this.byPlugin.get(pluginId)?.names ?? [];
  }

  resolve(name: string): RpcMethodDefinition | undefined {
    return this.byName.get(name)?.definition;
  }

  list(): RpcMethodDefinition[] {
    return [...this.byName.values()].map((item) => item.definition);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  get size(): number {
    return this.byName.size;
  }

  clear(): void {
    this.byName.clear();
    this.byPlugin.clear();
  }
}
