# Améliorations futures

Points connus, acceptés pour la version actuelle, à reprendre plus tard. Chaque entrée dit d'où elle vient et qui l'a décidée.

## Accepté pour cette version

- **« Record again » sans effet si le stockage local est indisponible** (Codex, round 5 de la PR #2 ; accepté par Julien le 2026-11-02). Après un enregistrement refusé (silence par exemple), le bouton supprime d'abord la copie locale ; si IndexedDB ne répond pas, la suppression échoue et l'enregistrement ne redémarre pas. Il faut cumuler stockage plein ou bloqué et enregistrement refusé. Correctif d'une ligne : `discard(...).catch(() => undefined).then(startRecording)`, comme le fait déjà « Discard ».

- **Focus clavier non retenu dans le tiroir de détail desktop** (Codex, round 5 de la PR #3 ; accepté par Julien le 2026-11-02 pour cette version personnelle). Le tiroir se déclare modal (`aria-modal`), mais Tab peut atteindre la page derrière. Ne touche que la navigation clavier et les lecteurs d'écran ; la feuille de saisie mobile a le même schéma. Correctif prévu : rendre l'arrière-plan `inert` tant que le tiroir ou la feuille est ouvert.

## En attente de retours d'usage

- **Lexique de noms propres pour Whisper** (décision de Julien le 2026-11-02 : attendre l'usage). « Qonto » est transcrit « Conto » ; Groq accepte un `prompt` de transcription pour orienter le vocabulaire (Qonto, Doctolib, Automata, n8n…).
- **Groq gratuit** (décision de Julien : rester sur l'offre gratuite). Environ dix classements par minute ; au-delà la capture est sauvée sous Other et reclassée par le serveur dans les minutes qui suivent. À revoir si des rafales de partage deviennent courantes.

## Limites connues

- Les nouveaux essais d'envoi ne tournent que lorsque l'app est ouverte ; rien en arrière-plan.
- Effacer les données du site sur le téléphone supprime les captures qui attendent encore d'être envoyées.
- Sauvegarde et restauration de PostgreSQL : procédure à documenter (outil, fréquence, coûts, limites).
