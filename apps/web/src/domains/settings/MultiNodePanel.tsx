/**
 * Settings → Connection：多节点（只读，S9.4）。
 *
 * 节点元数据与 token 都只在 sessionStorage；token 输入 type=password，添加后不回显。
 * 状态来自 `health.get`，Team 列表按需调用 `teams.list`（只读，不用 federation team-info）。
 */
import { type FormEvent, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { useToast } from '../../components/ToastProvider';
import { useConnection } from '../../gateway/ConnectionProvider';
import { type NodeView, useNodes } from '../../gateway/NodeProvider';
import type { NodeDraftError } from '../../gateway/nodes';
import { displayGatewayUrl } from '../../gateway/url';
import { t, useLocale } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';

function pageOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

function NodeCard({ node, onRemove }: { node: NodeView; onRemove?: () => void }) {
  useLocale();
  const { epoch } = useConnection();
  const { fetchHealth, fetchTeams } = useNodes();
  const [showTeams, setShowTeams] = useState(false);

  const health = useResource({
    load: () => fetchHealth(node),
    deps: [node.name, node.url, epoch],
    pollMs: 15_000,
  });
  const teams = useResource({
    load: () => fetchTeams(node),
    enabled: showTeams,
    deps: [node.name, node.url, epoch, showTeams],
  });

  const info = resourceData(health.state);
  const healthError = health.state.status === 'error' ? health.state.error : null;
  const teamsData = resourceData(teams.state);
  const teamsError = teams.state.status === 'error' ? teams.state.error : null;

  return (
    <div className="multi-node-card">
      <div className="multi-node-head">
        <span className="multi-node-name">{node.name}</span>
        {node.current && (
          <span className="multi-node-badge">{t('settings.multinode.current')}</span>
        )}
        <span className="mono dim multi-node-url">{displayGatewayUrl(node.url, pageOrigin())}</span>
        {onRemove && (
          <button type="button" className="btn btn-small btn-danger-ghost" onClick={onRemove}>
            {t('settings.multinode.remove')}
          </button>
        )}
      </div>

      <p className="multi-node-status mono">
        {info
          ? `${t('settings.multinode.healthOk')} · ${info.node.node_id} · ${info.node.role}`
          : healthError
            ? `${t('settings.multinode.healthError')}: ${healthError}`
            : t('settings.multinode.healthLoading')}
      </p>

      <div className="multi-node-actions">
        <button
          type="button"
          className="btn btn-small"
          onClick={() => setShowTeams(true)}
          disabled={showTeams && teams.state.status === 'loading'}
        >
          {t('settings.multinode.loadTeams')}
        </button>
      </div>

      {showTeams &&
        (teamsError ? (
          <p className="field-error" role="alert">
            {t('settings.multinode.teamsError')}: {teamsError}
          </p>
        ) : teamsData ? (
          teamsData.length === 0 ? (
            <p className="dim">{t('settings.multinode.teamsEmpty')}</p>
          ) : (
            <ul className="multi-node-teams">
              {teamsData.map((team) => (
                <li key={team.team_id}>
                  <span className="mono">{team.team_id}</span> · {team.name} ·{' '}
                  {team.online_count ?? '—'}/{team.member_count}
                </li>
              ))}
            </ul>
          )
        ) : (
          <p className="dim">{t('settings.multinode.teamsLoading')}</p>
        ))}
    </div>
  );
}

export function MultiNodePanel() {
  useLocale();
  const toast = useToast();
  const { nodes, addNode, removeNode, refresh } = useNodes();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<NodeDraftError | null>(null);

  useRefreshSignal(refresh);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const submittedName = name.trim();
    const result = addNode({ name, url, token });
    if (!result.ok) {
      setError(result.error ?? null);
      return;
    }
    setError(null);
    setName('');
    setUrl('');
    setToken('');
    toast.info(t('settings.multinode.added', { name: submittedName }));
  };

  return (
    <section className="panel">
      <h2 className="section-title">{t('settings.multinode.title')}</h2>
      <p className="section-desc">{t('settings.multinode.desc')}</p>

      <form className="form-grid" onSubmit={submit}>
        <label className="field">
          <span className="field-label">{t('settings.multinode.name')}</span>
          <input
            className={`input ${error === 'name_required' || error === 'name_duplicate' ? 'invalid' : ''}`.trim()}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            placeholder={t('settings.multinode.namePlaceholder')}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span className="field-label">{t('settings.multinode.url')}</span>
          <input
            className={`input ${error === 'url_invalid' ? 'invalid' : ''}`.trim()}
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setError(null);
            }}
            placeholder={t('settings.multinode.urlPlaceholder')}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span className="field-label">{t('settings.multinode.token')}</span>
          <input
            className={`input ${error === 'token_required' ? 'invalid' : ''}`.trim()}
            type="password"
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              setError(null);
            }}
            placeholder={t('settings.multinode.tokenPlaceholder')}
            spellCheck={false}
            autoComplete="new-password"
          />
        </label>
        <div className="form-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!name.trim() || !token.trim()}
          >
            {t('settings.multinode.add')}
          </button>
        </div>
      </form>

      {error && (
        <p className="field-error" role="alert">
          {t(`settings.multinode.error.${error}`)}
        </p>
      )}
      <p className="field-hint">{t('settings.multinode.storageHint')}</p>
      <p className="field-hint">{t('settings.multinode.hubHint')}</p>

      <div className="multi-node-list">
        {nodes.length === 0 ? (
          <p className="dim">{t('settings.multinode.noNodes')}</p>
        ) : (
          nodes.map((node) => (
            <NodeCard
              key={`${node.current ? 'current' : 'extra'}:${node.name}`}
              node={node}
              {...(node.current ? {} : { onRemove: () => removeNode(node.name) })}
            />
          ))
        )}
      </div>
    </section>
  );
}
