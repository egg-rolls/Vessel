/**
 * 命令视图数据模型——纯数据，命令层与 Ink 层共用
 * @module @vessel/tui
 *
 * 设计约束：
 * - 本文件与 commands/** 不 import Ink/React；视图可 JSON 化、可直接单测。
 * - 命令仍返回 `output` 文本；`view` 是 Ink 模式的增强，simple mode 忽略。
 * - 动作（Enter / r / x ...）由命令注册表的 `viewAction` 处理，渲染层不做 RPC。
 */

export type ViewTone = 'default' | 'muted' | 'ok' | 'warn' | 'danger' | 'info' | 'brand';

export interface ViewColumn {
  /** ViewRow.cells 的 key */
  key: string;
  header: string;
  /** 固定显示宽度；省略 = flex。单位是终端列，不是字符数 */
  width?: number;
  minWidth?: number;
  align?: 'left' | 'right';
  /** 1 = 任何宽度；2 = >=100 列；3 = >=120 列 */
  priority?: 1 | 2 | 3;
}

export interface ViewRow {
  /** 稳定 key（通常是实体 id），用于保持选中项 */
  key: string;
  cells: Record<string, string>;
  tone?: ViewTone;
  /** 当前会话 / 当前 run 等 */
  current?: boolean;
}

export interface ViewAction {
  /** 稳定 id：'resume' | 'delete' | 'rename' | 'cancel' | 'refresh' | 'reconnect' | ... */
  id: string;
  /** 触发键：'enter' | 'x' | 'r' | 't' | 's' ... */
  key: string;
  label: string;
  tone?: 'default' | 'danger';
  /** selected = 必须选中行；not-current = 当前行不可用；缺省 always */
  enabled?: 'always' | 'selected' | 'not-current';
  /** 需要二次确认时的文案模板；{name} 用选中行标题替换 */
  confirm?: string;
  /** 进入输入模式时预填的 cells key（rename） */
  inputFrom?: string;
}

export interface TableView {
  kind: 'table';
  title: string;
  columns: ViewColumn[];
  rows: ViewRow[];
  actions?: ViewAction[];
  /** 打开时默认选中；缺省第一行 */
  initialKey?: string;
  emptyText?: string;
  /** 标题右侧的计数 / 过滤说明 */
  meta?: string;
  /**
   * 视图上下文（如 /trace 的 run_id、/config 的 detail|sources）。
   * 渲染层不解释它，只在 viewAction 调用时作为 `viewKey` 回传。
   */
  key?: string;
}

export interface ListView {
  kind: 'list';
  title: string;
  items: Array<{
    key: string;
    label: string;
    description?: string;
    tone?: ViewTone;
    badge?: string;
    current?: boolean;
  }>;
  actions?: ViewAction[];
  initialKey?: string;
  emptyText?: string;
  /** 视图上下文；同 TableView.key */
  key?: string;
}

export interface DetailField {
  label: string;
  value: string;
  tone?: ViewTone;
}

export interface DetailSection {
  title?: string;
  fields?: DetailField[];
  /** 原样多行（已由命令层截断/脱敏） */
  lines?: string[];
  /** true = 预排版行（如步骤表），渲染时截断而不是换行，避免破坏列对齐 */
  preformatted?: boolean;
}

export interface DetailView {
  kind: 'detail';
  title: string;
  badge?: { text: string; tone: ViewTone };
  sections: DetailSection[];
  actions?: ViewAction[];
  /**
   * 详情对应的实体 key（如 workflow_run_id / tenant_id / tool name）。
   * 详情没有行选中，viewAction 用它作为 `selectionKey` 的等价物。
   */
  key?: string;
}

export interface FormField {
  key: string;
  label: string;
  value: string;
  placeholder?: string;
  required?: boolean;
}

export interface FormView {
  kind: 'form';
  title: string;
  fields: FormField[];
  submit: { id: string; label: string };
  cancel?: { id: string; label: string };
}

export interface ConfirmView {
  kind: 'confirm';
  title: string;
  message: string;
  details?: string[];
  confirm: { id: string; label: string; tone?: 'danger' };
  cancel: { id: string; label: string };
}

export type CommandView = TableView | ListView | DetailView | FormView | ConfirmView;

/** 视图来自哪个命令；action 路由用 */
export interface ViewEnvelope {
  source: string;
  view: CommandView;
  status?: 'ready' | 'loading' | 'error';
  error?: string;
}

/** 视图内交互模式（与 ReplUiState 的 ActiveViewState.mode 同构） */
export type ViewMode = 'browse' | 'filter' | 'rename' | 'confirm' | 'form';

/** 视图动作结果的调用参数（注册表 viewAction 的入参） */
export interface ViewActionInvocation {
  actionId: string;
  /** 选中行/项的稳定 key；无选中时为空串 */
  selectionKey: string;
  /** rename/form 的输入值 */
  value?: string;
  /** 触发动作时的视图类型（用于同一命令内 table/detail 分支，如 /config 的 s） */
  viewKind?: CommandView['kind'];
  /** 视图自带上下文（TableView.key / ListView.key / DetailView.key） */
  viewKey?: string;
}

/** 当前视图的 actions；缺省空数组 */
export function viewActions(view: CommandView): ViewAction[] {
  return 'actions' in view && view.actions ? view.actions : [];
}

/**
 * 动作在选中行上是否可用。
 * - selected：必须有选中行
 * - not-current：选中行不能是 current
 * - always：总是可用（缺省）
 */
export function isViewActionEnabled(action: ViewAction, row: ViewRow | null | undefined): boolean {
  switch (action.enabled ?? 'always') {
    case 'selected':
      return row !== null && row !== undefined;
    case 'not-current':
      return row !== null && row !== undefined && row.current !== true;
    default:
      return true;
  }
}

/** 用于 {name} 替换的展示名：title > name > key */
export function rowDisplayName(row: ViewRow | null | undefined): string {
  if (!row) return '';
  return row.cells.title || row.cells.name || row.cells.label || row.key;
}

/** 把动作的 confirm 模板展开成最终文案（{name} 用选中行展示名替换） */
export function formatConfirmMessage(action: ViewAction, row: ViewRow | null | undefined): string {
  return (action.confirm ?? '').replace(/\{name\}/g, rowDisplayName(row));
}

/** 按触发键查找动作（actions 中 key 唯一） */
export function findActionByKey(actions: ViewAction[], key: string): ViewAction | undefined {
  return actions.find((action) => action.key === key);
}
