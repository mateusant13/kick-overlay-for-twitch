# Player 1:1 da Kick e do YouTube: pesquisa e decisão

Data: 2026-10-23. Este documento responde a uma pergunta de produto: vale a pena
clonar o player da Kick ou do YouTube dentro da Twitch?

## Pergunta

O overlay atual usa os motores de vídeo dos provedores, mas a barra de controles
é a do projeto. Dá para deixar o player visualmente 1:1, com os controles e o
comportamento exatos da Kick e do YouTube?

## O que existe hoje

### 1. Player oficial da Kick

A Kick publica um player para incorporar em sites:

```
https://player.kick.com/NOME_DO_CANAL
```

Parâmetros documentados: `autoplay`, `muted` e `allowfullscreen`.
Fonte: https://help.kick.com/en/articles/8010826-how-to-embed-your-kick-livestream

Esse é o único jeito de ter a interface oficial da Kick. O problema é o
controle: o bundle do `player.kick.com` foi inspecionado e não expõe um listener
de `message` no `window` para o site que incorpora. As mensagens que existem são
do player para o próprio service worker. Ou seja, a extensão não consegue
mandar `play`, `pause`, `mute` ou `seek` para o player oficial.

### 2. Player oficial do YouTube

O YouTube tem a IFrame Player API, que permite controlar play, pause, mute,
volume, seek e qualidade:
https://developers.google.com/youtube/player_parameters

O projeto já tentou o embed `live_stream` e mediu o problema: em sessões sem
cookie ou marcadas como bot, o YouTube coloca um erro de configuração na página
e o player nunca faz a requisição de reprodução. O layer HLS foi criado para
contornar isso. O embed oficial também pode exibir anúncios do YouTube, o que
vai contra o objetivo do projeto.

### 3. Projetos de multi-stream

Os projetos de multi-stream geralmente usam os players oficiais em iframes.
Exemplo: https://github.com/alex-kimbr/multi-stream (Twitch, YouTube e Kick).
Eles aceitam a interface oficial, mas não têm o controle fino que o overlay
precisa para pausar e mutar a fonte alternativa junto com a Twitch.

### 4. Skins e clones de interface

Existem skins de Video.js que imitam o YouTube, por exemplo
https://github.com/paidless/videojs-yt-style. O próprio repositório avisa que é
um projeto inicial, sem versão estável, e não deve ser usado em produção. Não
foi encontrado um clone de player da Kick mantido e confiável. Os resultados de
busca são bots, ferramentas de chat ou páginas de demonstração, não um player
pronto para produção.

### 5. Termos de uso

A própria documentação de embed da Kick pede para não alterar a interface do
player. Um clone que remove ou troca a interface oficial pode violar os termos
da plataforma. Isso torna a opção 3 arriscada além do custo de manutenção.

## Comparação

| Abordagem | Visual 1:1 | Controle de mute/pause | Adblock / cold open | Custo e risco |
|-----------|------------|------------------------|---------------------|----------------|
| Overlay atual (IVS + HLS) | próximo, não exato | completo | mantém o comportamento atual | baixo, já existe |
| Player oficial em iframe | exato | Kick não expõe; YouTube expõe, mas com bloqueio e anúncios | perde o controle e pode perder o adblock | médio |
| Clone completo | poderia chegar perto | completo | manteria, se bem feito | alto, frágil e com risco de termos |

## Decisão

**Fica a opção 1: manter o overlay atual e não clonar o player.**

Motivos:

1. Não existe um clone pronto e mantido. O trabalho seria construir e manter
   uma interface que muda quando a Kick ou o YouTube mudam.
2. O player oficial da Kick não tem API de controle para o site que incorpora.
   Usar o iframe oficial quebraria mute, pause, volume, fullscreen sincronizado
   e a troca de camada.
3. O player oficial do YouTube resolve o controle, mas não resolve o bloqueio
   sem cookie e pode trazer anúncios. O HLS atual é mais confiável para o caso
   de uso do projeto.
4. O overlay já usa os mesmos motores dos provedores: Amazon IVS para a Kick e
   hls.js para o YouTube. Isso é o mais próximo de um clone que faz sentido
   dentro da Twitch.

Para a experiência 1:1 de verdade, o popup ganhou o atalho **Abrir no site
oficial**. Ele abre a Kick, o YouTube ou a Twitch no site do provedor, com a
interface completa, sem tentar imitar essa interface dentro da Twitch.

## Quando rever esta decisão

- Se a Kick publicar uma API de controle para o player oficial.
- Se o embed oficial do YouTube funcionar de forma estável sem cookie e sem
  anúncios no caso de uso do projeto.
- Se o dono aceitar perder controle de mute/pause em troca da interface exata.
