# Catégories

## Ce que fait l’app

Chaque compte a sa propre liste de catégories, modifiable dans l’app : barre latérale du
desktop, icône à côté de « Categories » (`/?view=categories`, accessible aussi sur
téléphone). Chaque catégorie a un nom et une courte description de ce qui y va.

- **Ajouter** : nom et description. Elle est proposée au classement dès la capture suivante,
  sans toucher au code. Les captures existantes ne bougent pas.
- **Renommer, reformuler** : aucune capture ne bouge. L’identifiant interne de la catégorie
  ne change jamais (`jobs` reste `jobs` si Jobs devient Career).
- **Supprimer** (avec confirmation) : ses captures, ouvertes ou terminées, sont archivées et
  passent dans Other, dans la même transaction. Elles restent lisibles dans Archived ; une
  capture rouverte revient donc dans Other. Rien n’est supprimé.
- **Other** est fixe : ni renommée, ni supprimée, description non modifiable. C’est là que va
  tout ce que le classement ne sait pas placer.

Liste de départ (décision de Julien, 13/11/2026) : Jobs, Automata, Projects, Learning,
Lifestyle, Other. Leur description reprend ce que le prompt de classement disait de chacune :
le sous-titre court (« Offers & applications ») puis le guide détaillé. Les deux comptent : avec
le guide seul, « Marc me présente à son cabinet comptable qui ressaisit ses factures » partait
dans Jobs au lieu d’Automata (3 essais sur 3, Groq, 13/11) ; avec les deux, de nouveau Automata. Une nouvelle
catégorie reçoit l’icône étiquette et la première couleur libre d’une petite palette.

## Classement

Le prompt (`src/server/ai/classify-prompt.ts`) liste les catégories du compte au moment de
l’appel : identifiant, nom et description, Other en dernier. Le modèle répond avec
l’identifiant (le nom exact est aussi accepté). Une réponse hors liste est rejetée et la
capture reste dans Other, comme avant.

**Les descriptions décident.** Deux catégories dont les descriptions se recouvrent se
disputent les mêmes notes. Exemple réel (13/11, Groq) : après création de « Santé »
(médecins, kiné, sport, sommeil), « racheter du magnésium et me coucher avant 23 h » partait
encore dans Lifestyle, dont la description de départ cite « sport, health ». Une fois ces
deux mots retirés de Lifestyle, tout est classé comme attendu. En créant une catégorie,
relire celles qui couvraient déjà le sujet.

Course possible : une catégorie supprimée pendant que le modèle répond. La base refuse alors
d’y ranger la capture (clé étrangère), la tentative compte comme un échec et le balayage la
reclasse avec la liste à jour. Rien n’est perdu.

## Données

- Table `categories`, clé `(owner_id, id)`, nom unique par compte sans tenir compte de la
  casse. `captures.category` est un identifiant de catégorie du même compte, garanti par une
  clé étrangère composite.
- Migration `0004` : crée la table, donne la liste de départ à chaque compte existant puis,
  par un déclencheur sur `users`, à tout compte créé ensuite ; convertit l’ancienne colonne
  enum en texte sans changer aucune valeur. Testée sur une base au schéma de production
  (`tests/categories.test.ts`).
- Les identifiants ne prennent jamais un mot déjà utilisé dans les adresses de l’app
  (`done`, `archived`, `everything`, `workspace`, `today`, `categories`, `all`, `open`,
  `other`) : « Done » devient `done-2`.

## Sauvegarde

L’export inclut les catégories (champ `categories`, ajout au format v1). À l’import :
- une catégorie absente est ajoutée ; une catégorie présente n’est pas modifiée, sauf une
  catégorie de départ jamais retouchée (compte neuf), qui reprend le nom et la description
  de la sauvegarde ;
- une capture dont la catégorie n’existe pas (ou plus) arrive dans Other ;
- les anciens fichiers, sans catégories, restent acceptés ;
- l’import ne supprime toujours rien : une catégorie supprimée après la sauvegarde revient
  si la sauvegarde la contient.

## Vérifier

- `npm test` : `tests/categories.test.ts` (migration sur données existantes, création,
  classement, renommage, suppression, isolation entre comptes, sauvegarde),
  `tests/classify-prompt.test.ts`.
- `npx tsx --env-file=<fichier avec GROQ_API_KEY> scripts/eval-new-category.ts` : instance
  isolée en mémoire, une catégorie créée par l’API puis classée par le vrai modèle.
- `node scripts/check-categories-delete.mjs` (après `npm run build`) : parcours navigateur.
