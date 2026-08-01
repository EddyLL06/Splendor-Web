import { createConfig, loadLocalEnvironment } from '../src/server/config.js';
import { prepareStorage } from '../src/server/storage/paths.js';

loadLocalEnvironment();
await prepareStorage(createConfig());
console.log('Configured database, avatar, and upload directories are ready.');
