/**
 * Agent domain store: the cross-node roster (teams + members) and the agent
 * currently opened from the list. Roster entries carry each agent's engine
 * state / session id, which is the run/session summary shown by the list.
 */
import { create } from 'zustand';
import type { NodeView } from '../gateway/NodeProvider';
import { nodeKeyOf } from '../gateway/nodes';
import type { TeamControl } from '../gateway/team-control';
import {
  fetchNodeRoster,
  mergeNodeRosters,
  type NodeRoster,
  type RosterAgent,
} from '../gateway/team-roster';
import { type ResourceState, resourceData } from '../state/useResource';
import {
  beginStoreLoad,
  invalidateGeneration,
  isCurrentGeneration,
  nextGeneration,
  storeFailure,
  storeSuccess,
} from './store-resource';

interface AgentStoreState {
  roster: ResourceState<readonly NodeRoster[]>;
  /** Last agent opened from the roster; route still wins for deep links. */
  currentAgentId: string | null;
  loadRoster: (
    nodes: readonly NodeView[],
    teamControl: (node: NodeView) => TeamControl,
  ) => Promise<void>;
  selectAgent: (agentId: string | null) => void;
  reset: () => void;
}

const ROSTER_KEY = 'agent:roster';

export const useAgentStore = create<AgentStoreState>()((set, get) => ({
  roster: { status: 'idle' },
  currentAgentId: null,

  loadRoster: async (nodes, teamControl) => {
    if (nodes.length === 0) {
      set({ roster: storeSuccess([]) });
      return;
    }
    const previous = get().roster;
    const previousRosters = resourceData(previous) ?? [];
    const generation = nextGeneration(ROSTER_KEY);
    set({ roster: beginStoreLoad(previous) });
    try {
      const next = await Promise.all(nodes.map((node) => fetchNodeRoster(node, teamControl(node))));
      if (!isCurrentGeneration(ROSTER_KEY, generation)) return;
      // Single-node failure keeps its previous successful roster (no empty flicker).
      set({ roster: storeSuccess(mergeNodeRosters(previousRosters, next)) });
    } catch (error) {
      if (!isCurrentGeneration(ROSTER_KEY, generation)) return;
      set({ roster: storeFailure(previous, error) });
    }
  },

  selectAgent: (agentId) => set({ currentAgentId: agentId }),

  reset: () => {
    invalidateGeneration(ROSTER_KEY);
    set({ roster: { status: 'idle' }, currentAgentId: null });
  },
}));

export function findRosterAgent(
  rosters: readonly NodeRoster[],
  nodeKey: string,
  agentId: string,
): RosterAgent | undefined {
  for (const roster of rosters) {
    if (nodeKeyOf(roster.node) !== nodeKey) continue;
    for (const entry of roster.rosters) {
      const member = entry.members.find((item) => item.agent_id === agentId);
      if (member) return { node: roster.node, team: entry.team, member };
    }
  }
  return undefined;
}
