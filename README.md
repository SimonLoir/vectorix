# Vectorix

Socle d’application multi-organisation en TypeScript. Il comprend un dashboard Next.js, une API Hono/oRPC, un panneau d’administration, des workers BullMQ et un migrateur Prisma/PostgreSQL.

## Démarrage local

Prérequis : Node.js 24, pnpm 11.25 et Docker Compose pour PostgreSQL et Redis.

```sh
pnpm install --frozen-lockfile
pnpm setup:env
# Adapter .env si les ports par défaut sont déjà occupés.
docker compose up -d
pnpm db:generate
pnpm db:migrate
pnpm dev
```

`setup:env` crée des secrets aléatoires et ne remplace jamais un fichier existant. Le fichier `.env` reste local et n’est pas commité. Les services de développement utilisent les ports suivants :

| Service                          | Adresse               |
| -------------------------------- | --------------------- |
| Dashboard                        | http://localhost:3000 |
| API et documentation interactive | http://localhost:3001 |
| Administration                   | http://localhost:3006 |
| PostgreSQL                       | localhost:5432        |
| Redis                            | localhost:6379        |

Créer un compte depuis le dashboard, puis une organisation. Pour donner à un compte existant l’accès à l’administration :

```sh
pnpm admin:grant votre-adresse@example.com
```

## Fonctionnalités conservées

- Authentification par mot de passe et passkeys, réinitialisation du mot de passe, double authentification TOTP et codes de secours, gestion des sessions et suppression de compte.
- Organisations, membres, invitations et rôles personnalisés. Les permissions sont revérifiées côté API ; les clés API sont limitées à des permissions explicites.
- Notifications de connexion : boîte de réception, état lu/non lu, préférences personnelles, e-mail et Web Push. Les workers livrent les reçus persistants avec reprise et tentatives bornées.
- Catalogue de fonctionnalités sous licence, fournisseur externe optionnel et attributions manuelles explicites par un super administrateur. Une panne ou une expiration du fournisseur ne donne jamais accès à une fonctionnalité.
- Administration des utilisateurs et organisations, suspension d’organisation, gestion des droits et journal d’audit.
- Composants d’interface partagés, thème clair/sombre et parcours d’authentification traduits en français, anglais et néerlandais.

Le catalogue initial est vide. Aucun domaine métier ni donnée de démonstration n’est installé. Les modèles, contrats, permissions et migrations ne décrivent que le socle.

## Organisation du dépôt

| Dossier                                  | Rôle                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `apps/web`                               | Dashboard, comptes, équipe et notifications                          |
| `apps/api`                               | Transport HTTP, authentification et documentation OpenAPI            |
| `apps/admin`                             | Administration globale protégée par une session superadmin           |
| `apps/workers`                           | Livraison asynchrone des notifications                               |
| `packages/db`                            | Schéma, client généré et image du migrateur                          |
| `packages/auth`                          | Better Auth et politique d’autorisation                              |
| `packages/api-contracts`                 | Contrats oRPC/Zod versionnés                                         |
| `packages/api`                           | Composition des routeurs                                             |
| `packages/routers`                       | Organisations, membres, notifications, administration et utilitaires |
| `packages/queues`, `packages/emails`     | Redis/BullMQ et transports e-mail                                    |
| `packages/ui`, `packages/dashboard-core` | Composants partagés                                                  |

L’API utilise `/rpc/v1` et `/api/v1`. Le contrat initial est en version `1.0.0`. Le schéma OpenAPI est disponible sur `/spec/v1.json` et `/spec.json`, le registre sur `/api-versions.json`. `/health` vérifie le processus ; `/ready` vérifie PostgreSQL et Redis.

## Configuration

Toutes les variables sont documentées dans `.env.example`. Les valeurs publiques sont lues sur le serveur et transmises à l’interface, sans variables `NEXT_PUBLIC_*`.

Les inscriptions et la création d’organisations sont activées dans l’exemple local. Les désactiver avec `ALLOW_ACCOUNT_CREATION=false` et `ALLOW_ORGANIZATION_CREATION=false` pour une instance sur invitation. Définir les URL, origines autorisées, secrets, domaine des cookies et paramètres WebAuthn pour chaque déploiement.

L’e-mail nécessite Resend ou SMTP. Sans fournisseur, les notifications restent en attente puis passent en échec après cinq tentatives ; la connexion de l’utilisateur reste disponible. Web Push est désactivé par défaut et nécessite une paire de clés VAPID et `ENCRYPTION_SECRET` pour les abonnements chiffrés. Ces transports ne sont pas simulés en production.

Un fournisseur de licences reçoit `GET {VECTORIX_FEATURE_PROVIDER_URL}/organizations/{id}/features` avec le token serveur optionnel. Il renvoie `{"features":{"reporting":true},"expiresAt":null}`. La durée de cache et le délai HTTP sont configurables. Le mode manuel, appelé `legacy` dans le contrat, requiert une activation et des attributions explicites dans l’administration.

## Validation

```sh
pnpm check-types
pnpm lint
pnpm test
pnpm build
```

Les tests d’intégration nécessitent une base distincte dont le nom termine par `_test`. Ils créent leurs propres comptes et organisations puis les suppriment, sans effacer les autres données. Les fournisseurs externes sont désactivés dans ces tests.

```sh
docker compose exec postgres createdb -U postgres vectorix_test
DATABASE_URL=postgresql://postgres:password@localhost:5432/vectorix_test pnpm --filter @repo/db migrate:deploy
DATABASE_URL=postgresql://postgres:password@localhost:5432/vectorix_test pnpm exec dotenvx run -f .env -- pnpm --filter api test:integration
```

## Déploiement et migrations

La migration initiale construit uniquement le socle sur une base neuve. Pour les évolutions, modifier le schéma, générer et relire une migration de développement avec `pnpm --filter @repo/db migrate:dev`, puis exécuter `pnpm db:migrate` avant de déployer les applications. Ne pas utiliser `db:push` sur une base de production.

```sh
docker build -f apps/web/Dockerfile -t vectorix-web .
docker build -f apps/api/Dockerfile -t vectorix-api .
docker build -f apps/admin/Dockerfile -t vectorix-admin .
docker build -f apps/workers/Dockerfile -t vectorix-workers .
docker build -f packages/db/Dockerfile -t vectorix-migrator .
```

Injecter la configuration au démarrage des conteneurs et utiliser les noms DNS de PostgreSQL et Redis accessibles depuis leur réseau. Le migrateur est un processus ponctuel exécutant `prisma migrate deploy`. Il ne tourne pas en parallèle avec les applications dans `pnpm dev`.

Chaque application possède son Dockerfile, avec la racine du dépôt comme contexte de construction. Web et admin exécutent le serveur Next.js standalone et embarquent ses fichiers tracés, les assets statiques et, pour web, le dossier public. L’API et les workers embarquent leur bundle et les dépendances de production isolées par `pnpm deploy`, à partir du lockfile. Les dépendances optionnelles sont exclues de ces deux images pour éviter les pairs Next.js/TypeScript et les accélérateurs natifs inutilisés ; PostgreSQL et BullMQ utilisent leurs implémentations JavaScript.

Les cinq images utilisent Node.js 24 Alpine et un utilisateur non privilégié. pnpm et les outils de compilation restent dans les étapes de construction. La génération Prisma est obligatoire : une erreur arrête le build. Aucune configuration privée n’est copiée dans les images.

Pour construire et tester les cinq images avec PostgreSQL et Redis temporaires :

```sh
pnpm test:docker
# Ou, avec uniquement Bash et Docker installés :
bash scripts/test-docker.sh
```

Ce test vérifie les migrations, le démarrage, une inscription via l’API, les assets Next.js, la configuration au démarrage, l’exécution d’un job worker et l’absence des outils de build dans les images backend. Il ne publie aucun port sur la machine et nettoie ses conteneurs après exécution. Le workflow GitHub Actions « Docker images » exécute le même test à chaque push sur `main` et sur les pull requests.
