import { createConfig, loadLocalEnvironment } from './config.js';
import { createGemCouncilApplication } from './http/app.js';

loadLocalEnvironment();

const config = createConfig();
const application = await createGemCouncilApplication({ config });

const shutdown = async (): Promise<void> => {
  await application.stop();
  process.exit(0);
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

try {
  await application.start();
  console.log(`Gem Council multiplayer server: http://localhost:${config.port}`);
  console.log('Match storage: in-memory only (all matches disappear on restart).');
} catch (error) {
  await application.stop();
  console.error(
    error instanceof Error ? error.message : 'Could not start the multiplayer server.',
  );
  process.exitCode = 1;
}
