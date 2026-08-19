import { Box, Text, useInput } from 'ink';
import type React from 'react';
import { useEffect, useState } from 'react';
import { DashboardService } from '../dashboard/dashboard-service.js';
import type { SkillAsset } from '../dashboard/types.js';
import type { ReplContext } from '../repl-context.js';

export const SkillsBrowser: React.FC<{ ctx: ReplContext; onClose: () => void }> = ({
  ctx,
  onClose,
}) => {
  const [items, setItems] = useState<SkillAsset[]>([]);
  const [selected, setSelected] = useState(0);
  const [details, setDetails] = useState(false);
  useEffect(() => {
    void new DashboardService(ctx).getAssets().then((data) => setItems(data.skills));
  }, [ctx]);
  useInput((_input, key) => {
    if (key.escape) return onClose();
    if (key.upArrow) return setSelected((value) => Math.max(0, value - 1));
    if (key.downArrow) return setSelected((value) => Math.min(items.length - 1, value + 1));
    if (key.return) setDetails((value) => !value);
  });
  const item = items[selected];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} flexGrow={1}>
      <Text bold color="blue">
        Skills
      </Text>
      {items.map((skill, index) => (
        <Text key={skill.name} color={index === selected ? 'cyan' : undefined}>
          {index === selected ? '❯ ' : '  '}
          {skill.name}
        </Text>
      ))}
      {details && item && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="blue">Skill: {item.name}</Text>
          <Text color="gray">{item.description}</Text>
        </Box>
      )}
      <Text color="gray">↑↓ Navigate · Enter Details · R Refresh · Esc Back</Text>
    </Box>
  );
};
