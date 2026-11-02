# Brain Capture : première version personnelle utilisable

Date : 2 novembre 2026. Brief préparé par Alex avec Julien. Implémentation : Ben.
Projet local : `C:\dev-projects\brain-capture`, initialement vide.
Ce brief intègre les décisions après les maquettes et remplace le périmètre plus étroit du cadrage initial.

## Besoin et résultat

Julien veut déposer une idée, une tâche, une ressource ou une offre d'emploi dès qu'elle apparaît, souvent sur son téléphone, sans interrompre son activité pour la classer. Sur ordinateur, il veut retrouver ses captures déjà catégorisées et décider quoi en faire.

Livrer une PWA privée installable sur Android et utilisable sur desktop, avec des données communes persistantes. C'est un outil personnel et un projet d'apprentissage de bout en bout. Aucun paiement, abonnement, inscription publique ou lancement commercial dans cette version.

## Première action : skills et contexte

- Installer et lire **UI UX Pro Max** avant le travail d'interface : https://github.com/nextlevelbuilder/ui-ux-pro-max-skill . Suivre l'installation Claude Code documentée dans le dépôt, vérifier que le skill est effectivement disponible, préserver toute configuration préexistante.
- Charger **emil-design-eng**, déclaré déjà installé par Julien, pour les interactions, tiroirs, états des boutons et transitions. Vérifier sa présence ; signaler une absence réelle sans inventer ses consignes.
- UI UX Pro Max sert la cohérence visuelle ; Emil sert la qualité des interactions. Les préférences produit de Julien priment sur des recommandations génériques.
- Consulter les règles Brain applicables à Ben et le mod `codex-review` installé dans son environnement. Alex n'a installé aucun de ces skills dans ce dossier.

## Périmètre de la version utilisable

Les capacités peuvent arriver dans plusieurs PR cohérentes, à ton initiative. Il ne faut pas livrer une maquette simulée comme une application fonctionnelle.

### Capture sur Android

- Ouverture orientée capture : un grand microphone, des actions secondaires Text et Link, un accès discret à l'historique et aux dernières captures.
- Démarrer, arrêter ou annuler l'enregistrement ; durée et état lisibles ; transcription après arrêt, en français et en anglais.
- Enregistrement envoyé au backend et transcrit par Groq Whisper ; sauvegarde persistante du texte. Conserver le texte original et permettre de le corriger.
- Capture de texte et collage d'une URL fonctionnels, avec conservation du lien ouvrable. L'enregistrement d'un lien n'exige pas le scraping de son contenu, et une page inaccessible ne doit pas faire perdre la capture.
- Le menu Partager d'Android vers la PWA est important, notamment depuis LinkedIn et Chrome. L'anticiper dès la conception et viser son intégration dans la version utilisable, sans l'imposer à la première PR. Vérifier le comportement réel ; si une limite de plateforme l'empêche, expliquer précisément le résultat et conserver le collage manuel opérationnel. Ne pas déclarer cette capacité validée sans preuve.
- Après sauvegarde : confirmation, titre court, transcription ou note, catégorie corrigeable et possibilité de capturer à nouveau.

### Classement et consultation desktop

- Classement automatique, sans passage obligatoire par une inbox à trier. L'IA propose une catégorie et un titre court sans altérer le contenu original ni inventer une action ou une date.
- Catégories initiales : Jobs, Automata, Projects, Learning, Lifestyle, Other. Ce sont des rubriques de départ, pas un système de catégories personnalisables à développer dès maintenant.
- Other reçoit les captures ambiguës ou non classables. Une correction manuelle reste toujours possible ; un classement en échec ne doit pas empêcher de sauvegarder et retrouver la capture.
- Accueil desktop par sections de catégories, avec cartes lisibles, aperçu court et origine voice/text/link. Accès à l'ensemble des éléments d'une catégorie, même si l'accueil en limite l'aperçu.
- Détail dans un tiroir à droite : contenu, source et lien, catégorie modifiable, édition, action de terminer et archivage. Une idée ou une ressource n'est pas automatiquement une tâche obligatoire. Distinguer fermeture du détail et tâche terminée.
- Pas d'échéance obligatoire ni d'échéance inventée. Les échéances avancées ne sont pas nécessaires à cette version.
- Les captures et modifications effectuées depuis un appareil doivent être retrouvées sur l'autre ; pas de contrainte de temps réel si un rafraîchissement suffit.

## Direction visuelle et références

Toutes les chaînes d'interface sont en anglais. Les notes capturées conservent leur langue originale, sans traduction automatique imposée.

Thème sombre cohérent sur mobile et desktop, typographie sans serif, hiérarchie nette, simplicité et accent chaleureux discret. La référence mobile est la direction visuelle préférée. Les couleurs précises, composants, espaces et détails restent à ton jugement et aux skills.

Références locales dans `docs/references/` :
- `mobile-capture-recording.png` : intention de l'accueil et de l'enregistrement.
- `mobile-saved.png` : confirmation et correction après sauvegarde.
- `mobile-processing-offline.png` : intentions de retour d'état, pas une garantie technique de reprise automatique.
- `desktop-dashboard.png` : structure par catégories à conserver comme inspiration, thème clair et typographie serif à remplacer.
- `desktop-drawer.png` : ouverture du détail à droite ; retirer le lecteur audio.

Les captures servent de références de parcours, pas de spécifications au pixel. Utiliser du contenu de démonstration uniquement en développement, jamais comme de vraies captures utilisateur.

## Fiabilité, accès et données

- Accès privé authentifié, sans inscription publique ; notes et opérations réservées au propriétaire, vérification côté serveur.
- Ne jamais afficher Saved avant confirmation de persistance. Distinguer enregistrement local, traitement, sauvegarde et classement lorsque nécessaire.
- Concevoir les erreurs et la reprise pour éviter une perte silencieuse ou des doublons après un nouvel essai. Tu choisis la solution technique proportionnée.
- Pas de conservation audio durable ni de lecteur de replay dans cette version. Audio temporaire possible pour le traitement ou la reprise, avec cycle de vie explicite et nettoyage après sauvegarde réussie ou abandon. Documenter les limites en cas de fermeture ou interruption.
- La maquette promet une conservation locale et une reprise automatique hors connexion. Valider leur faisabilité avant de les promettre dans l'interface ; ne pas construire un moteur complet de synchronisation hors ligne sans besoin démontré. Si un compromis change le parcours attendu, le remonter clairement.
- Permissions microphone refusées, interruption et réseau indisponible : messages compréhensibles, recours texte ou nouvel essai lorsque possible.
- Clés API et accès PostgreSQL exclusivement côté serveur ; aucun secret dans le frontend, les logs, les captures ou Git. Ne pas écrire dans les données des autres projets pour tester.
- PostgreSQL conserve les captures après redéploiement. Prévoir un moyen raisonnable de sauvegarde/restauration et en documenter les limites et coûts.

## Cadre technique et accès

- Base retenue, ouverte à un changement justifié : React/Vite/TypeScript, Node.js/Fastify, PostgreSQL, PWA. Drizzle est une piste, pas une obligation. Tu maîtrises structure, schéma, routes, composants, bibliothèques et ordre de réalisation.
- Railway exclusivement pour l'hébergement, de préférence un service applicatif et un PostgreSQL. Pas de Make, Redis ou service supplémentaire sans utilité démontrée.
- Groq Whisper pour la transcription. Choisir un modèle de classement peu coûteux, en tenant compte des accès disponibles et des données personnelles ; expliquer brièvement le choix et estimer les coûts usuels.
- Nouveau dépôt privé sur le compte GitHub personnel de Julien, nom suggéré `brain-capture`, hors organisation. Aucun dépôt distant ou projet Railway n'a encore été créé ou vérifié par Alex pour cette application.
- Aucun secret dédié `brain-capture` n'a été préparé. Julien dispose d'un usage Groq via OpenWhispr, mais l'accès à cette clé dans ta session n'est pas garanti. Vérifier les outils et accès existants avant de solliciter Julien. Ne pas copier de clés d'autres projets ou publier leurs valeurs sans autorisation.
- Emplacement conseillé pour les secrets dédiés : `C:\Users\julin\OneDrive\Documents\dev-secrets\brain-capture\.env`, absent à la préparation du brief. Aucun identifiant de connexion privé dans ce document.
- Vérifier le compte personnel GitHub, le workspace personnel Railway et les accès API. Faire avancer le travail local en attendant les accès manquants ; signaler les blocages externes sans les masquer par des simulations présentées comme réelles.
- Avant toute création de ressource payante, publication, déploiement ou action de production, présenter la cible et obtenir l'accord explicite de Julien. Ne pas modifier les services Automata, Radar Emploi ou ceux de son ancienne entreprise.

## Preuves attendues

- Vérifications de build et tests proportionnés aux risques : isolation des données, sauvegarde et reprises, classement défaillant, routes privées ; pas uniquement un build réussi.
- Vérification navigateur du parcours desktop et du rendu mobile, y compris les états d'erreur utiles. Rapporter ce qui a réellement été testé et les limites.
- Sur le vrai Android de Julien : installation depuis une URL HTTPS, ouverture depuis l'icône, permission micro, capture réelle, transcription et consultation sur desktop. Préparer une consigne courte pour le test utilisateur ; ne pas prétendre avoir testé son appareil si tu ne peux pas l'utiliser.
- Vérifier capture texte, capture lien, catégorie automatique et correction, édition, terminé/archivé, persistance après rechargement et redéploiement autorisé.
- Valider séparément le menu Partager depuis Android ; fournir la preuve ou l'état bloqué avec contournement.
- Fournir l'URL, l'état de livraison, les tests réellement passés, les points ouverts, les coûts à surveiller et une procédure courte d'installation sur Android. Aucun merge sur la seule foi de la maquette ; si une validation sur le téléphone est requise, attendre le retour de Julien avant le merge concerné.

## Hors périmètre

Paiement, multi-utilisateur public, applications natives et stores, photos/documents, RAG, recherche conversationnelle, briefing IA quotidien, Calendar/Gmail/Todoist/Claude Brain, automatisations Make, analytics et gamification. Une recherche simple ou un filtre utile reste à ton appréciation sans transformer cette version en second cerveau complet.

Ce brief n'impose ni découpage détaillé du code ni séquence de PR. Pose les questions de cadrage nécessaires avant de coder et challenge l'approche si ton exploration révèle une contrainte, une incohérence ou une solution plus adaptée.
