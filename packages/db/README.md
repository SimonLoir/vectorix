# Base de données

PostgreSQL 18 et Prisma 7. Le schéma multi-fichier est sous `prisma/models/` et la migration initiale sous `prisma/migrations/`. Les clients TypeScript et Zod générés dans `src/generated/` sont ignorés par Git.

Depuis la racine : `pnpm db:generate`, puis `pnpm db:migrate` sur une base neuve. Le script de migration lit `DATABASE_URL`. Pour inspecter la base, `pnpm --filter @repo/db studio`.

Les seules données persistées sont les comptes et sessions, organisations et rôles, clés API, définitions/attributions de fonctionnalités, notifications et journal d’administration. Les reçus de livraison sont durables ; Redis ne remplace pas leur stockage.
