#!/usr/bin/env node

import WebSocket from 'ws';
import http from 'http';
import { parseInt as parseInt } from 'lib0/number';
import setupWSConnection from './utils.js';

const port = parseInt(process.env.PORT || '1234');

const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/plain' });
  response.end('okay');
});

const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', setupWSConnection);

server.on('upgrade', (request, socket, head) => {
  // You may check auth of request here..
  // See https://github.com/websockets/ws#client-authentication
  const handleAuth = (ws) => {
    wss.emit('connection', ws, request);
  };
  wss.handleUpgrade(request, socket, head, handleAuth);
});

server.listen(port, () => {
  console.log(`running on port ${port}`);
});
