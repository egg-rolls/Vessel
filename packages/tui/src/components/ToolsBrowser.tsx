import { Box, Text, useInput } from 'ink';
import type React from 'react';
import { useEffect, useState } from 'react';
import { DashboardService } from '../dashboard/dashboard-service.js';
import type { ToolAsset } from '../dashboard/types.js';
import type { ReplContext } from '../repl-context.js';

export function buildTestInput(schemaText: string | undefined): Record<string, unknown> {
  const schema = parseSchema(schemaText);
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : Object.keys(properties);
  const input: Record<string, unknown> = {};
  for (const name of required) {
    const definition = isRecord(properties[name]) ? properties[name] : {};
    input[name] = sampleValue(definition, name);
  }
  return input;
}

function parseSchema(schemaText: string | undefined): Record<string, unknown> {
  if (!schemaText) return {};
  try {
    const value: unknown = JSON.parse(schemaText);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sampleValue(schema: Record<string, unknown>, name: string): unknown {
  if (name === 'questions') {
    return [{ header: 'Test', question: 'Did the tool test run?', options: ['Yes', 'No'] }];
  }
  if (schema.type === 'array') {
    const itemSchema = isRecord(schema.items) ? schema.items : {};
    return [sampleValue(itemSchema, `${name}-item`), sampleValue(itemSchema, `${name}-item-2`)];
  }
  if (schema.type === 'boolean') return false;
  if (schema.type === 'number' || schema.type === 'integer') return 0;
  return typeof schema.default === 'string' ? schema.default : `test-${name}`;
}

function isUnsafeTool(name: string): boolean {
  return ['mcp_connect', 'mcp_disconnect'].includes(name);
}

export const ToolsBrowser: React.FC<{ ctx: ReplContext; onClose: () => void }> = ({ ctx, onClose }) => {
  const [items, setItems] = useState<ToolAsset[]>([]);
  const [selected, setSelected] = useState(0);
  const [details, setDetails] = useState(false);
  const [testResult, setTestResult] = useState<string>();
  useEffect(() => { void new DashboardService(ctx).getAssets().then((data) => setItems(data.tools)); }, [ctx]);
  useInput((input, key) => {
    if (key.escape) return details ? setDetails(false) : onClose();
    if (key.upArrow) return setSelected((value) => Math.max(0, value - 1));
    if (key.downArrow) return setSelected((value) => Math.min(items.length - 1, value + 1));
    if (key.return) setDetails((value) => !value);
    if (input.toLowerCase() === 't' && items[selected]) {
      setDetails(true);
      if (isUnsafeTool(items[selected].name)) {
        setTestResult('Blocked: this management tool requires real user-provided parameters.');
        return;
      }
      const input = buildTestInput(items[selected].inputSchema);
      void ctx.testTool?.(items[selected].name, input).then(setTestResult);
    }
  });
  const item = items[selected];
  return <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} flexGrow={1}>
    <Text bold color="blue">Tools</Text>
    {items.map((tool, index) => <Text key={tool.name} color={index === selected ? 'cyan' : undefined}>
      {index === selected ? '❯ ' : '  '}{tool.name}
    </Text>)}
    {details && item && <Box flexDirection="column" marginTop={1}>
      <Text color="blue">Tool: {item.name}</Text><Text color="gray">{item.description}</Text>
      <Text color="gray" wrap="truncate">Input schema │ {item.inputSchema ?? '{}'}</Text>
      <Text color="gray">Tool testing requires an input payload and permission confirmation.</Text>
      {testResult && <Text color="yellow" wrap="truncate">Test result │ {testResult}</Text>}
    </Box>}
    <Text color="gray">↑↓ Navigate · Enter Details · T Test · R Refresh · Esc Back</Text>
  </Box>;
};
