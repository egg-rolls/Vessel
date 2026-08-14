import { Box, Text } from 'ink';
import type React from 'react';
import type { SkillAsset } from '../../../types';

interface SkillsListProps {
  skills: SkillAsset[];
}

/**
 * Skills list display component
 */
export const SkillsList: React.FC<SkillsListProps> = ({ skills }) => {
  if (skills.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray">No skills available</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="blue" bold>
        Skills ({skills.length})
      </Text>
      {skills.map((skill) => (
        <Text key={skill.name} color="white">
          📚 {skill.name}: {skill.description}
        </Text>
      ))}
    </Box>
  );
};

export default SkillsList;
