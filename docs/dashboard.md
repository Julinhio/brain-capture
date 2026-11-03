# Aujourd’hui, dashboard personnel

## Comportement

Sur ordinateur, `/` ouvre Aujourd’hui. Everything est conservé sous `/?view=everything`,
avec catégories, recherche, statuts, capture rapide et tiroir inchangés. Les liens de
catégorie `/?view=projects` restent des captures de la catégorie Projects ; la gestion
de projets utilise `/?view=workspace`. Sur téléphone, la capture reste l’accueil et un
bouton calendrier ouvre Aujourd’hui. Les projets sont également accessibles sur mobile.

Le briefing est une synthèse déterministe des données disponibles, sans appel LLM,
sans priorité inventée et sans coût IA supplémentaire. Les notes de la veille suivent
le fuseau du navigateur et le jour civil, pas une fenêtre glissante de 24 heures.

Les projets ont quatre états, choisis manuellement : Idée, À venir, En cours, Terminé.
Chaque projet possède un nom, une intention et une prochaine étape facultative. Une
capture peut alimenter plusieurs projets. Lier ou détacher ne change ni ne supprime la
capture. La sauvegarde v1 inclut désormais projets et liens ; les anciens fichiers
restent acceptés. Les tokens Google ne sont jamais exportés.

## Google Calendar

Google Cloud : client OAuth Web, Google Calendar API activée, scope unique
`https://www.googleapis.com/auth/calendar.events.readonly`.

Variables serveur à définir ensemble : GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
GOOGLE_REDIRECT_URI, CALENDAR_ENCRYPTION_KEY (32 octets aléatoires en hexadécimal).
GOOGLE_CALENDAR_ID est facultatif, `primary` par défaut. Le choix multi-calendrier
dans l’interface et l’écriture de rendez-vous sont hors de cette version.

URI de retour de production :
`https://brain-capture-production-8fa2.up.railway.app/api/calendar/callback`.
Développement : `http://localhost:3000/api/calendar/callback`.

L’utilisateur clique Connecter Google Calendar et consent directement chez Google.
Le flux utilise state lié au compte, cookie HttpOnly de dix minutes et PKCE. Le
refresh token est chiffré AES-256-GCM en base avec la clé serveur distincte. Garder
cette clé dans dev-secrets et entre les déploiements ; la changer nécessite une
reconnexion. Déconnecter supprime le token local ; la révocation chez Google reste
possible depuis les paramètres du compte Google.

Événements récurrents développés, pages suivies, refusés/annulés exclus. Les événements
transparents n’occupent pas une plage. Les événements bloquants sur toute la journée
occupent la journée. Les disponibilités affichées sont limitées à 08 h–20 h et les
chevauchements fusionnés. « Sans rendez-vous » ne signifie pas « temps de travail garanti ».
Les sources en erreur ne sont jamais interprétées comme une journée libre.

Références : https://developers.google.com/identity/protocols/oauth2/web-server et
https://developers.google.com/workspace/calendar/api/v3/reference/events/list.

## Radars

Chaque radar expose `/integrations/brain-summary.json`, protégé par son propre
BRAIN_SUMMARY_TOKEN. Une connexion indépendante en lecture seule exécute uniquement
des agrégats, sans migrations ni pipeline. Aucun secret de session des radars n’est
transmis à BrainCapture. Les deux PR sources sont nécessaires avant activation.

BrainCapture reçoit RADAR_JOBS_URL, RADAR_JOBS_TOKEN, RADAR_AUTOMATA_URL,
RADAR_AUTOMATA_TOKEN. Les tokens restent sur le serveur et ne sont jamais rendus au
navigateur. Les lectures sont regroupées et mises en cache une minute, avec un délai
de dix secondes et échec indépendant par source. Un schéma et l’égalité somme des
segments = total sont vérifiés avant affichage. Le total emploi exclut les doublons.
Le total Automata compte les entreprises analysées hors agences d’intérim, comme les
filtres du radar. Les compteurs suivent les états actuels, pas un entonnoir historique.

Non connecté, indisponible et zéro réel sont trois états distincts. Une source en panne
ne bloque ni l’autre source ni la capture.

## Validation et activation

`npm run typecheck`, `npm test`, `npm run build`, puis `node scripts/check-today.mjs`.
Le dernier contrôle utilise une base en mémoire, des sources HTTP factices et des
événements Calendar de démonstration. Il ne prouve pas une autorisation Google réelle.

Avant mise en ligne : review Codex du HEAD de chacune des trois PR, accord de Julien,
sauvegarde de BrainCapture, configuration des deux tokens dédiés et de Google, puis
déploiement des radars et de BrainCapture. La migration BrainCapture est additive,
créant uniquement projets, liens et connexions Calendar. Aucun test n’écrit en production.
Après déploiement, comparer les compteurs aux radars, vérifier l’état des captures,
puis laisser Julien consentir chez Google et vérifier sa vraie journée.
