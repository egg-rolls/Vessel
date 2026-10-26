/**
 * Team domain store: per-node team lists and team detail / members windows.
 *
 * Detail state is keyed by `node:team:variant` so the summary used by the
 * detail header (`limit=1`) never clobbers the chat window's member/message
 * limits. Lists are keyed by node and shared by the Teams page and node rows.
 */
import { create } from 'zustand';
import type { NodeView } from '../gateway/NodeProvider';
import { nodeKeyOf } from '../gateway/nodes';
import type { TeamControl } from '../gateway/team-control';
import { fetchNodeTeams, type NodeTeams } from '../gateway/team-roster';
import type {
  TeamCreateInput,
  TeamDetail,
  TeamPostResult,
  TeamSummary,
  TeamUpdateInput,
} from '../gateway/types';
import { type ResourceState, resourceData } from '../state/useResource';
import {
  beginStoreLoad,
  isCurrentGeneration,
  nextGeneration,
  storeFailure,
  storeSuccess,
} from './store-resource';

/** Which consumer owns a detail window (prevents limit clobbering). */
export type TeamDetailVariant = 'summary' | 'chat' | 'member';

export interface TeamDetailOptions {
  limit?: number;
  members_limit?: number;
}

interface TeamStoreState {
  lists: Record<string, ResourceState<NodeTeams>>;
  details: Record<string, ResourceState<TeamDetail>>;
  loadList: (node: NodeView, control: TeamControl) => Promise<void>;
  loadAllLists: (
    nodes: readonly NodeView[],
    teamControl: (node: NodeView) => TeamControl,
  ) => Promise<void>;
  loadDetail: (
    nodeKey: string,
    teamId: string,
    control: Pick<TeamControl, 'getTeam'>,
    options?: TeamDetailOptions,
    variant?: TeamDetailVariant,
  ) => Promise<void>;
  post: (
    control: Pick<TeamControl, 'postTeam'>,
    input: { team_id: string; content: string; mentions?: string[] },
  ) => Promise<TeamPostResult>;
  update: (
    control: Pick<TeamControl, 'updateTeam'>,
    input: TeamUpdateInput,
  ) => Promise<TeamSummary>;
  create: (
    control: Pick<TeamControl, 'createTeam'>,
    input: TeamCreateInput,
  ) => Promise<TeamSummary>;
  archive: (control: Pick<TeamControl, 'archiveTeam'>, teamId: string) => Promise<TeamSummary>;
  setSpawnFrozen: (
    control: Pick<TeamControl, 'setSpawnFrozen'>,
    teamId: string,
    frozen: boolean,
  ) => Promise<TeamSummary>;
  reset: () => void;
}

export function teamDetailKey(nodeKey: string, teamId: string, variant: TeamDetailVariant): string {
  return `${nodeKey}:${teamId}:${variant}`;
}

function listGenerationKey(nodeKey: string): string {
  return `team:list:${nodeKey}`;
}

function detailGenerationKey(key: string): string {
  return `team:detail:${key}`;
}

export const useTeamStore = create<TeamStoreState>()((set, get) => ({
  lists: {},
  details: {},

  loadList: async (node, control) => {
    const key = nodeKeyOf(node);
    const previous = get().lists[key];
    const generation = nextGeneration(listGenerationKey(key));
    set((state) => ({ lists: { ...state.lists, [key]: beginStoreLoad(previous) } }));
    try {
      const result = await fetchNodeTeams(node, control);
      if (!isCurrentGeneration(listGenerationKey(key), generation)) return;
      set((state) => ({ lists: { ...state.lists, [key]: storeSuccess(result) } }));
    } catch (error) {
      if (!isCurrentGeneration(listGenerationKey(key), generation)) return;
      set((state) => ({ lists: { ...state.lists, [key]: storeFailure(previous, error) } }));
    }
  },

  loadAllLists: async (nodes, teamControl) => {
    await Promise.all(nodes.map((node) => get().loadList(node, teamControl(node))));
  },

  loadDetail: async (nodeKey, teamId, control, options = {}, variant = 'chat') => {
    const key = teamDetailKey(nodeKey, teamId, variant);
    const previous = get().details[key];
    const generation = nextGeneration(detailGenerationKey(key));
    set((state) => ({ details: { ...state.details, [key]: beginStoreLoad(previous) } }));
    try {
      const data = await control.getTeam(teamId, options);
      if (!isCurrentGeneration(detailGenerationKey(key), generation)) return;
      set((state) => ({ details: { ...state.details, [key]: storeSuccess(data) } }));
    } catch (error) {
      if (!isCurrentGeneration(detailGenerationKey(key), generation)) return;
      set((state) => ({ details: { ...state.details, [key]: storeFailure(previous, error) } }));
    }
  },

  post: (control, input) => control.postTeam(input),
  update: (control, input) => control.updateTeam(input),
  create: (control, input) => control.createTeam(input),
  archive: (control, teamId) => control.archiveTeam(teamId),
  setSpawnFrozen: (control, teamId, frozen) => control.setSpawnFrozen(teamId, frozen),

  reset: () => {
    set({ lists: {}, details: {} });
  },
}));

/** Read a team list entry without subscribing to unrelated nodes. */
export function useTeamListState(
  node: Pick<NodeView, 'name' | 'nodeId'>,
): ResourceState<NodeTeams> | undefined {
  return useTeamStore((state) => state.lists[nodeKeyOf(node)]);
}

export function teamListData(state: ResourceState<NodeTeams> | undefined): NodeTeams | undefined {
  return state === undefined ? undefined : resourceData(state);
}
