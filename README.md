# Kick & YouTube Overlay for Twitch (with new AdBlock Approach)

> **Twitch no centro. Kick e YouTube no vídeo. Anúncios fora do caminho.**

Assista ao streamer que você já acompanha na Twitch sem perder o chat, os controles e o resto da página. Quando ele também está ao vivo na Kick ou no YouTube, a extensão coloca esse vídeo por cima do player da Twitch. Quando aparece um anúncio, ela tenta manter a live limpa sem trocar de site e sem recarregar a página.

**Grátis, local e sem login.** A extensão usa a sessão que você já tem aberta no navegador.

---

## Por que vale experimentar

- **Você não sai da Twitch.** O chat, as raids, os emotes e os controles da página continuam onde estão.
- **Kick e YouTube no mesmo player.** O vídeo alternativo entra por cima do player nativo, sem abrir outra aba.
- **Adblock sem trocar de player.** Fora do anúncio, quem manda é o player da Twitch. A extensão só entra em ação quando precisa.
- **Áudio volta sozinho.** Mudo e volume são guardados antes do anúncio e restaurados depois.
- **Sem F5 automático.** A página não recarrega sozinha. O standby já começa escondido e mudo.
- **Configuração por canal.** Cada canal da Twitch pode apontar para um canal diferente na Kick ou no YouTube.

### A experiência em 30 segundos

| Situação | Sem a extensão | Com a extensão |
|----------|----------------|----------------|
| O streamer também está na Kick | Você abre outra aba e perde o chat da Twitch | O vídeo da Kick aparece por cima do player da Twitch |
| O streamer também está no YouTube | Você abre outra aba e perde o chat da Twitch | O vídeo do YouTube aparece por cima do player da Twitch |
| Anúncio no meio da live | O player nativo mostra o anúncio | Um frame limpo em 360p cobre o intervalo e o player nativo volta depois |
| Áudio depois do anúncio | Pode ficar mudo ou com volume zerado | Mudo e volume são restaurados automaticamente |

> O objetivo não é prometer uma Twitch sem nenhum anúncio. É reduzir o atrito e devolver você à live o mais rápido possível, sem trocar de site.

---

## O que você ganha

### Overlay de Kick

O canal da Kick toca por cima do player da Twitch, com a barra de controles do projeto. Se você não informar um canal, a extensão tenta o mesmo nome que você está vendo na Twitch.

### Overlay de YouTube

Funciona com URL de live ou vídeo, `@handle` ou ID `UC...`. Se o YouTube não estiver disponível, a extensão tenta a Kick antes de voltar para a Twitch. A preferência salva continua sendo YouTube; o desvio vale só para aquela sessão.

### Adblock para live e VOD

- **Live:** reescreve o token do player, remove os blocos de anúncio dos playlists e, quando o anúncio já veio colado no stream, cobre o player com um frame limpo que já estava pronto.
- **VOD:** bloqueia as requisições de anúncio CSAI dos vídeos sob demanda.
- **Fora do anúncio:** o adblock não troca o player. O player nativo continua no comando.

### Cold open mais rápido

Quando a live abre, a extensão começa a preparar um player limpo escondido antes de esperar a verificação completa. Se o anúncio chegar junto com o carregamento, ele pode aparecer mudo por instantes, mas o standby costuma ficar saudável e cobrir o anúncio em menos de 1 segundo. Se o standby não ficar saudável, a extensão mantém ou devolve o player nativo em vez de deixar uma tela preta.

### Sem rewind e sem áudio duplicado

O standby fica escondido e mudo. O player nativo é silenciado enquanto o frame limpo está na frente. A extensão também evita voltar o stream no caminho quente: o standby já está tocando.

---

## Como instalar

A extensão não está publicada na Chrome Web Store. A instalação é manual, direto da pasta do projeto.

### 1. Baixe o ZIP

No GitHub, clique no botão verde **Code** (ou **Código**) e escolha **Download ZIP**.

### 2. Extraia o ZIP

Abra o `.zip` e arraste a pasta de dentro para a **Área de Trabalho** ou para outro lugar que você não vá apagar.

A pasta da extensão é a **`kick-overlay`**, a que tem o arquivo `manifest.json` dentro. Não é a pasta raiz do projeto.

### 3. Abra a página de extensões

| Navegador | Endereço |
|-----------|----------|
| Google Chrome | `chrome://extensions` |
| Brave | `brave://extensions` |
| Microsoft Edge | `edge://extensions` |
| Opera | `opera://extensions` |
| Vivaldi | `vivaldi://extensions` |
| Arc (Chromium) | `chrome://extensions` |

### 4. Ative o modo desenvolvedor

No canto superior direito, ligue **Modo do desenvolvedor** (Developer mode).

### 5. Carregue a extensão

- **Opção A:** arraste a pasta **`kick-overlay`** para dentro da página de extensões, ou
- **Opção B:** clique em **Carregar sem compactação** (Load unpacked) e escolha a pasta **`kick-overlay`**.

### 6. Fixe o ícone e abra a Twitch

Clique no ícone da extensão na barra do navegador e deixe-o fixado. Depois abra a Twitch e **recarregue a aba uma vez** (F5) para o content script entrar.

> **Importante:** a pasta `kick-overlay` precisa continuar no computador. O navegador lê os arquivos dela direto; não apague enquanto estiver usando.

---

## Como usar no dia a dia

1. Abra o canal na Twitch.
2. Clique no ícone da extensão.
3. Escolha o player:

   | Player | O que faz |
   |--------|-----------|
   | **Kick** | Usa o canal da Kick que você informar. Se deixar em branco, tenta o mesmo nome da Twitch. |
   | **YouTube** | Cole a URL da live ou vídeo, o `@handle` ou o ID `UC...`. Se o streamer usa outro nome no YouTube, é aqui que você ajusta. |
   | **Twitch** | Mantém o player nativo. O adblock continua ativo. |

4. Preencha o canal e clique em **Save**. O ajuste vale só para aquele canal da Twitch.
5. Use o toggle **Overlay** para ligar ou desligar o player alternativo.
6. Use o toggle **Twitch adblock** para ligar ou desligar o bloqueio de anúncios.

### Kick com o mesmo nome: zero configuração

Se o streamer usa o mesmo nome na Kick, escolha **Kick** e deixe o campo em branco. A extensão procura esse nome. Se a Kick estiver ao vivo, o player muda para a Kick. Se não estiver, ela não inventa outro canal: volta para o player nativo da Twitch.

### YouTube: informe a referência certa

No YouTube o nome não basta. Preencha a URL, o `@handle` ou o ID `UC...` no popup. Se você escolher **YouTube** e a extensão não encontrar o canal ou vídeo, ou ele não estiver ao vivo, ela tenta a Kick: usa o canal da Kick configurado; se não houver, tenta o mesmo nome da Twitch. Se a Kick também não estiver ao vivo, fica na Twitch.

### A barra diz qual player está na frente

| Cor da barra | Player |
|--------------|--------|
| Verde | Kick, incluindo o fallback automático |
| Vermelha | YouTube |
| Sem barra do projeto | Twitch nativo |

Se você escolheu YouTube e a barra ficou verde, o YouTube não foi encontrado ou estava fora do ar, e a extensão caiu para a Kick. Confira a URL, o `@handle` ou o ID e se a live está no ar.

### Quero ver no site oficial

O popup tem o atalho **Abrir no site oficial**. Ele abre a Kick, o YouTube ou a Twitch no site do provedor, com a interface completa. O overlay chega perto do visual desses players, mas não é um clone 1:1. A pesquisa e a decisão estão em `kick-overlay/PLAYER-1TO1-RESEARCH.md`.

---

## A nova abordagem do adblock

O Twitch coloca os anúncios de live **dentro do próprio playlist** (SSAI). Não é um banner que dá para esconder com CSS; o anúncio chega costurado no stream. Por isso a extensão trabalha em camadas:

1. **Reescreve o token** e remove as linhas de anúncio dos playlists.
2. Se o anúncio já estiver colado, **cobre o player** com um player limpo que já estava pronto e mudo (standby).
3. Quando o intervalo termina, **devolve o player nativo** na qualidade original e restaura mudo e volume.

### Por que o frame limpo fica em 360p

Durante o intervalo, o frame limpo é **360p**. Fora do anúncio, o player nativo volta para a qualidade que você escolheu, até 1080p.

Isso é de propósito. Em intervalos longos, uma fonte em HD pode virar “só anúncio”, e foi isso que já causou tela preta e travamento. O frame em 360p é mais confiável para cobrir o intervalo; a qualidade volta quando o anúncio termina.

### Abriu a live e o anúncio veio junto

A página **não recarrega sozinha**. A extensão não usa F5 automático nem refresh infinito: isso foi medido e descartado, porque o anúncio volta junto com o novo carregamento.

O que acontece:

1. Assim que a live abre, a extensão começa a preparar um player limpo escondido.
2. Se o anúncio chegar no mesmo instante em que a página ainda está carregando, o anúncio nativo pode aparecer **mudo** por instantes.
3. Quando o standby fica saudável, ele cobre o anúncio. Em geral isso leva menos de 1 segundo depois que o anúncio começa, mas depende da rede.
4. Se o standby não ficar saudável, a extensão mantém ou devolve o player nativo em vez de deixar uma tela preta.

Recarregar a página só reinicia a espera e pode trazer o anúncio de novo. Se o anúncio aparecer no meio da live, o processo é o mesmo.

---

## Deu problema? Veja aqui

| Problema | O que fazer |
|----------|-------------|
| Atualizei a extensão e o comportamento antigo continua | Recarregue a aba da Twitch com **F5**. O content script só troca no próximo carregamento. |
| Fiquei sem áudio depois do anúncio | Dê **F5** e confira se o toggle do overlay está ligado. Nas versões atuais, o volume e o mudo são salvos e restaurados. |
| Apareceu um anúncio | No anúncio antes da live, ele ainda pode aparecer mudo por instantes se chegar junto com o carregamento. A extensão começa o standby mais cedo e cobre assim que ele fica saudável. Se acontecer no meio de um intervalo longo, verifique se o toggle **Twitch adblock** está ligado. |
| Tela preta ou player travado | A extensão tenta voltar para o player nativo quando o frame limpo não chega a `Playing`. Se persistir, dê **F5** e desligue o overlay para isolar o problema. |
| Kick ou YouTube não aparece | Confira se o canal está ao vivo e se o nome ou a URL está certa. Se o streamer faz multi stream, confirme no popup se o canal da Kick ou do YouTube é o mesmo que ele está usando. O mapeamento é por canal e fica salvo. |
| Escolhi YouTube, mas apareceu o player da Kick | O YouTube não foi encontrado ou não estava ao vivo, então a extensão usou o fallback para a Kick. Confira a URL, o `@handle` ou o ID. A barra fica verde na Kick e vermelha no YouTube. |
| Quero o player 1:1 da Kick ou do YouTube | Use **Abrir no site oficial** no popup. O player oficial só roda no site do provedor e não expõe todos os controles para a extensão; o do YouTube também pode cair em bloqueio sem cookie. |
| Apareceu um player diferente sem anúncio | O frame limpo do anúncio só entra quando a extensão detecta um anúncio. Se não havia anúncio, veja a cor da barra: verde é o fallback da Kick, vermelha é o YouTube. |
| Quero conferir a versão | Abra `chrome://extensions` e veja o número embaixo do nome. |

---

## Seus dados ficam com você

- **Não pede senha** da Twitch, Kick ou YouTube. Usa a sessão que você já tem aberta no navegador.
- Configurações, mapeamentos e o log de anúncios ficam **só no seu navegador** (`chrome.storage.local`).
- Não há analytics, telemetria ou servidor do projeto. As únicas conexões são com as plataformas e com os CDNs de vídeo.

---

## Para quem mexe no código

### O que tem em cada pasta

| Caminho | O que é |
|---------|---------|
| `kick-overlay/` | A extensão Chrome (manifest, content scripts, player HLS, popup). |
| `_tools/` | Harness de teste via CDP e portão rápido de evidência. |
| `kick-overlay/ADBLOCK-FINDINGS.md` | Log técnico do adblock: o que foi medido, o que falhou e por quê. **Leia antes de mexer no `twitch-adblock.js`.** |
| `kick-overlay/PLAYER-1TO1-RESEARCH.md` | Pesquisa sobre player 1:1 e a decisão de manter o overlay atual. |
| `TODO.md` | Estado final do projeto e limitações aceitas. |

### Como testar sem atrapalhar seu Chrome

```powershell
node _tools/ko-harness.mjs check --fresh --yt='https://www.youtube.com/watch?v=3cOk_W3ewcE'
```

O harness sobe um perfil separado (porta 9335) para não mexer no seu Chrome. O relatório vai para `G:\Temp\opencode\ko-harness-report.json`.

Para um portão rápido, sem abrir navegador:

```powershell
node _tools/ko-verify.mjs
```

Ele checa sintaxe, manifesto, ausência de auto-refresh e o contrato do cold open. Também executa braços negativos de verdade e escreve um recibo em `_evidence/` com a lista do que **não** foi medido.

### As regras do adblock

- Nunca revelar um frame sem `Playing` saudável (`readyState >= 3`); se travar, voltar ao nativo.
- O standby fica sempre mudo e escondido; clique na página não pode desmutá-lo.
- Salvar e restaurar `muted` **e** `volume`: o Twitch zera o volume quando o elemento é mutado.
- Sem rewind no caminho quente; o standby já está tocando.
- Durante o anúncio, o frame limpo é 360p; fora dele, o player nativo volta à qualidade escolhida.

---

## O que ele ainda não resolve

- **Anúncio de live:** durante o intervalo, o frame limpo é 360p. Fora do anúncio, o player nativo volta à qualidade escolhida.
- **Anúncio antes da live:** se o anúncio chegar junto com o carregamento, ele ainda pode aparecer mudo por instantes. A extensão começa o standby mais cedo e cobre assim que ele fica saudável; a alternativa seria uma tela preta, que foi descartada.
- **Player 1:1:** o overlay chega perto, mas não é um clone exato da Kick ou do YouTube. O player oficial da Kick não expõe controle de mute e pause para a extensão, e o do YouTube pode bloquear sem cookie. Para 1:1 real, use **Abrir no site oficial** no popup.
- **Twitch muda com frequência:** se o Twitch mudar o formato do SSAI, o adblock pode parar de funcionar até uma atualização. O log em `ADBLOCK-FINDINGS.md` existe para facilitar o diagnóstico.
- **VOD:** o bloqueio é de CSAI; se o Twitch mudar a entrega, pode ser necessário ajustar os hosts bloqueados.
- **A extensão não é afiliada** à Twitch, Kick ou YouTube.

---

Feito por [@mateusant13](https://github.com/mateusant13).
