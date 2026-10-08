import { buildApp, initialize } from './app.js';
import { loadConfig } from './config.js';
import { Database } from './database.js';

const config = loadConfig();
const database = new Database(config.databaseUrl);
await initialize(database, config);
const app = await buildApp(config, database);

try {
  await app.listen({ host: '0.0.0.0', port: config.port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}

