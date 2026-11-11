import type { FastifyInstance } from 'fastify';

// Two public pages, readable without signing in: Google requires a homepage and a privacy
// policy on the app's own domain before an OAuth app can leave "Testing". They are plain
// server-rendered HTML (no app shell, no script), so Google's checks and any browser read
// them as is. The service worker leaves them alone (see vite.config.ts).

export const PUBLIC_PAGES = ['/about', '/privacy'] as const;
const UPDATED = '11 novembre 2026';

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="Brain Capture, application personnelle de prise de notes vocales et de liens.">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0d0c0b; color: #f1f0ec; font: 16px/1.6 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  main { max-width: 680px; margin: 0 auto; padding: 40px 16px 64px; }
  h1 { font-size: 28px; line-height: 1.2; margin: 0 0 8px; letter-spacing: -0.02em; }
  h2 { font-size: 18px; margin: 32px 0 8px; }
  p, li { color: #d6d5d0; }
  a { color: #ffad52; }
  .muted { color: #86878e; font-size: 14px; }
  nav { display: flex; gap: 16px; margin-bottom: 32px; font-size: 14px; }
</style>
</head>
<body>
<main>
<nav><a href="/about">Brain Capture</a><a href="/privacy">Confidentialité / Privacy</a><a href="/">Ouvrir l’app</a></nav>
${body}
</main>
</body>
</html>`;
}

const ABOUT = page(
  'Brain Capture',
  `<h1>Brain Capture</h1>
<p>Application personnelle pour noter une idée, une tâche ou un lien au moment où il arrive, surtout à la voix depuis le téléphone, et le retrouver rangé plus tard sur l’ordinateur.</p>
<p>C’est un outil privé : un seul compte, celui de son propriétaire. Il n’y a pas d’inscription publique.</p>
<h2>Google Agenda</h2>
<p>Avec l’accord explicite du propriétaire, l’app lit son agenda Google pour afficher sa journée, et ajoute à son agenda principal un événement qu’il a dicté puis confirmé d’un tap. Rien n’est écrit dans l’agenda sans cette confirmation.</p>
<p><a href="/privacy">Règles de confidentialité</a></p>
<p class="muted" lang="en">Brain Capture is a private, single-user app for quick voice and text notes. With the owner’s consent it reads their Google Calendar to show the day and adds events the owner dictated and confirmed. <a href="/privacy">Privacy policy</a>.</p>`,
);

const PRIVACY = page(
  'Règles de confidentialité · Brain Capture',
  `<h1>Règles de confidentialité</h1>
<p class="muted">Dernière mise à jour : ${UPDATED}</p>
<p>Brain Capture est une application personnelle à compte unique. Ses seules données sont celles de son propriétaire. Elles ne sont ni vendues, ni louées, ni partagées à des fins publicitaires.</p>

<h2>Données conservées</h2>
<ul>
<li>Les captures : textes, liens, transcriptions de notes vocales, titres et catégories.</li>
<li>L’audio d’une note vocale n’est pas conservé : il est envoyé pour transcription puis effacé.</li>
<li>Stockage : base PostgreSQL hébergée chez Railway. Les sauvegardes sont des fichiers privés du propriétaire.</li>
</ul>

<h2>Traitements par des services tiers</h2>
<ul>
<li><strong>Groq</strong> transcrit l’audio et lit le texte des captures pour les ranger et pour comprendre une demande d’ajout à l’agenda.</li>
<li><strong>Railway</strong> héberge l’application et sa base de données.</li>
</ul>

<h2>Données Google</h2>
<p>Avec le consentement explicite du propriétaire, l’app accède à son compte Google Agenda :</p>
<ul>
<li>lecture de la liste des agendas et des événements, pour afficher la journée ;</li>
<li>création, dans l’agenda principal, d’un événement que le propriétaire a demandé puis confirmé dans l’app.</li>
</ul>
<p>Le jeton d’accès Google est chiffré (AES-256-GCM) dans la base. Il n’est jamais exporté dans les sauvegardes. Les données lues dans Google Agenda servent uniquement à l’affichage dans l’app. Elles ne sont transmises à aucun service tiers, aucun modèle d’IA compris, et ne servent à aucun entraînement.</p>
<p>L’utilisation et le transfert, par Brain Capture, des informations reçues des API Google respectent les <a href="https://developers.google.com/terms/api-services-user-data-policy">règles relatives aux données utilisateur des services d’API Google</a>, y compris les exigences d’utilisation limitée (« Limited Use »).</p>

<h2>Supprimer ou retirer l’accès</h2>
<ul>
<li>« Déconnecter » dans l’app supprime le jeton Google stocké.</li>
<li>L’accès peut aussi être retiré à tout moment depuis <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</li>
<li>Le propriétaire peut supprimer ses captures, et l’ensemble des données en supprimant le service.</li>
</ul>

<h2>Contact</h2>
<p>Via l’adresse d’assistance affichée sur l’écran de consentement Google de l’application.</p>

<h2 lang="en">In English</h2>
<div lang="en">
<p class="muted">Brain Capture is a private, single-user app. It stores the owner’s notes, links and transcripts on Railway; audio is transcribed by Groq and not kept. With the owner’s consent, it reads their Google Calendar list and events to display their day, and creates events in their primary calendar only after they confirm them. The Google token is stored encrypted and never exported. Google user data is used only to show it in the app, is not shared with third parties or AI models, and is not used for training or advertising.</p>
<p class="muted">Brain Capture’s use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. Access can be revoked in the app (Disconnect) or at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>
</div>`,
);

export function registerPublicPages(app: FastifyInstance): void {
  for (const [url, html] of [
    ['/about', ABOUT],
    ['/privacy', PRIVACY],
  ] as const) {
    app.get(url, async (_req, reply) =>
      reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('Cache-Control', 'public, max-age=300')
        .header('X-Content-Type-Options', 'nosniff')
        .send(html),
    );
  }
}
