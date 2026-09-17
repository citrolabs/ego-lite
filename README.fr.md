<div align="center">

<img src="docs/assets/banner.png" alt="ego lite" width="100%" />

**Le navigateur le plus rapide pour automatiser le web avec des agents IA**

<a href="https://trendshift.io/repositories/42334?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-42334" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/42334" alt="citrolabs%2Fego-lite | Trendshift" width="250" height="55"/></a>

<p>
  <a href="https://cdn.ego.app/setup/macos/arm64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/Download-Apple%20Silicon-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for Apple Silicon" /></a>
  <a href="https://cdn.ego.app/setup/macos/x64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/Download-Intel-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for Intel" /></a>
  <a href="https://discord.gg/5eGZVvHbTq"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" /></a>
  <a href="https://x.com/ego_agent"><img src="https://img.shields.io/badge/Follow-%40ego__agent-000000?style=for-the-badge&logo=x&logoColor=white" alt="Follow @ego_agent on X" /></a>
  <a href="https://lite.ego.app/document/"><img src="https://img.shields.io/badge/Docs-lite.ego.app-1E90FF?style=for-the-badge&logo=gitbook&logoColor=white" alt="Docs" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-3DA639?style=for-the-badge" alt="License MIT" /></a>
</p>

<p>
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.es.md">Español</a> ·
  <b>Français</b> ·
  <a href="README.it.md">Italiano</a> ·
  <a href="README.ru.md">Русский</a>
</p>

</div>

ego (lite) est un navigateur où vous et vos agents IA travaillez en parallèle. Vos agents exécutent leurs tâches navigateur dans leurs propres Spaces pendant que vous continuez à naviguer dans le vôtre : aucun agent ne vous prend jamais le navigateur. Et l'automatisation elle-même se termine plus vite, pour moins de jetons.

Les outils existants comme browser-use et agent-browser sont un pont vers le navigateur, pas un navigateur à eux : ils n'en embarquent aucun et doivent donc en piloter un autre. Vos données de navigation se transfèrent rarement intactes, la connexion est instable, et vous finissez par vous disputer le contrôle du navigateur avec l'agent. ego lite est un seul navigateur, pensé dès le départ pour être partagé entre vous deux. Aucune configuration supplémentaire, et l’agent accède toujours à vos vrais identifiants et onglets via `ego-browser`.

## Démo

https://github.com/user-attachments/assets/ffe7954b-58ee-411e-b35d-ec30c58a08bc

## Démarrage rapide

ego lite fonctionne aujourd'hui sur macOS, une bêta fermée pour Windows arrive bientôt, et Linux figure sur la [feuille de route](https://lite.ego.app/roadmap).

### 1. Installer

Choisissez ce qui convient le mieux à votre façon de travailler.

**1.1 Télécharger l'application macOS**

<a href="https://cdn.ego.app/setup/macos/arm64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/⬇%20Apple%20Silicon-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download ego lite for Apple Silicon" /></a>
<a href="https://cdn.ego.app/setup/macos/x64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/⬇%20Intel-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download ego lite for Intel" /></a>

Cliquez pour télécharger, puis ouvrez le fichier pour installer. Dans un cas comme dans l'autre, ego lite ajoute la Skill `ego-browser` au répertoire de Skills de chaque agent installé sur votre machine.

**1.2 Ajouter la Skill avec npx**

Installez uniquement la Skill `ego-browser` :

```bash
npx skills add citrolabs/ego-lite
```

La première fois que votre agent exécute une tâche navigateur, il vous guide dans l'installation de l'application ego lite.

**1.3 Laisser votre agent s'en charger**

Collez ceci dans votre agent :

```
Configure ego lite pour moi : https://github.com/citrolabs/ego-lite

Lis `skills/ego-browser/references/install.md` et suis les étapes pour installer ego lite.
```

Au premier lancement, ego lite ne pose qu'une seule question : faut-il migrer vos données Chrome. Répondez oui, et votre agent hérite de vos sessions, cookies, extensions et favoris existants.

### 2. Lancer votre première tâche

Dans la CLI de votre agent, tapez `/ego-browser` suivi d'un espace, puis décrivez ce que vous voulez en langage naturel :

```
ego-browser suis @ego_agent sur x.com pour moi
```

L'agent charge la Skill `ego-browser`, ouvre la page dans son propre Space, lit un Snapshot, agit sur la page et vous fait son rapport, pendant que vos onglets restent intacts.

Vos données de navigation, vos cookies et tout ce que contient le navigateur restent sur votre appareil. ego lite limite volontairement sa collecte de données : quelques signaux produit simples, comme le fait d'avoir défini ego lite comme navigateur par défaut.

## Points forts d'ego lite

| Fonctionnalité | Ce qu'elle fait |
|---|---|
| **Piloté par code, pas par CLI : des exécutions plus rapides et moins de jetons sur les tâches complexes** | Les capacités qu'ego lite expose à l'agent sont encapsulées dans des fonctions JavaScript que l'agent appelle directement. L'agent fait alors ce qu'il fait de mieux : écrire du code, et composer une tâche en plusieurs étapes dans une seule sortie au lieu de s'enfermer dans une boucle « appeler deux commandes, regarder le résultat, en appeler deux autres ». Par rapport à l'approche CLI classique, les workflows complexes se terminent bien plus vite, avec un meilleur taux de réussite, beaucoup moins d'appels d'outils par tâche et un coût par tâche nettement inférieur. |
| **Un Space dédié à chaque agent** | ego lite attribue à chaque agent son propre Space, totalement isolé. Vous naviguez au premier plan, votre agent travaille en arrière-plan, et aucun ne gêne l'autre. Vous voyez à tout moment quel Space fait tourner un agent, et vous pouvez en prendre la main ou l'arrêter quand vous le souhaitez. |
| **Vos agents mènent plusieurs tâches de front dans les Spaces, des espaces de travail parallèles dans un même navigateur** | Chaque Space accueille son propre agent IA ou sa propre tâche, tous en même temps. Claude Code enrichit 10 prospects dans 10 Spaces parallèles. Codex scrape 5 sites concurrents dans 5 autres. Ils ne se marchent pas dessus et ne volent pas vos onglets. Votre souris reste là où vous l'avez laissée. |
| **Le Snapshot de page le plus performant du marché** | Grâce à une personnalisation au niveau du noyau, ego lite produit les Snapshots de page de la plus haute qualité, cette vue sur laquelle s'appuient les modèles de texte pour « voir » une page web et agir dessus. Il gère de façon fiable les cas difficiles comme les iframes profondément imbriquées, précisément là où les autres approches échouent systématiquement. |
| **N'importe quel agent peut le piloter via `ego-browser`** | `ego-browser` est la couche de connexion entre n'importe quelle CLI d'agent (Claude Code, Codex, Cursor ou la vôtre) et ego lite. Elle expose le navigateur comme un ensemble d'outils JavaScript in-page : snapshot, fill, click, wait, navigate, capture. L'agent écrit un extrait JavaScript qui appelle ces outils, et `ego-browser` l'exécute sur la page en une seule passe. |
| **Une accumulation d'expérience qui accélère votre agent au fil de l'usage** *(bientôt disponible)* | L'essentiel du temps qu'un agent passe sur des tâches navigateur se perd en essais et erreurs. La Skill officielle d'ego lite distille chaque action réussie en outils et workflows réutilisables : les tâches similaires s'exécutent ensuite jusqu'à 5x plus vite. |

## ego lite face aux produits existants

La plupart des outils savent automatiser un navigateur. Les vraies questions sont : quel navigateur l'agent obtient-il, pouvez-vous continuer à travailler en même temps, et l'outil est-il conçu pour l'agent que vous utilisez déjà ou pour un agent intégré ?

| Capacité | ego lite | Browser-Use | agent-browser (Vercel) | ChatGPT Atlas | Perplexity Comet |
|---|:---:|:---:|:---:|:---:|:---:|
| Multitâche en parallèle | ✓ | — | — | — | — |
| Compétences réutilisables | ✓ | — | — | — | — |
| Reprend les données de Chrome | ✓ | — | — | ✓ | ✓ |
| Le même navigateur, un espace de travail séparé | ✓ | — | — | — | — |
| Entrée sémantique compressée | ✓ | — | ✓ | — | — |
| Pilotable par des agents externes | ✓ | ✓ | ✓ | — | — |
| Données stockées en local | ✓ | ✓ | ✓ | — | — |
| Aucune friction de connexion | ✓ | — | — | ✓ | ✓ |
| Navigateur du quotidien | ✓ | — | — | ✓ | ✓ |
| Gratuit | ✓ | ✓ | ✓ | — | — |

Deux autres catégories tentent de résoudre le même problème. Les frameworks d'automatisation comme Browser-Use et agent-browser de Vercel sont des bibliothèques que l'agent appelle ; ils ne fournissent aucun navigateur en propre, il leur faut donc un navigateur séparé à piloter, et vos sessions connectées se transfèrent rarement proprement. Les navigateurs IA comme ChatGPT Atlas et Perplexity Comet embarquent un agent intégré, et seul cet agent peut piloter le navigateur. ego lite est un seul navigateur, pensé dès le départ pour être partagé entre vous et n'importe quel agent que vous amenez.


## Benchmarks

Nous avons comparé ego lite à agent-browser de Vercel sur quatre tâches complexes d'automatisation web. ego lite a terminé chaque tâche jusqu'à 2.5× plus vite, avec nettement moins de jetons. Plus la tâche est difficile, plus l'écart se creuse. Voir le comparatif.

<div align="center">

<img src="docs/assets/ego-vs-agent-benchmark.png" alt="ego lite vs agent-browser, speed and cost across four tasks" width="100%" />

</div>

## Documentation

Les tutoriels, la référence complète des outils et les guides d'intégration se trouvent sur [lite.ego.app/document/](https://lite.ego.app/document/).

## Communauté

- [Discord](https://discord.gg/5eGZVvHbTq), questions, aide à la configuration et partage de compétences
- [GitHub Discussions](https://github.com/citrolabs/ego-lite/discussions), idées et discussions de fond
- [X/Twitter](https://x.com/ego_agent), nouveautés et versions

## Historique des étoiles

<a href="https://github.com/citrolabs/ego-lite/stargazers">
<!-- star-history:start -->
<!-- Generated daily by .github/workflows/star-history.yml and published to the
     'star-history' branch, because main's ruleset will not take a bot commit. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/citrolabs/ego-lite/star-history/star-history-dark.svg">
  <img alt="Star history" src="https://raw.githubusercontent.com/citrolabs/ego-lite/star-history/star-history-light.svg">
</picture>
<!-- star-history:end -->
</a>

## Licence

Le contenu de ce dépôt est publié sous [licence MIT](LICENSE). Le navigateur ego lite est un téléchargement séparé et gratuit.
