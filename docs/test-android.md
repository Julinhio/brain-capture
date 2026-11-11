# Test Android de Brain Capture

Déploiement de test : https://brain-capture-production-8fa2.up.railway.app
Compte : julinhio@hotmail.com, mot de passe dans le presse-papiers (et dans `dev-secrets\brain-capture\.env`, ligne `OWNER_PASSWORD`).
Version déployée : branche `feat/pwa-share`, au commit annoncé par Ben à chaque déploiement. Ce test ne vaut pas validation des PR 2 à 4.

Note pour chaque étape : OK, KO (avec ce que tu as vu), ou capture d'écran.

## 1. Installation
1. Sur le téléphone, ouvre l'URL dans **Chrome**.
2. Connecte-toi (colle le mot de passe ; propose à Chrome ou à ton gestionnaire de l'enregistrer).
3. Menu ⋮ puis **Installer l'application** (ou « Ajouter à l'écran d'accueil » puis « Installer »).
4. Ferme Chrome et ouvre **Brain Capture depuis l'icône** : l'app doit s'ouvrir en plein écran, sans barre d'adresse, directement sur le gros micro.

## 2. Voix
1. Appuie sur le micro, **autorise le micro** quand Android le demande.
2. Parle 15 à 20 s en français, par exemple : « Demain, penser à regarder cette offre d'emploi chez Qonto. » Appuie sur Stop.
3. Attendu : « Saving… », puis **Saved** avec un titre court, une catégorie et la transcription.
4. Recommence en anglais.
5. Vérifie : Edit sur la transcription, Change sur la catégorie, Record another.
6. Optionnel : pendant un enregistrement, change d'app puis reviens. L'enregistrement s'arrête et ce qui a été dit est gardé.

## 3. Texte et lien
1. Text : écris une note, Save.
2. Link : colle une URL d'offre, ajoute une note, Save. Le lien doit s'ouvrir depuis l'écran Saved.

## 4. Partager depuis une autre app
1. Dans **Chrome**, ouvre une offre d'emploi, Partager, choisis **Brain Capture**.
2. Dans **LinkedIn**, sur une offre ou un post : Partager, puis « Envoyer via… » ou « Plus », choisis **Brain Capture**.
3. Attendu : l'app s'ouvre, enregistre le lien, affiche Saved.
4. Si Brain Capture n'apparaît pas dans la liste : attends quelques minutes après l'installation, redémarre le téléphone, puis réessaie. Note ce que tu vois. Le collage manuel (Link) reste le recours.

## 5. Sans réseau
1. Active le mode avion, ouvre l'app depuis l'icône : elle doit s'ouvrir.
2. Fais une note texte : « Not saved yet », choisis Keep it for later.
3. Coupe le mode avion, rouvre l'app : la note part toute seule, le bandeau disparaît.

## 6. Sur le PC
1. Ouvre l'URL sur ton ordinateur et connecte-toi.
2. Attendu : tes captures du téléphone rangées par catégorie.
3. Ouvre une carte : change la catégorie, corrige le texte, puis Mark done. Recharge la page : tout doit être conservé.
4. Sur le téléphone, History : les changements faits sur le PC doivent apparaître (après rechargement).

## 7. Ajouter à l’agenda
Prérequis : Google reconnecté avec l’accès aux événements (la carte propose « Reconnecter Google » sinon).
1. Micro : « Mets dans mon agenda dentiste mardi prochain à 15 h ». Attendu : carte « Ajouter à l’agenda », titre Dentiste, ligne « mar. … · 15:00 → 16:00 » sur le bon mardi.
2. Appuie sur « Ajouter à l’agenda ». Attendu : « Dans ton agenda » et un lien ; l’événement est dans Google Agenda à 15 h, la transcription en description.
3. Appuie de nouveau, ou recharge et rouvre la capture depuis History : toujours un seul événement.
4. Micro en anglais : « Add to my calendar lunch with Sarah on Friday at 12:30 ». Attendu : carte juste, en anglais.
5. Micro : « Demain, penser à regarder cette offre ». Attendu : aucune carte.
6. Sur le PC, Ma journée lit toujours le calendrier.

## Limites connues
- Pas d'audio conservé : seul le texte est gardé, l'audio est effacé du téléphone après la sauvegarde.
- Les nouveaux essais d'envoi se font quand l'app est ouverte, pas en arrière-plan.
- Groq gratuit : une dizaine de classements par minute au plus. Au-delà, la capture est sauvée sous Other et reclassée dans les minutes qui suivent.
- Les noms propres peuvent être mal transcrits (« Qonto » devient « Conto ») : correction possible avec Edit.
