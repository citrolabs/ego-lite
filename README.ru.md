<div align="center">

<img src="docs/assets/banner.png" alt="ego lite" width="100%" />

**Самый быстрый браузер для ИИ-агентов, которые автоматизируют веб**

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
  <a href="README.it.md">Italiano</a> ·
  <b>Русский</b>
</p>

</div>

ego (lite) — браузер, в котором вы и ваши ИИ-агенты работаете параллельно. Каждый агент выполняет свои браузерные задачи в собственном Space (изолированном рабочем пространстве внутри одного браузера), пока вы работаете в своём, — и ни один агент не отнимет у вас браузер. А сама автоматизация проходит быстрее и тратит меньше токенов.

Существующие инструменты вроде browser-use и agent-browser — это не браузеры, а прослойка, которая подключается к браузеру со стороны. Своего у них нет, поэтому запускать приходится отдельный: данные вашего профиля переносятся редко и не полностью, соединение нестабильно, а управление вы в итоге делите с агентом. ego lite — это один браузер, с самого начала рассчитанный на то, что вы работаете в нём вдвоём с агентом. Никакой дополнительной настройки, и агент всегда может получить доступ к вашим реальным логинам и вкладкам через `ego-browser`.

## Демо

https://github.com/user-attachments/assets/ffe7954b-58ee-411e-b35d-ec30c58a08bc

## Быстрый старт

Сейчас ego lite работает на macOS, скоро выйдет закрытая бета для Windows, а Linux — в [дорожной карте](https://lite.ego.app/roadmap).

### 1. Установка

Выберите способ, который вам удобнее.

**1.1 Скачайте приложение для macOS**

<a href="https://cdn.ego.app/setup/macos/arm64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/⬇%20Apple%20Silicon-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download ego lite for Apple Silicon" /></a>
<a href="https://cdn.ego.app/setup/macos/x64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/⬇%20Intel-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download ego lite for Intel" /></a>

Нажмите, чтобы скачать, затем откройте файл и установите приложение. В обоих случаях ego lite добавит Skill `ego-browser` — набор инструкций, который агент подхватывает сам — в каталог Skill каждого агента на вашем компьютере.

**1.2 Установите Skill через npx**

Установите только Skill `ego-browser`:

```bash
npx skills add citrolabs/ego-lite
```

Когда агент впервые возьмётся за браузерную задачу, он подскажет, как установить приложение ego lite, и проведёт по шагам.

**1.3 Пусть всё настроит агент**

Отправьте это своему агенту:

```
Настрой ego lite за меня: https://github.com/citrolabs/ego-lite

Прочитай `skills/ego-browser/references/install.md` и выполни шаги, чтобы установить ego lite.
```

При первом запуске ego lite задаёт один вопрос — переносить ли данные из Chrome. Ответьте «да», и агент унаследует ваши логины, куки, расширения и закладки.

### 2. Попробуйте первую задачу

В CLI вашего агента наберите `/ego-browser`, а через пробел своими словами опишите задачу:

```
ego-browser, подпишись за меня на @ego_agent в x.com
```

Агент подхватывает Skill `ego-browser`, открывает страницу в своём Space, считывает Snapshot — текстовый слепок страницы, по которому модель понимает, что на ней есть, — выполняет действия на странице и отчитывается — а ваши собственные вкладки остаются нетронутыми.

Данные о вашей активности в браузере, файлы cookie и всё остальное, что хранит браузер, остаются на вашем устройстве. ego lite сознательно ограничивает сбор данных: только базовая продуктовая телеметрия — например, выбран ли ego lite браузером по умолчанию.

## Что умеет ego lite

| Возможность | Что она даёт |
|---|---|
| **Код вместо CLI: сложные задачи быстрее и дешевле по токенам** | Возможности, которые ego lite открывает агенту, обёрнуты в JavaScript-функции, и агент вызывает их напрямую. Агент занимается тем, что умеет лучше всего, — пишет код, собирая многошаговую задачу в один запуск, вместо того чтобы застревать в цикле «вызови две команды, посмотри результат, вызови ещё две». По сравнению с обычным подходом через CLI сложные сценарии завершаются заметно быстрее, доля успешно решённых задач выше, вызовов инструментов на задачу заметно меньше, и каждая задача обходится намного дешевле. |
| **Отдельный Space для каждого агента** | ego lite выделяет каждому агенту собственный полностью изолированный Space. Вы работаете на переднем плане, агент — в фоне, и вы друг другу не мешаете. В любой момент видно, в каком Space работает агент: хотите — перехватите управление, хотите — остановите агента. |
| **Многозадачность агентов в Space: параллельные рабочие пространства внутри одного браузера** | В каждом Space — свой ИИ-агент или своя задача, и все работают одновременно. Claude Code обогащает 10 лидов в 10 параллельных Spaces. Codex снимает данные с 5 сайтов конкурентов — ещё в 5 Spaces. Они не конфликтуют и не уводят у вас вкладки. Мышь остаётся там, где вы её оставили. |
| **Самый качественный Snapshot страницы на рынке** | Благодаря модификации на уровне движка браузера ego lite формирует Snapshot страницы самого высокого качества — то представление, на которое опираются языковые модели, чтобы «видеть» веб-страницу и действовать на ней. Он надёжно справляется со сложными случаями вроде глубоко вложенных iframe — именно там, где другие подходы стабильно ломаются. |
| **Любой агент управляет браузером через `ego-browser`** | `ego-browser` — связующий слой между любым CLI-агентом (Claude Code, Codex, Cursor или вашим собственным) и ego lite. Он превращает браузер в набор JavaScript-функций, которые выполняются прямо на странице: snapshot, fill, click, wait, navigate, capture. Агент пишет сниппет на JavaScript, который вызывает эти инструменты, а `ego-browser` выполняет его на странице за один проход. |
| **Накопление опыта: чем больше вы работаете, тем быстрее агент** *(скоро)* | Большая часть времени агента на браузерных задачах уходит на пробы и ошибки. Официальный Skill ego lite превращает каждое успешное действие в готовые инструменты и сценарии, которые можно применять снова, поэтому похожие задачи в будущем выполняются до 5 раз быстрее. |

## ego lite против существующих продуктов

Большинство инструментов умеют автоматизировать браузер. Вопрос в другом: какой браузер достаётся агенту, можете ли вы в это время работать сами, и рассчитан инструмент на вашего агента или на встроенного.

| Возможность | ego lite | Browser-Use | agent-browser (Vercel) | ChatGPT Atlas | Perplexity Comet |
|---|:---:|:---:|:---:|:---:|:---:|
| Параллельная многозадачность | ✓ | — | — | — | — |
| Переиспользуемые Skill | ✓ | — | — | — | — |
| Наследует данные Chrome | ✓ | — | — | ✓ | ✓ |
| Один браузер, разные рабочие пространства | ✓ | — | — | — | — |
| Сжатое семантическое представление страницы | ✓ | — | ✓ | — | — |
| Управляется внешними агентами | ✓ | ✓ | ✓ | — | — |
| Данные хранятся локально | ✓ | ✓ | ✓ | — | — |
| Не нужно логиниться заново | ✓ | — | — | ✓ | ✓ |
| Годится как повседневный браузер | ✓ | — | — | ✓ | ✓ |
| Бесплатно | ✓ | ✓ | ✓ | — | — |

Есть ещё две категории инструментов, которые пытаются решить ту же задачу. Фреймворки автоматизации браузера вроде Browser-Use и agent-browser от Vercel — это библиотеки, которые вызывает агент; своего браузера у них нет, поэтому им нужен отдельный, а ваши логины редко переносятся без потерь. ИИ-браузеры вроде ChatGPT Atlas и Perplexity Comet поставляются со встроенным агентом, и управлять браузером может только он. ego lite — это один браузер, с самого начала созданный для работы вместе с любым агентом, который у вас уже есть.


## Бенчмарки

Мы сравнили ego lite с agent-browser от Vercel на четырёх сложных задачах автоматизации браузера. Каждую задачу ego lite завершал до 2,5 раза быстрее и заметно экономнее по токенам. Чем сложнее задача, тем больше разрыв. Сравнение — на графике ниже.

<div align="center">

<img src="docs/assets/ego-vs-agent-benchmark.png" alt="ego lite vs agent-browser, speed and cost across four tasks" width="100%" />

</div>

## Документация

Туториалы, полный справочник по инструментам и гайды по интеграции — на [lite.ego.app/document/](https://lite.ego.app/document/).

## Сообщество

- [Discord](https://discord.gg/5eGZVvHbTq) — вопросы, помощь с настройкой и обмен готовыми Skill
- [GitHub Discussions](https://github.com/citrolabs/ego-lite/discussions) — идеи и развёрнутые обсуждения
- [X/Twitter](https://x.com/ego_agent) — обновления и релизы

## История звёзд

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

## Лицензия

Содержимое этого репозитория распространяется по [лицензии MIT](LICENSE). Сам браузер ego lite скачивается отдельно и бесплатно.
