import { defineConfig } from 'prisma/config';
export default defineConfig({
    schema: 'prisma/',
    migrations: { path: 'prisma/migrations' },
    datasource: {
        url:
            process.env.DATABASE_URL ??
            'postgresql://postgres:password@localhost:5432/vectorix',
    },
});
