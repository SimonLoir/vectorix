# Authentification et permissions

Better Auth conserve les mots de passe hachés, les sessions, les organisations, les rôles dynamiques, les clés API, les passkeys et la double authentification TOTP. Les clés et opérations administratives vérifient les permissions actuelles et l’organisation active. Les opérations privées absentes du catalogue sont refusées.

Une session utilisateur est obligatoire pour les notifications et l’administration globale. Les clés API ne peuvent pas créer d’autres clés, gérer les membres, modifier les rôles ou accéder aux routes superadmin. L’initialisation des permissions ne donne aucun privilège automatique aux clés existantes.

Configurer `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`, `PASSKEY_RP_ID` et `PASSKEY_ORIGINS`. Les secrets de double authentification et codes de secours sont chiffrés. Une notification de connexion est créée uniquement après une authentification réussie, sans bloquer la connexion si son enregistrement échoue.
