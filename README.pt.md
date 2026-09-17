<div align="center">

<img src="docs/assets/banner.png" alt="ego lite" width="100%" />

**O navegador mais rápido para agentes de IA rodarem automação de navegador**

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
  <b>Português (BR)</b> ·
  <a href="README.es.md">Español (LatAm)</a>
</p>

</div>

O ego (lite) é um navegador em que você e seus agentes de IA trabalham em paralelo. Seus agentes rodam várias tarefas no navegador, cada um nos próprios Spaces, enquanto as suas guias continuam sendo suas — e as tarefas terminam mais rápido, com menos tokens.

Ferramentas como browser-use e agent-browser são frameworks de automação de navegador: elas precisam de um navegador separado para controlar, os logins nunca são transferidos direito, e você e o agente acabam disputando as mesmas guias. O ego lite é um único navegador, pensado desde o início para vocês dois compartilharem. Sem configuração extra, e o agente sempre acessa seus logins e guias reais pelo `ego-browser`.

## Demo

https://github.com/user-attachments/assets/ffe7954b-58ee-411e-b35d-ec30c58a08bc

## Início rápido

Por enquanto, o ego lite roda no macOS. Windows e Linux estão no [roadmap](https://lite.ego.app/roadmap).

### 1. Instalar

Escolha o que combina melhor com o seu fluxo.

**1.1 Baixe o app para macOS**

<a href="https://cdn.ego.app/setup/macos/arm64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/⬇%20Apple%20Silicon-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download ego lite for Apple Silicon" /></a>
<a href="https://cdn.ego.app/setup/macos/x64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/⬇%20Intel-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download ego lite for Intel" /></a>

Clique para baixar e depois abra o arquivo para instalar. De um jeito ou de outro, o ego lite adiciona a Skill `ego-browser` à pasta de Skills de todos os agentes na sua máquina.

**1.2 Adicione a Skill com npx**

Instale apenas a Skill `ego-browser`:

```bash
npx skills add citrolabs/ego-lite
```

Na primeira vez que o seu agente rodar uma tarefa no navegador, ele te guia pela instalação do app do ego lite.

**1.3 Deixe o seu agente configurar tudo**

Cole isto no seu agente:

```
Configure o ego lite para mim: https://github.com/citrolabs/ego-lite

Leia `skills/ego-browser/references/install.md` e siga os passos para instalar o ego lite.
```

Na primeira inicialização, o ego lite faz uma única pergunta: se você quer migrar os seus dados do Chrome. Diga sim e o seu agente herda os logins, cookies, extensões e favoritos que você já tem.

### 2. Rode sua primeira tarefa

No CLI do seu agente, digite `/ego-browser` seguido de um espaço e descreva o que você quer em linguagem natural:

```
ego-browser siga @ego_agent no x.com para mim
```

O agente aciona a Skill `ego-browser`, abre a página no próprio Space, lê um Snapshot, age na página e te dá um retorno — tudo isso enquanto as suas guias ficam intocadas.

Seus dados de navegação ficam no seu dispositivo. O ego lite registra apenas se você optou pela migração dos dados do Chrome durante a configuração inicial.

## Destaques do ego lite

| Recurso | O que faz |
|---|---|
| **Base de código, não de CLI, para rodar mais rápido e com menos tokens em tarefas complexas** | As capacidades que o ego lite expõe ao agente são empacotadas como funções JavaScript que o agente chama diretamente. Assim, ele faz o que faz de melhor: escrever código, compondo uma tarefa de várias etapas em uma única saída, em vez de ficar preso no ciclo de “chamar dois comandos, ver o resultado, chamar mais dois comandos”. Comparado à abordagem convencional de CLI, fluxos complexos terminam até 2.5× mais rápido, com taxa de sucesso mais alta e muito menos chamadas de ferramenta por tarefa. |
| **Um Space dedicado para cada agente** | O ego lite dá a cada agente o seu próprio Space, totalmente isolado. Você navega na frente, o agente trabalha em segundo plano, e um não atrapalha o outro. Você consegue ver a qualquer momento qual Space tem um agente rodando, e pode assumir o controle ou parar quando quiser. |
| **Seus agentes fazem multitarefa em Spaces, workspaces paralelos dentro do mesmo navegador** | Cada Space fica com o seu próprio agente de IA ou a sua própria tarefa, todos rodando ao mesmo tempo. Claude Code enriquecendo 10 leads em 10 Spaces paralelos. Codex extraindo dados de 5 sites de concorrentes em outros 5. Eles não se chocam nem tomam as suas guias. Seu mouse continua onde você deixou. |
| **O Snapshot de página mais poderoso do mercado** | Graças a customizações em nível de kernel, o ego lite gera os snapshots de página de maior qualidade — a visão em texto da qual os modelos dependem para “ver” e agir numa página web. Ele lida com casos difíceis, como iframes profundamente aninhados, exatamente onde outras abordagens invariavelmente falham. |
| **Qualquer agente consegue controlá-lo pelo `ego-browser`** | O `ego-browser` é a camada de conexão entre qualquer CLI de agente (Claude Code, Codex, Cursor ou um próprio) e o ego lite. Ele expõe o navegador como um conjunto de ferramentas JavaScript que rodam na própria página: snapshot, fill, click, wait, navigate, capture. O agente escreve um trecho de JavaScript que chama essas ferramentas, e o `ego-browser` executa tudo na página de uma vez só. |
| **Acúmulo de experiência que deixa o seu agente mais rápido a cada uso** *(em breve)* | A maior parte do tempo de um agente em tarefas no navegador vai embora em tentativa e erro. A Skill oficial do ego lite transforma cada ação bem-sucedida em ferramentas e fluxos reutilizáveis, então tarefas parecidas lá na frente rodam até 5x mais rápido. |

## ego lite vs produtos existentes

A maioria das ferramentas consegue automatizar um navegador. O que importa de verdade é qual navegador o agente recebe, se você consegue continuar trabalhando ao mesmo tempo e se a ferramenta foi feita para o agente que você já usa ou para um agente embutido.

| Recurso | ego lite | Browser-Use | agent-browser (Vercel) | ChatGPT Atlas | Perplexity Comet |
|---|:---:|:---:|:---:|:---:|:---:|
| Multitarefa em paralelo | ✓ | — | — | — | — |
| Habilidades reutilizáveis | ✓ | — | — | — | — |
| Herda os dados do Chrome | ✓ | — | — | ✓ | ✓ |
| O mesmo navegador, workspace separado | ✓ | — | — | — | — |
| Entrada semântica compactada | ✓ | — | ✓ | — | — |
| Controlável por agentes externos | ✓ | ✓ | ✓ | — | — |
| Dados armazenados localmente | ✓ | ✓ | ✓ | — | — |
| Sem fricção de login | ✓ | — | — | ✓ | ✓ |
| Navegador do dia a dia | ✓ | — | — | ✓ | ✓ |
| Gratuito | ✓ | ✓ | ✓ | — | — |

Outras duas categorias tentam resolver o mesmo problema. Frameworks de automação de navegador, como Browser-Use e o agent-browser da Vercel, são bibliotecas que o agente chama: eles não trazem navegador próprio, então precisam de um separado para controlar, e seus logins raramente são transferidos direito. Navegadores de IA, como ChatGPT Atlas e Perplexity Comet, vêm com um agente embutido, e só esse agente consegue controlar o navegador. O ego lite é um navegador só, pensado desde o início para ser compartilhado entre você e qualquer agente que você quiser trazer.


## Benchmarks

Fizemos um benchmark do ego lite contra o agent-browser da Vercel em quatro tarefas complexas de automação de navegador. O ego lite concluiu cada tarefa até 2.5× mais rápido, com bem menos tokens. Quanto mais difícil a tarefa, maior a diferença. Veja a comparação.

<div align="center">

<img src="docs/assets/ego-vs-agent-benchmark.png" alt="ego lite vs agent-browser, speed and cost across four tasks" width="100%" />

</div>

## Documentação

Os tutoriais, a referência completa das ferramentas e os guias de integração estão em [lite.ego.app/document/](https://lite.ego.app/document/).

## Comunidade

- [Discord](https://discord.gg/5eGZVvHbTq), dúvidas, ajuda com a configuração e compartilhamento de Skills
- [GitHub Discussions](https://github.com/citrolabs/ego-lite/discussions), ideias e discussões mais longas
- [X/Twitter](https://x.com/ego_agent), novidades e lançamentos

## Histórico de estrelas

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

## Licença

O conteúdo deste repositório é disponibilizado sob a [Licença MIT](LICENSE). O navegador ego lite é um download separado e gratuito.
