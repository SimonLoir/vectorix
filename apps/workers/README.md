# Workers de notifications

Le worker BullMQ `notifications` programme une inspection des reçus PostgreSQL toutes les dix secondes. Chaque reçu est réservé par un jeton et une échéance ; les réservations expirées sont récupérées. L’appartenance à l’organisation et les préférences sont revérifiées avant chaque envoi.

Les erreurs de transport sont réessayées cinq fois avec temporisation croissante, puis conservées comme `FAILED`. Une préférence désactivée ou un abonnement push indisponible produit `SKIPPED`. Les erreurs stockées ne contiennent ni secret ni réponse brute du fournisseur. La livraison e-mail/push est au moins une fois : une interruption après l’envoi mais avant l’enregistrement peut produire un doublon.

Démarrage isolé depuis la racine : `pnpm exec dotenvx run -f .env -- pnpm --filter workers dev`. Voir `.env.example` pour Redis, les transports e-mail, le chiffrement et VAPID.
