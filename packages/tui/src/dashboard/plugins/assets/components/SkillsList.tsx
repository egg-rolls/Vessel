import { Box, Text } from 'ink';
import type React from 'react';
import type { SkillAsset } from '../../../types';

interface SkillsListProps {
  skills: SkillAsset[];
}

/**
 * Skills list display component (compact version)
 */
export const SkillsList: React.FC<SkillsListProps> = ({ skills }) => {
  if (skills.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray">No skills available</Text>
      </Box>
    );
  }

  // 只显示技能名称，用逗号分隔
  const skillNames = skills.map((s) => s.name).join(', ');

  return (
    <Box flexDirection="column">
      <Text color="blue" bold>
        Skills ({skills.length})
      </Text>
      <Text color="white">{skillNames}</Text>
    </Box>
  );
};

export default SkillsList;
