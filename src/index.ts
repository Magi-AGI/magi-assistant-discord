import { getConfig } from './config';

const config = getConfig();
console.log('Magi Assistant Discord — config loaded successfully');
console.log(`  Data dir: ${config.dataDir}`);
console.log(`  DB path: ${config.dbPath}`);
console.log(`  Guilds configured: ${Object.keys(config.guilds).length}`);
