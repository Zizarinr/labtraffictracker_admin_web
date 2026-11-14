'use strict';

const config = require('./src/config');
const { openDatabase } = require('./src/db');
const { createApp } = require('./src/app');

function startServer(options = {}) {
  const requestedPort = options.port !== undefined ? Number(options.port) : config.port;
  const host = options.host || config.host;
  const dbPath = options.dbPath || config.dbPath;

  const db = openDatabase(dbPath);
  const app = createApp(db);

  let server;
  const ready = new Promise((resolve, reject) => {
    server = app.listen(requestedPort, host, () => {
      const actualPort = server.address()?.port || requestedPort;
      if (!options.quiet) {
        console.log(`[lab_admin_monitor] Server aktif di http://${host}:${actualPort}`);
        console.log(`[lab_admin_monitor] Endpoint Ingest Kiosk: http://${host}:${actualPort}/api/lab/traffic`);
        console.log(`[lab_admin_monitor] Database: ${dbPath}`);
      }
      resolve(actualPort);
    });
    server.once('error', reject);
  });

  function close() {
    return new Promise((resolve) => {
      const closeDb = () => {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        resolve();
      };
      if (server && server.listening) {
        server.close(closeDb);
      } else {
        closeDb();
      }
    });
  }

  return { app, db, server, ready, host, close };
}

if (require.main === module) {
  const instance = startServer();
  const shutdown = async () => {
    console.log('\n[lab_admin_monitor] Menutup server...');
    await instance.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { startServer };
