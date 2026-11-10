#!/usr/bin/env node
/** Tiny stdio MCP client used by docs/demo.sh. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['bridge.mjs', 'serve', 'demo'],
  env: process.env,
  stderr: 'ignore',
});
const client = new Client({ name: 'demo-client', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
const tools = await client.listTools();
console.log(`  tools: ${tools.tools.map((tool) => tool.name).join(', ')}`);
const echo = await client.callTool({ name: 'echo', arguments: { text: 'hello from stdio' } });
console.log(`  echo:  ${echo.content?.[0]?.text}`);
await client.close();
