<div align="center">

<img src="docs/assets/banner.png" alt="ego lite" width="100%" />

**Il browser più veloce per automatizzare il web con gli agenti AI**

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
  <a href="README.fr.md">Français</a> ·
  <b>Italiano</b> ·
  <a href="README.ru.md">Русский</a>
</p>

</div>

ego (lite) è un browser in cui tu e i tuoi agenti AI lavorate in parallelo. I tuoi agenti eseguono i loro task di browser nei propri Space, mentre tu continui a navigare nel tuo, così nessun agente ti porta mai via il browser. E l'automazione stessa termina più in fretta, con meno token.

Strumenti come browser-use e agent-browser sono un ponte verso il browser, non un browser: non ne hanno uno proprio, quindi devono guidarne uno separato, i tuoi dati di navigazione raramente passano intatti, la connessione è instabile e tu e l'agente finite per contendervi il controllo del browser. ego lite è un unico browser pensato fin dall'inizio per essere condiviso da entrambi. Nessuna configurazione extra, e l'agente raggiunge sempre i tuoi login e le tue schede reali tramite `ego-browser`.

## Demo

https://github.com/user-attachments/assets/ffe7954b-58ee-411e-b35d-ec30c58a08bc

## Avvio rapido

Oggi ego lite funziona su macOS, una beta chiusa per Windows è in arrivo e Linux è nella [roadmap](https://lite.ego.app/roadmap).

### 1. Installa

Scegli la soluzione più adatta al tuo flusso di lavoro.

**1.1 Scarica l'app per macOS**

<a href="https://cdn.ego.app/setup/macos/arm64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/⬇%20Apple%20Silicon-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download ego lite for Apple Silicon" /></a>
<a href="https://cdn.ego.app/setup/macos/x64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/⬇%20Intel-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download ego lite for Intel" /></a>

Fai clic per scaricare, poi apri il file per installare. In entrambi i casi, ego lite aggiunge la skill `ego-browser` alla cartella delle skill di ogni agente sul tuo computer.

**1.2 Aggiungi la skill con npx**

Installa solo la skill `ego-browser`:

```bash
npx skills add citrolabs/ego-lite
```

La prima volta che il tuo agente esegue un task nel browser, ti guida nell'installazione dell'app ego lite.

**1.3 Fai configurare tutto al tuo agente**

Incolla questo nel tuo agente:

```
Configura ego lite per me: https://github.com/citrolabs/ego-lite

Leggi `skills/ego-browser/references/install.md` e segui i passaggi per installare ego lite.
```

Al primo avvio ego lite ti fa una sola domanda: se migrare i tuoi dati di Chrome. Rispondi di sì e il tuo agente eredita i login, i cookie, le estensioni e i preferiti che hai già.

### 2. Prova il tuo primo task

Nella CLI del tuo agente digita `/ego-browser` seguito da uno spazio, poi descrivi a parole tue quello che vuoi:

```
ego-browser segui @ego_agent su x.com per me
```

L'agente usa la skill `ego-browser`, apre la pagina nel proprio Space, legge uno Snapshot, agisce sulla pagina e ti riporta il risultato, mentre le tue schede restano intatte.

I tuoi dati di navigazione, i cookie e tutto il resto che il browser contiene restano sul tuo dispositivo. ego lite limita volutamente la raccolta dati: solo semplici segnali di prodotto, come se hai impostato ego lite come browser predefinito.

## Punti di forza di ego lite

| Funzionalità | Cosa fa |
|---|---|
| **Basato sul codice, non sulla CLI: task complessi più veloci e con meno token** | Le funzionalità che ego lite espone all'agente sono incapsulate in funzioni JavaScript che l'agente richiama direttamente. Così l'agente fa ciò che gli riesce meglio: scrivere codice, condensando un task in più passaggi in un unico output invece di restare bloccato nel ciclo "chiamo due comandi, guardo il risultato, ne chiamo altri due". Rispetto all'approccio CLI tradizionale, i flussi di lavoro complessi terminano molto più in fretta, con percentuali di successo più alte, molte meno chiamate agli strumenti per task e un costo per task molto più basso. |
| **Uno Space dedicato per ogni agente** | ego lite assegna a ogni agente uno Space completamente isolato. Tu navighi in primo piano, il tuo agente lavora in background e non si intralciano a vicenda. In qualsiasi momento vedi in quale Space sta lavorando un agente e, quando vuoi, puoi prenderne il controllo o fermarlo. |
| **I tuoi agenti lavorano in parallelo negli Space, workspace paralleli nello stesso browser** | Ogni Space ha il proprio agente AI o il proprio task, tutti in esecuzione contemporaneamente. Claude Code che arricchisce 10 lead in 10 Space paralleli. Codex che raccoglie dati da 5 siti concorrenti in altri 5. Non si scontrano né ti rubano le schede. Il mouse resta dove l'hai lasciato. |
| **Lo Snapshot di pagina più potente sul mercato** | Grazie a una personalizzazione a livello di kernel, ego lite produce gli snapshot di pagina di qualità più alta, la rappresentazione su cui i modelli testuali si basano per "vedere" e agire su una pagina web. Gestisce in modo affidabile i casi più difficili, come gli iframe annidati in profondità, proprio dove gli altri approcci falliscono sistematicamente. |
| **Qualsiasi agente può guidarlo tramite `ego-browser`** | `ego-browser` è il livello di collegamento tra la CLI di qualsiasi agente (Claude Code, Codex, Cursor o uno tuo) ed ego lite. Espone il browser come un set di strumenti JavaScript in-page: snapshot, fill, click, wait, navigate, capture. L'agente scrive uno snippet JavaScript che richiama questi strumenti, e `ego-browser` lo esegue sulla pagina in un solo passaggio. |
| **Esperienza che si accumula e rende il tuo agente più veloce più lo usi** *(in arrivo)* | La maggior parte del tempo che un agente dedica ai task nel browser se ne va in tentativi ed errori. La Skill ufficiale di ego lite condensa ogni azione riuscita in strumenti e flussi di lavoro riutilizzabili, così i task simili eseguiti in seguito sono fino a 5x più veloci. |

## ego lite rispetto ai prodotti esistenti

La maggior parte degli strumenti è in grado di automatizzare un browser. Le domande che contano davvero sono: quale browser riceve l'agente, se puoi continuare a lavorare nello stesso momento e se lo strumento è pensato per l'agente che usi già o per uno integrato.

| Funzionalità | ego lite | Browser-Use | agent-browser (Vercel) | ChatGPT Atlas | Perplexity Comet |
|---|:---:|:---:|:---:|:---:|:---:|
| Multitasking in parallelo | ✓ | — | — | — | — |
| Competenze riutilizzabili | ✓ | — | — | — | — |
| Eredita i dati di Chrome | ✓ | — | — | ✓ | ✓ |
| Stesso browser, workspace separato | ✓ | — | — | — | — |
| Input semantico compresso | ✓ | — | ✓ | — | — |
| Controllabile da agenti esterni | ✓ | ✓ | ✓ | — | — |
| Dati salvati in locale | ✓ | ✓ | ✓ | — | — |
| Nessun attrito di login | ✓ | — | — | ✓ | ✓ |
| Browser da usare ogni giorno | ✓ | — | — | ✓ | ✓ |
| Gratuito | ✓ | ✓ | ✓ | — | — |

Altre due categorie di prodotti cercano di risolvere lo stesso problema. I framework di automazione browser come Browser-Use e l'agent-browser di Vercel sono librerie che l'agente richiama: non includono un browser proprio, quindi ne serve uno separato da guidare e i tuoi login raramente vengono trasferiti in modo pulito. I browser AI come ChatGPT Atlas e Perplexity Comet includono un agente integrato, e solo quell'agente può guidare il browser. ego lite è un unico browser, pensato fin dall'inizio per essere condiviso da te e da qualsiasi agente tu scelga.


## Benchmark

Abbiamo messo a confronto ego lite con l'agent-browser di Vercel su quattro task complessi di automazione browser. ego lite ha completato ogni task fino a 2.5× più velocemente, con molti meno token. Più il task è difficile, più il divario si allarga. Guarda il confronto.

<div align="center">

<img src="docs/assets/ego-vs-agent-benchmark.png" alt="ego lite vs agent-browser, speed and cost across four tasks" width="100%" />

</div>

## Documentazione

Tutorial, il riferimento completo degli strumenti e le guide di integrazione sono su [lite.ego.app/document/](https://lite.ego.app/document/).

## Community

- [Discord](https://discord.gg/5eGZVvHbTq), per domande, aiuto sulla configurazione e condivisione di skill
- [GitHub Discussions](https://github.com/citrolabs/ego-lite/discussions), per idee e discussioni più lunghe
- [X/Twitter](https://x.com/ego_agent), per aggiornamenti e release

## Star History

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

## Licenza

I contenuti di questo repository sono rilasciati con la [licenza MIT](LICENSE). Il browser ego lite è un download separato e gratuito.
