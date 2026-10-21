# Validation du template

- [x] Copier la branche demandée dans un nouveau dépôt Git.
- [x] Conserver web, API, administration, workers et migrateur.
- [x] Réduire modèles, contrats, permissions et routeurs aux services du socle.
- [x] Remplacer identité visuelle, configuration, exemples et documentation.
- [x] Générer une migration initiale et la déployer sur une base neuve.
- [x] Vérifier les types, le lint, les tests et les builds.
- [x] Vérifier le démarrage et les écrans dans un navigateur.

Validation effectuée le 21 octobre 2026 :

- `pnpm check-types` et `pnpm lint` : succès (avertissements non bloquants).
- `pnpm test` : 10 tests Node et 11 tests du fournisseur de licences réussis.
- `pnpm --filter api test:integration` sur une base PostgreSQL distincte : 6 parcours et leur suite réussis. Comptes, organisations, isolation, superadmin, clés API, licences, notifications et suspension sont couverts.
- `pnpm build` : succès pour les quatre applications.
- Migration initiale appliquée ; second déploiement sans migration en attente ; aucune différence entre le schéma et la base.
- API `/health`, `/ready` et schéma OpenAPI vérifiés avec PostgreSQL et Redis locaux.
- Connexion, dashboard, compte, équipe, rôles, clés API, licences et administration vérifiés en mode production dans le navigateur.

Les tests de notification couvrent la persistance, la déduplication, les préférences, l’isolation et la reprise en cas d’échec. Aucun e-mail ni push réel n’a été envoyé. Les images Docker sont fournies ; leur construction n’a pas été exécutée dans cet environnement sans Docker.

## Images de production

- Dockerfiles dédiés restaurés pour web, admin, API, workers et migrateur.
- Sortie Next.js standalone avec une racine de traçage explicite pour le monorepo.
- Dépendances backend isolées avec le lockfile via pnpm 11, sans dépendances de développement ni dépendances optionnelles.
- Suppression de l’ancien Dockerfile générique, des valeurs d’environnement de build et du contournement des erreurs de génération Prisma.
- Instructions de build mises à jour ; test des cinq images disponible avec `pnpm test:docker` et automatisé dans GitHub Actions.

Vérifications locales après restauration : schéma Prisma valide, 34 tâches de types/lint réussies, 21 tests unitaires réussis et quatre builds réussis. Les sorties standalone et les déploiements pnpm ont aussi été copiés hors du dépôt puis démarrés : API prête avec PostgreSQL/Redis, workers prêts, 19 assets web et 13 assets admin servis sans erreur. Les stores de production API/workers ne contiennent ni Next.js, ni TypeScript, ni Vite/Vitest, ni ESLint, ni le CLI Prisma.
