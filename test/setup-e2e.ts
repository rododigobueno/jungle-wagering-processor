import mikroOrmConfig from '../src/mikro-orm.config.js';

// Vitest signals TypeScript support to MikroORM, but dynamic entity discovery
// does not pass those .ts files through Vitest's transform pipeline.
mikroOrmConfig.preferTs = false;
