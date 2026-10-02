import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';

export default defineConfig({
  host: 'localhost',
  port: 5432,
  user: 'jungle',
  password: 'jungle',
  dbName: 'jungle_wagering',

  entities: ['dist/**/*.entity.js'],
  entitiesTs: ['src/**/*.entity.ts'],

  extensions: [Migrator],

  discovery: {
    warnWhenNoEntities: false,
  },

  migrations: {
    path: 'dist/migrations',
    pathTs: 'src/migrations',
    transactional: true,
    allOrNothing: true,
    emit: 'ts',
  },
});