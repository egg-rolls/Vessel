/**
 * per-capability 插件生命周期推导（q-plugin-lifecycle §6.1）。
 *
 * 真源是**宿主 install 期注册面审计**，不是插件自报：第三方插件可能谎报 hot，
 * 宿主只信自己实际看到的注册行为。manifest 的 `lifecycle` 声明只允许比推导**更保守**
 * （插件作者知道宿主看不见的副作用）；谎报 hot（声明 hot 而推导 restart）→ warn 一次
 * + 生效值取 restart（fail-honest）。
 *
 * 不做二元 `lifecycle: hot|restart`：同一插件的不同能力生命周期不同（child 启停热 /
 * settings 曾重启；in-process 工具热 / provider 注册面重启）。per-capability 才不撒谎。
 *
 * @module vessel/plugin-lifecycle
 */

import type { PluginSurfaceKind } from '../../packages/core/src/index';

/** 单个能力的生效方式：hot = 热应用即生效；restart = 需重启 gateway。 */
export type PluginLifecycleMode = 'hot' | 'restart';

/** per-capability 生命周期（toggle = enabled 翻转含其全部注册面；settings = plugins[].config；code = 磁盘代码）。 */
export interface PluginLifecycle {
  toggle: PluginLifecycleMode;
  settings: PluginLifecycleMode;
  code: PluginLifecycleMode;
}

/**
 * 热应用路径能**完整按名差量增删**的注册面集合（生命周期推导的唯一能力判据）。
 *
 * 这是「能热的真热」的机制边界：一个 in-process 插件的 toggle 为 hot，当且仅当它
 * install 登记的**每一个**注册面都在本集合里（热应用能把它整体摘干净 / 重建）。
 * provider 面永不入集（R-D 结构性：provider 实例启动期构造进 runtime，不可热替换）。
 *
 * 注销 API（unregisterHook/Guardrail/Provider/ReadSideMasker）+ 注册面差量
 * （applyRegistrations）+ fresh 实例采纳 / dispose 落地后，tool / hook / guardrail /
 * readSideMasker 都可整体热差量；provider 仍永不入集（结构性 restart）。memberBody
 * 贡献由成员 spawn 消费、不在节点热差量域，注册它的插件保守 restart。
 */
export const HOT_DIFFABLE_SURFACES: ReadonlySet<PluginSurfaceKind> = new Set<PluginSurfaceKind>([
  'tool',
  'hook',
  'guardrail',
  'readSideMasker',
]);

export interface LifecycleDerivationInput {
  /** 插件规范名（warn 去重用）。 */
  name: string;
  mode: 'in-process' | 'child';
  /** install 期实际登记的注册面（宿主审计）；缺省 = 未审计（工厂 / provider 走结构判据）。 */
  surfaces?: ReadonlySet<PluginSurfaceKind>;
  /** 工厂式插件（bootstrap 按专用配置构造，不走通用装载，启动期一次性接线）。 */
  isFactory?: boolean;
  /** 发现分类（`provider` 类结构性 restart）。 */
  category?: string;
  /** manifest `vessel.lifecycle` 声明（只允许更保守）。 */
  declared?: Partial<PluginLifecycle>;
  /** child settings 热应用是否已接线（settingsFor 读 liveConfig + settings 进指纹）。 */
  childSettingsHot?: boolean;
  /** 告警出口（缺省 console.warn）；谎报 hot 只报一次。 */
  warn?: (message: string) => void;
}

/** 谎报 hot 的去重键（进程级 once，不因 catalog 反复读取刷屏）。 */
const warnedFalseHot = new Set<string>();

/**
 * 推导 per-capability 生命周期。纯函数（除 once 告警）；catalog / CLI / 热应用共用。
 *
 * 规则（对应设计 §2.4 根因）：
 * - code：in-process 恒 restart（R-F ESM 模块缓存，物理约束）；child hot（version bump 触发重激活）。
 * - settings：in-process hot（targetKey 识别配置变化 → 管辖注册面整体刷新）；
 *   child 取决于 childSettingsHot（未接线时 spawn 期 env 钉死 → restart，R-G）。
 * - toggle：child hot（进程边界天然隔离，manager.reload 全链）；工厂 / provider 类 restart
 *   （R-D/R-E 启动期接线）；其余 in-process 看审计——全部注册面可热差量才 hot。
 */
export function derivePluginLifecycle(input: LifecycleDerivationInput): PluginLifecycle {
  const { name, mode, surfaces, isFactory, category, declared } = input;
  const warn = input.warn ?? ((message: string) => console.warn(message));

  const code: PluginLifecycleMode = mode === 'child' ? 'hot' : 'restart';
  const settings: PluginLifecycleMode =
    mode === 'child' ? (input.childSettingsHot === true ? 'hot' : 'restart') : 'hot';

  let toggle: PluginLifecycleMode;
  if (mode === 'child') {
    toggle = 'hot';
  } else if (isFactory === true || category === 'provider') {
    toggle = 'restart';
  } else if (surfaces === undefined) {
    // 未审计（无 install 记录）：不假装能热，保守 restart。
    toggle = 'restart';
  } else {
    toggle = [...surfaces].every((kind) => HOT_DIFFABLE_SURFACES.has(kind)) ? 'hot' : 'restart';
  }

  const reconcile = (
    capability: keyof PluginLifecycle,
    derived: PluginLifecycleMode,
  ): PluginLifecycleMode => {
    const claim = declared?.[capability];
    if (claim === undefined) return derived;
    // 声明 restart：采纳（插件作者知道宿主看不见的副作用，只允许更保守）。
    if (claim === 'restart') return 'restart';
    // 声明 hot 而推导 restart：fail-honest —— warn 一次 + 取 restart。
    if (derived === 'restart') {
      const key = `${name}:${capability}`;
      if (!warnedFalseHot.has(key)) {
        warnedFalseHot.add(key);
        warn(
          `[plugin_lifecycle] "${name}" declares lifecycle.${capability}=hot but the host derives ` +
            'restart (registration surface not hot-diffable); honoring restart (fail-honest).',
        );
      }
      return 'restart';
    }
    return 'hot';
  };

  return {
    toggle: reconcile('toggle', toggle),
    settings: reconcile('settings', settings),
    code: reconcile('code', code),
  };
}

/** lifecycle 是否全 hot（无 pending 时面板可显示「即时生效」）。 */
export function isFullyHot(lifecycle: PluginLifecycle): boolean {
  return lifecycle.toggle === 'hot' && lifecycle.settings === 'hot' && lifecycle.code === 'hot';
}
