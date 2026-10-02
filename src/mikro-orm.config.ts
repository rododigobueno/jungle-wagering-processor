import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';

export default defineConfig({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? '5432'),
  user: process.env.DB_USER ?? 'jungle',
  password: process.env.DB_PASSWORD ?? 'jungle',
  dbName: process.env.DB_NAME ?? 'jungle_wagering',

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