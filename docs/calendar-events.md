# Ajouter un événement à l’agenda depuis une capture

## Ce que fait l’app

Quand une capture demande explicitement un ajout à l’agenda (« mets dans mon agenda… »,
« ajoute à mon calendrier… », « add to my calendar… »), l’écran Saved, l’historique et le
tiroir desktop montrent une carte « Ajouter à l’agenda ». Ses champs sont modifiables :
titre, toute la journée, début, fin, fuseaux, lieu. Une ligne de contrôle écrit le jour en
toutes lettres (« mar. 17 nov. · 15:00 → 16:00 ») pour repérer d’un coup d’œil un mauvais
jour. Rien n’est envoyé à Google avant le bouton.

**Une demande d’agenda n’est pas une tâche** (décision de Julien, 13/11/2026). Une fois
l’événement créé dans Google, la capture est supprimée de Brain Capture : plus d’historique,
de catégorie, de Today ni de compteur, et ses liens aux projets partent avec elle. La
transcription d’origine est dans la description de l’événement, rien n’est perdu. Juste
après la création, l’écran garde la confirmation (« In your calendar ») et le lien vers
l’événement, avec une phrase qui dit que la note a quitté Brain Capture ; les actions sur la
capture (terminer, archiver, supprimer, catégorie) disparaissent.

« Dismiss » (Ignorer) replie la carte et la capture reste une capture normale ; « Show » la
rouvre.

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
- événement à heure : une heure après le début, dans le fuseau du début (la nuit du passage
  à l’heure d’hiver, si cette heure se répète, la fin passe à l’heure suivante) ;
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
- La suppression de la capture n’intervient qu’après la réponse de Google, et dans la même
  transaction que l’enregistrement de l’événement : soit la capture est encore là avec sa
  proposition (une relance retombe sur le même événement Google, par son id fixe), soit elle
  est supprimée et sa « pierre tombale » (`deleted_captures`) garde l’événement créé. Aucun
  état intermédiaire ne permet d’en créer un second. Une confirmation répétée ensuite
  (double appui, réponse perdue) répond avec cet événement sans appeler Google.
- Le téléphone qui n’aurait pas reçu la réponse à l’envoi de la capture et la renverrait
  reçoit un 410 : elle n’est pas recréée (voir la suppression dans le README).
- Les événements créés avant ce changement restent attachés à leur capture, qui n’est pas
  supprimée rétroactivement : le bouton Delete permet de les retirer à la main.
- Deux confirmations simultanées de la même capture (deux appareils) passent l’une après
  l’autre dans le serveur ; la carte garde la version que Google a reçue. Ce verrou est en
  mémoire : il suppose un seul processus serveur, ce qui est le cas sur Railway.

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

## Pages publiques exigées par Google

Pour passer l’app OAuth en « In production », Google exige une page d’accueil et des règles
de confidentialité valides. Le serveur sert donc deux pages publiques, sans script ni
connexion : `/about` (page d’accueil) et `/privacy`. Le service worker ne les remplace pas
par l’app. `up.railway.app` figurant sur la Public Suffix List, le domaine autorisé à
déclarer chez Google est le sous-domaine complet `brain-capture-production-8fa2.up.railway.app`.

## Sauvegarde

Les propositions d’agenda ne font pas partie de l’export JSON. Une capture restaurée
garde son texte mais pas sa carte ; l’événement, lui, reste dans Google. Une capture devenue
événement n’est plus dans les sauvegardes suivantes, et l’import d’une sauvegarde plus
ancienne ne la fait pas revenir.

## Vérifier

- `npm test` : `tests/calendar-event.test.ts` couvre le filtre, les dates relatives dans le
  fuseau du téléphone, les fuseaux et l’heure d’été, la règle de fin, l’absence de doublon
  (double tap, réponse perdue, relance), les erreurs Google et le retour après reconnexion,
  la suppression de la capture après création (listes, compteurs, liens aux projets, renvoi
  du téléphone refusé, pas de second appel à Google) et la carte ignorée qui garde la capture.
- `npx tsx --env-file=<fichier avec GROQ_API_KEY> scripts/eval-event.ts` : extraction réelle
  par Groq sur des phrases types (dentiste, anglais, vol Paris → Lisbonne, Da Nang…).
