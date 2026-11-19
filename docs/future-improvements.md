# Améliorations futures

Points connus, acceptés pour la version actuelle, à reprendre plus tard. Chaque entrée dit d'où elle vient et qui l'a décidée.

## Accepté pour cette version

- ~~« Record again » sans effet si le stockage local est indisponible~~ (PR #2, accepté le 2026-11-02). Levé le 2026-11-03 : « Record again » ne supprime plus la note refusée, il démarre simplement un nouvel enregistrement.

- **Focus clavier non retenu dans le tiroir de détail desktop** (Codex, round 5 de la PR #3 ; accepté par Julien le 2026-11-02 pour cette version personnelle). Le tiroir se déclare modal (`aria-modal`), mais Tab peut atteindre la page derrière. Ne touche que la navigation clavier et les lecteurs d'écran ; la feuille de saisie mobile a le même schéma. Correctif prévu : rendre l'arrière-plan `inert` tant que le tiroir ou la feuille est ouvert.

## En attente de retours d'usage

- **Lexique de noms propres pour Whisper** (décision de Julien le 2026-11-02 : attendre l'usage). « Qonto » est transcrit « Conto » ; Groq accepte un `prompt` de transcription pour orienter le vocabulaire (Qonto, Doctolib, Automata, n8n…).
- **Groq gratuit** (décision de Julien : rester sur l'offre gratuite). Environ dix classements par minute ; au-delà la capture est sauvée sous Other et reclassée par le serveur dans les minutes qui suivent. À revoir si des rafales de partage deviennent courantes.

- **Projections de poids** (brief du 19/11/2026 : pas dans cette version). La courbe et les calories par jour sont là ; une tendance projetée viendra plus tard si l'usage le demande.
- **Photos sur les notes** (choix de Ben le 19/11/2026, à confirmer par l'usage). Une photo qui n'est ni un repas, ni une balance, ni un écran de sport devient une note avec le texte lu dans l'image ; l'image elle-même n'est pas gardée. Garder des images sur les notes demanderait du stockage et un affichage dédiés.

## Limites connues

- Nutrition : toutes les valeurs sont des estimations. Les quantités non dites sont des portions usuelles, et une photo ne dit ni l'huile de cuisson ni la taille réelle de l'assiette. Voir `docs/nutrition.md`.
- Groq gratuit, photos : environ deux photos par minute (une image compte pour 2 000 tokens sur 8 000 par minute). La troisième attend sur le téléphone et repart seule.

- Les nouveaux essais d'envoi ne tournent que lorsque l'app est ouverte ; rien en arrière-plan.
- Effacer les données du site sur le téléphone supprime les captures qui attendent encore d'être envoyées.
- Sauvegardes manuelles tant qu'aucune tâche planifiée ni sauvegarde Railway n'est activée (voir `docs/backup-restore.md`).
