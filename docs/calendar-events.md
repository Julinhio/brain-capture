# Ajouter un événement à l’agenda depuis une capture

## Ce que fait l’app

Quand une capture demande explicitement un ajout à l’agenda (« mets dans mon agenda… »,
« ajoute à mon calendrier… », « add to my calendar… »), l’écran Saved, l’historique et le
tiroir desktop montrent une carte « Ajouter à l’agenda ». Ses champs sont modifiables :
titre, toute la journée, début, fin, fuseaux, lieu. Une ligne de contrôle écrit le jour en
toutes lettres (« mar. 17 nov. · 15:00 → 16:00 ») pour repérer d’un coup d’œil un mauvais
jour. Rien n’est envoyé à Google avant le bouton. Ensuite la carte affiche « Dans ton
agenda » et un lien vers l’événement Google. La capture elle-même n’est jamais modifiée.

« Ignorer » replie la carte ; « Afficher » la rouvre.

## Détection

Deux étapes :

1. Un filtre lexical gratuit (`looksLikeCalendarRequest`, `src/server/ai/event-prompt.ts`)
   cherche un verbe d’ajout (mets, ajoute, inscris, bloque, add, put, schedule…) à moins de
   dix mots de « agenda », « calendrier » ou « calendar ». Une note qui contient seulement une
   date (« demain, penser à regarder cette offre ») ne passe pas ce filtre : aucun appel IA.
2. Pour les candidates, Groq (même modèle gratuit que le classement) relit la note, confirme
   que c’est une demande (« mettre à jour l’agenda » ne l’est pas) et extrait les champs.

## Dates relatives et fuseaux

Le téléphone envoie avec chaque capture son heure (`capturedAt`) et son fuseau IANA
(`timeZone`), pris au moment de la capture, même si l’envoi part plus tard (hors ligne).
Le serveur précalcule dans ce fuseau aujourd’hui, demain, le prochain de chaque jour de la
semaine et un calendrier de quatre semaines, et les donne au modèle : « mardi prochain »
devient une lecture de table, pas un calcul. Un « mardi prochain » dit un mardi désigne le
mardi suivant, jamais le jour même.

Les heures sont des heures murales dans leur propre fuseau, comme sur un billet : pour un
vol, le départ est dans le fuseau de la ville de départ, l’arrivée dans celui d’arrivée.
Sans fuseau dit, c’est celui du téléphone. Une horloge de téléphone incohérente (dans le
futur ou vieille de plus de 400 jours) est ignorée au profit de l’heure du serveur ; un
fuseau absent (anciennes versions de l’app) vaut Europe/Paris.

Règle de fin, quand elle n’est pas dite :
- événement à heure : une heure après le début, dans le fuseau du début ;
- sans heure dite : événement sur toute la journée, d’un seul jour.

Le modèle n’invente jamais d’heure : « mardi matin » donne un événement sur la journée,
corrigeable dans la carte.

La transcription d’origine (`originalText`) va dans la description de l’événement.

## Un seul événement par capture

- En base, `capture_events` a l’id de la capture comme clé primaire.
- Chez Google, l’id de l’événement est dérivé de celui de la capture (`bc` + l’uuid en
  hexadécimal). Une deuxième création avec le même id reçoit un 409 de Google : le serveur
  met alors à jour cet événement avec la version confirmée (corrigée entre-temps ou non)
  au lieu d’en créer un autre. Cela couvre le double tap, la relance après une réponse
  perdue et le crash entre la réponse de Google et l’écriture en base. Un événement
  supprimé dans Google entre-temps est restauré, jamais dupliqué.
- Les corrections faites dans la carte sont enregistrées avant de partir vers l’écran de
  consentement Google, et retrouvées au retour.
- Une fois l’événement créé, un nouvel appui ne contacte plus Google.

## Erreurs

Toujours visibles sur la carte, et conservées pour la prochaine ouverture :
- jeton expiré ou révoqué, droit d’écriture manquant : « Reconnecter Google » relance le
  consentement et revient sur la capture (`/history?id=…&calendar=connected`) ;
- Google lent, en panne ou limitant : « Réessayer », sans risque de doublon ;
- événement refusé par Google : le message de Google est affiché ;
- lecture IA impossible : carte vide à compléter, avec « relance la lecture ».

Le statut 403 sert aux refus Google, jamais 401 : un 401 déconnecterait l’app.

## Calendrier cible

Le calendrier principal du compte (alias `primary` de Google). Le dashboard sait déjà
lire plusieurs calendriers choisis, mais le code n’avait aucune notion de calendrier par
défaut pour écrire : le principal reste le choix le plus prévisible.

## Accès Google

Le scope demandé passe de `calendar.events.readonly` à `calendar.events` (lecture et
écriture des événements). `calendar.calendarlist.readonly` est inchangé. Une connexion
faite avant ce changement continue d’alimenter le dashboard ; la carte demande de
reconnecter Google pour obtenir l’écriture. Une reconnexion réussie efface les anciennes
erreurs « reconnecte-toi » des cartes.

## Sauvegarde

Les propositions d’agenda ne font pas partie de l’export JSON. Une capture restaurée
garde son texte mais pas sa carte ; l’événement, lui, reste dans Google.

## Vérifier

- `npm test` : `tests/calendar-event.test.ts` couvre le filtre, les dates relatives dans le
  fuseau du téléphone, les fuseaux et l’heure d’été, la règle de fin, l’absence de doublon
  (double tap, réponse perdue, relance), les erreurs Google et le retour après reconnexion.
- `npx tsx --env-file=<fichier avec GROQ_API_KEY> scripts/eval-event.ts` : extraction réelle
  par Groq sur des phrases types (dentiste, anglais, vol Paris → Lisbonne, Da Nang…).
