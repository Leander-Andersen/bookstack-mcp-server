#!/usr/bin/env node

import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BookStackMCPServer } from './server';
import { ConfigManager, Config } from './config/manager';

const transport = process.env.MCP_TRANSPORT || 'http';

if (transport === 'stdio') {
  const server = new BookStackMCPServer();
  const stdioTransport = new StdioServerTransport();

  server.connect(stdioTransport).catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });

  console.error('BookStack MCP Server started and listening on stdio');

  process.on('SIGINT', () => server.shutdown());
  process.on('SIGTERM', () => server.shutdown());
} else {
  const app = express();
  app.use(express.json());
  const config = ConfigManager.getInstance().getConfig();

  app.post('/message', async (req, res) => {
    try {
      const bookstackUrl = req.headers['x-bookstack-url'] as string;
      const bookstackToken = req.headers['x-bookstack-token'] as string;

      const configOverrides: Partial<Config> = {
        bookstack: {
          baseUrl: bookstackUrl || config.bookstack.baseUrl,
          apiToken: bookstackToken || config.bookstack.apiToken,
          timeout: config.bookstack.timeout,
        },
      };

      const server = new BookStackMCPServer(configOverrides);
      const mcpTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(mcpTransport);
      await mcpTransport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling request:', error);
      if (!res.headersSent) {
        res.status(500).send('Internal Server Error');
      }
    }
  });

  const port = config.server.port || 3000;
  app.listen(port, () => {
    console.log(`BookStack MCP Server listening on port ${port}`);
  });
}
