import { createServer } from 'node:http';

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`Hello from /${process.env.COMPONENT_NAME}\n`);
});

// 1. Graceful Shutdown: Finish existing requests before dying
process.on('SIGTERM', () => {
  console.log(`[component] /${process.env.COMPONENT_NAME} received SIGTERM, closing gracefully...`);
  server.close(() => process.exit(0));
  // Force exit after 5 seconds if requests hang forever
  setTimeout(() => process.exit(0), 5000).unref();
});

// 2. Zero-Downtime Signal: Tell parent we are ready to receive traffic
server.listen(process.env.SOCKET_PATH, () => {
  if (process.send) process.send('ready');
  console.log(`[component] /${process.env.COMPONENT_NAME} ready`);
});