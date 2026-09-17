<div align="center">

<img src="docs/assets/banner.png" alt="ego lite" width="100%" />

**El navegador más rápido para que los agentes de IA realicen automatizaciones web**

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
  <b>Español</b> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.it.md">Italiano</a> ·
  <a href="README.ru.md">Русский</a>
</p>

</div>

ego (lite) es un navegador que te permite trabajar en paralelo con tus agentes de IA. Tus agentes ejecutan sus tareas en el navegador, cada uno en su propio Space —espacios de trabajo aislados dentro del mismo navegador—, mientras tú navegas libremente en tu propio Space, así que ningún agente te quita el control del navegador. Además, las tareas de automatización web se completan más rápido y con menos tokens.

Herramientas existentes como browser-use y agent-browser son un puente hacia el navegador y no traen un navegador propio: necesitan uno aparte que controlar; tus datos del navegador casi nunca se trasladan intactos; la conexión es inestable; tú y el agente terminan peleando por el control del navegador. ego lite es un único navegador diseñado desde el principio para que ustedes dos lo compartan. No hay que configurar nada más: el agente siempre puede llegar a tus sesiones ya iniciadas y a tus pestañas reales a través de `ego-browser`.

## Demo

https://github.com/user-attachments/assets/ffe7954b-58ee-411e-b35d-ec30c58a08bc

## Inicio rápido

Por ahora ego lite funciona en macOS. La versión para Windows entra pronto en beta cerrada y Linux ya está en el [roadmap](https://lite.ego.app/roadmap).

### 1. Instala

Elige la opción que mejor se ajuste a tu flujo de trabajo.

**1.1 Descarga la app de macOS**

<a href="https://cdn.ego.app/setup/macos/arm64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/⬇%20Apple%20Silicon-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download ego lite for Apple Silicon" /></a>
<a href="https://cdn.ego.app/setup/macos/x64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/⬇%20Intel-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download ego lite for Intel" /></a>

Haz clic para descargar y luego ábrelo para instalar. En cualquiera de los dos casos, ego lite agrega la Skill `ego-browser` al directorio de Skills de cada agente en tu computadora.

**1.2 Agrega la Skill con npx**

Instala solo la Skill `ego-browser`:

```bash
npx skills add citrolabs/ego-lite
```

La primera vez que tu agente ejecute una tarea en el navegador, te guiará paso a paso para instalar la app de ego lite.

**1.3 Deja que tu agente lo configure**

Pega esto en tu agente:

```
Configura ego lite para mí: https://github.com/citrolabs/ego-lite

Lee `skills/ego-browser/references/install.md` y sigue los pasos para instalar ego lite.
```

En el primer arranque, ego lite hace una sola pregunta: si quieres migrar tus datos de Chrome. Responde que sí y tu agente heredará tus sesiones, cookies, extensiones y marcadores actuales.

### 2. Practica con tu primera tarea

En la CLI de tu agente, escribe `/ego-browser`, deja un espacio y describe en lenguaje natural lo que quieres:

```
ego-browser sigue a @ego_agent en x.com por mí
```

El agente carga la Skill `ego-browser`, abre la página en su propio Space, lee un Snapshot —la versión en texto de la página que el modelo usa para saber qué hay en pantalla—, interactúa con la página y te reporta el resultado; durante todo el proceso, tus pestañas permanecen totalmente intactas.

Tus datos de navegación, las cookies y todos los demás datos del navegador permanecen en tu dispositivo. La recopilación de datos de ego lite es mínima: solo señales básicas de uso del producto, por ejemplo, si pusiste ego lite como navegador predeterminado.

## Lo más destacado de ego lite

| Función | Qué hace |
|---|---|
| **Basado en código, no en CLI: más velocidad y menos tokens en tareas complejas** | Las capacidades que ego lite expone al agente están encapsuladas como funciones de JavaScript que el agente llama directamente. El agente hace lo que mejor sabe hacer: escribir código, y así arma una tarea de varios pasos en un solo bloque, en vez de quedarse atrapado en el ciclo de 'ejecuto dos comandos, miro el resultado, ejecuto dos más'. Comparado con el enfoque convencional de CLI, los flujos complejos se ejecutan mucho más rápido, con tasas de éxito más altas y muchas menos llamadas a herramientas por tarea, y el costo final por tarea se reduce mucho. |
| **Un Space dedicado para cada agente** | ego lite le da a cada agente su propio Space totalmente aislado. Tú navegas en primer plano, tu agente trabaja en segundo plano y no se estorban entre sí. Puedes ver en todo momento en qué Space está corriendo un agente, y puedes tomar el control de ese Space o detener al agente cuando quieras. |
| **Multitarea de tus agentes en Spaces: espacios de trabajo en paralelo dentro del mismo navegador** | Cada Space corre con su propio agente de IA o su propia tarea, todos al mismo tiempo. Claude Code completa la información de 10 leads en 10 Spaces en paralelo. Codex extrae datos de 5 sitios de la competencia en otros 5 Spaces. No chocan entre sí ni te roban las pestañas. Tu mouse se queda donde lo dejaste. |
| **El Snapshot de página más potente del mercado** | Gracias a una personalización dentro del motor del navegador, ego lite genera los Snapshots de página de mayor calidad, la vista en la que se apoyan los modelos que solo leen texto para «ver» y actuar sobre una página web. Maneja de forma confiable casos difíciles como iframes muy anidados, justo donde otros enfoques fallan sistemáticamente. |
| **Cualquier agente puede controlarlo a través de `ego-browser`** | `ego-browser` es la capa de conexión entre cualquier CLI de agente (Claude Code, Codex, Cursor o uno propio) y ego lite. Expone el navegador como un conjunto de herramientas de JavaScript dentro de la página: snapshot, fill, click, wait, navigate, capture. El agente escribe un fragmento de JavaScript que llama a esas herramientas, y `ego-browser` lo ejecuta en la página de una sola pasada. |
| **Tu agente acumula experiencia y se vuelve más rápido cuanto más lo usas** *(próximamente)* | La mayor parte del tiempo que un agente dedica a tareas del navegador se va en prueba y error. La Skill oficial de ego lite convierte cada acción exitosa en herramientas y flujos de trabajo reutilizables, para que las tareas parecidas que vengan después se ejecuten hasta 5x más rápido. |

## ego lite vs productos existentes

La mayoría de las herramientas pueden automatizar un navegador. Las preguntas de verdad son con qué navegador va a trabajar el agente, si tú puedes seguir usando el tuyo al mismo tiempo, y si la herramienta está hecha para el agente que ya usas o solo para el agente que ella misma trae incorporado.

| Capacidad | ego lite | Browser-Use | agent-browser (Vercel) | ChatGPT Atlas | Perplexity Comet |
|---|:---:|:---:|:---:|:---:|:---:|
| Multitarea en paralelo | ✓ | — | — | — | — |
| Skills reutilizables | ✓ | — | — | — | — |
| Hereda los datos de Chrome | ✓ | — | — | ✓ | ✓ |
| El mismo navegador, un espacio de trabajo aparte | ✓ | — | — | — | — |
| Entrada semántica comprimida | ✓ | — | ✓ | — | — |
| Controlable por agentes externos | ✓ | ✓ | ✓ | — | — |
| Datos almacenados localmente | ✓ | ✓ | ✓ | — | — |
| Sin fricción de inicio de sesión | ✓ | — | — | ✓ | ✓ |
| Navegador de uso diario | ✓ | — | — | ✓ | ✓ |
| Gratis | ✓ | ✓ | ✓ | — | — |

Otras dos categorías intentan resolver el mismo problema. Los frameworks de automatización de navegador como Browser-Use y el agent-browser de Vercel son bibliotecas que el agente llama; no traen un navegador propio, así que necesitan uno aparte que controlar y tus sesiones rara vez se heredan bien. Los navegadores de IA como ChatGPT Atlas y Perplexity Comet traen un agente integrado, y solo ese agente puede controlar el navegador. ego lite es un único navegador, diseñado desde el principio para que lo compartan tú y cualquier agente que uses.


## Benchmarks

Comparamos ego lite con el agent-browser de Vercel en cuatro tareas complejas de automatización del navegador. ego lite terminó cada tarea hasta 2.5× más rápido y con muchos menos tokens. Cuanto más difícil la tarea, mayor la diferencia. Los resultados están en la gráfica de abajo.

<div align="center">

<img src="docs/assets/ego-vs-agent-benchmark.png" alt="ego lite vs agent-browser, speed and cost across four tasks" width="100%" />

</div>

## Documentación

Los tutoriales, la referencia completa de herramientas y las guías de integración están en [lite.ego.app/document/](https://lite.ego.app/document/).

## Comunidad

- [Discord](https://discord.gg/5eGZVvHbTq): preguntas, ayuda con la instalación e intercambio de Skills
- [GitHub Discussions](https://github.com/citrolabs/ego-lite/discussions): ideas y hilos de discusión más a fondo
- [X/Twitter](https://x.com/ego_agent): novedades y lanzamientos

## Historial de estrellas

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

## Licencia

El contenido de este repositorio se publica bajo la [Licencia MIT](LICENSE). El navegador ego lite es una descarga aparte y gratuita.
