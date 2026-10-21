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
