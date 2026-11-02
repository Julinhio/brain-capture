# Sauvegarde et restauration

## Ce qui est en place (gratuit)

Une sauvegarde au niveau de l'app : toutes les captures du compte, exportées en JSON par l'app elle-même (`GET /api/export`), et restaurables par l'app (`POST /api/import`). La base n'est jamais exposée hors du réseau privé de Railway ; tout passe par HTTPS et la session du compte.

**Contenu d'une sauvegarde** : chaque capture avec tous ses champs (identifiant, texte corrigé et texte original, titre et s'il a été renommé, lien, catégorie et son origine, statut, durée, appareil, dates). Pas d'audio (il n'est jamais conservé). Pas de mot de passe ni de session : le compte est recréé depuis les variables Railway (`OWNER_EMAIL`, `OWNER_PASSWORD_HASH`).

**Où** : dans `C:\Users\julin\OneDrive\Documents\dev-secrets\brain-capture\backups\`. Dossier privé, hors du dépôt, synchronisé par OneDrive (copie hors de Railway et hors du PC). Les 30 plus récentes sont gardées.

## Sauvegarder

Deux façons, au choix :

- **Depuis l'app sur ordinateur** : barre latérale, « Download backup ». Le fichier part dans les Téléchargements ; le ranger dans le dossier ci-dessus.
- **Depuis le PC, en une commande** (c'est ce que ferait une tâche planifiée) :

```bash
node --env-file=C:/Users/julin/OneDrive/Documents/dev-secrets/brain-capture/.env scripts/backup.mjs --dir C:/Users/julin/OneDrive/Documents/dev-secrets/brain-capture/backups
```

La commande affiche le fichier écrit, le nombre de captures et une empreinte sha256. Elle ne modifie rien dans la base.

## Restaurer

L'import **ajoute seulement ce qui manque** : une capture déjà présente (même identifiant) n'est jamais écrasée, rien n'est supprimé. Rejouer le même fichier est sans effet.

- **Des captures ont disparu** : restaurer la dernière sauvegarde dans l'app en ligne, elles reviennent avec leurs identifiants et leurs dates.

```bash
node --env-file=C:/Users/julin/OneDrive/Documents/dev-secrets/brain-capture/.env scripts/restore.mjs --file <fichier.json> --yes
```

- **Base perdue ou nouveau projet Railway** : redéployer l'app sur une base vide (les migrations créent le schéma, le compte est créé depuis les variables), puis la même commande avec `--url <nouvelle adresse>`.
- **Vérifier une sauvegarde sans toucher aux vraies données** : la restaurer dans une instance locale isolée, qui compare champ par champ et refuse toute adresse autre que localhost.

```bash
node scripts/check-restore.mjs http://localhost:3101 <fichier.json>
```

## Vérification faite le 2026-11-02

Sauvegarde réelle de la production (lecture seule), restaurée dans une instance locale vierge (PGlite, base séparée) : résultat dans la description de la PR qui ajoute cette procédure.

## Coûts

- Solution en place : **0 €**. Quelques Ko transférés par sauvegarde, stockage OneDrive existant.

## Limites

- **Fréquence** : manuelle tant qu'aucune tâche planifiée n'est créée. On perd au pire ce qui a été capturé depuis la dernière sauvegarde.
- **Retour à un état passé exact** : non. L'import ne supprime ni n'écrase ; les changements faits depuis la sauvegarde restent.
- **Données personnelles en clair** dans les fichiers de sauvegarde, sur OneDrive (dossier privé). À ne pas partager.
- **Une sauvegarde ne couvre que le compte connecté** (l'app n'a qu'un compte).

## Options non activées (à décider, voir la PR)

1. **Sauvegardes natives Railway** du volume PostgreSQL : quotidiennes (gardées 6 jours), hebdomadaires (27 jours) ou mensuelles (89 jours). Facturées comme du stockage de volume, environ 0,16 $ par Go et par mois : quelques centimes pour cette base. Protègent toute la base, mais restent chez Railway, et une restauration remplace le volume entier. **Nouvelle dépense : accord de Julien requis.**
2. **Tâche planifiée Windows** lançant `backup.mjs` chaque jour : 0 €, mais le PC doit être allumé à l'heure prévue, et c'est une configuration permanente du poste. **Accord de Julien requis.**
