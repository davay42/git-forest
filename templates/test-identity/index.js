import { createServer } from 'node:http';
createServer((req, res) => {
  const deviceId = req.headers['x-forest-device-id'] || 'MISSING';
  res.setHeader('Content-Type', 'text/plain');
  res.end(`Your Forest Device ID is: ${deviceId}`);
}).listen(process.env.SOCKET_PATH, () => {
  if (process.send) process.send('ready');
});