# Asset Introspection

This skill teaches the agent how to understand and manage its own capabilities.

## How to Check What You Have

When a user asks you to do something, first check if you have the necessary tools and skills:

1. Use `search_assets` to find relevant tools and skills
2. Use `inspect_asset` to get details about specific assets
3. If you're missing something, use `add_tool` or `add_skill` to add it

## How to Add New Capabilities

If you need a tool that doesn't exist:

1. Use `add_tool` with a clear name, description, and handler code
2. The handler should be a JavaScript function that takes `args` and returns a string

If you need knowledge about how to do something:

1. Use `add_skill` with a Markdown document explaining the process
2. Skills are knowledge, not code - they teach you how to approach tasks

## How to Connect External Services

If you need to connect to an external service:

1. Use `connect_mcp` to establish a connection
2. MCP (Model Context Protocol) allows you to access external tools and resources

## Self-Improvement

Always look for ways to improve:

- After completing a task, consider if you learned something useful
- If so, create a new skill to remember it
- If you found a better way to do something, update your existing skills
