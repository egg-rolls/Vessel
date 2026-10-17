import { describe, expect, it } from 'bun:test';
import { reduceUpdateState } from '../src/components/UpdateBanner.js';
import type { TuiEvent, UpdateAvailableData } from '../src/types/events.js';

function updateEvent(data: UpdateAvailableData): TuiEvent {
  return {
    type: 'update.available',
    run_id: '',
    data,
    ts: 1,
  } as TuiEvent;
}

const info: UpdateAvailableData = {
  current: '0.1.0',
  latest: '0.1.1',
  channel: 'latest',
  installHint: 'npm i -g vessel@latest',
};

describe('reduceUpdateState', () => {
  it('无事件保持 null', () => {
    const state = reduceUpdateState({ info: null }, { type: 'run.started' } as TuiEvent);
    expect(state.info).toBeNull();
  });

  it('收到事件后保存提示信息', () => {
    expect(reduceUpdateState({ info: null }, updateEvent(info)).info).toEqual(info);
  });

  it('同一版本/通道重复事件不改变引用（避免重复渲染）', () => {
    const first = reduceUpdateState({ info: null }, updateEvent(info));
    const second = reduceUpdateState(first, updateEvent({ ...info }));
    expect(second).toBe(first);
  });

  it('新版本会替换旧提示', () => {
    const first = reduceUpdateState({ info: null }, updateEvent(info));
    const next = reduceUpdateState(
      first,
      updateEvent({ ...info, latest: '0.2.0', channel: 'beta' }),
    );
    expect(next.info?.latest).toBe('0.2.0');
    expect(next.info?.channel).toBe('beta');
  });
});
