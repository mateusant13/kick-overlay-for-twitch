# Kick & YouTube Overlay for Twitch

Assista **Kick** e **YouTube** dentro do player da Twitch - e deixe os anúncios da Twitch fora do caminho.

A extensão mantém o player nativo da Twitch quando você está na Twitch. O overlay de Kick/YouTube só entra quando você escolhe esses players no popup. O adblock da Twitch funciona em cima do player nativo, sem trocar de site.

---

## O que é o overlay?

O overlay é uma **segunda camada de vídeo** que fica por cima do player da Twitch. O player da Twitch continua rodando embaixo, mudo, e o chat, os controles, as raids e o resto da página continuam funcionando.

Quando você escolhe **Kick** ou **YouTube** no popup, a extensão troca apenas o vídeo que aparece. Não abre outra aba, não muda de site e não substitui a Twitch.

Não é um overlay de OBS (aquele usado em transmissão). É um player dentro da própria página da Twitch, para você assistir.

---

## O que ele faz

- **Overlay de Kick** - o canal da Kick toca por cima do player da Twitch, com os controles do projeto.
- **Overlay de YouTube** - funciona com URL de live/vídeo, `@handle` ou ID `UC...`.
- **Adblock para lives da Twitch** - reescreve o token do player, remove os blocos de anúncio dos playlists e, quando o anúncio já veio colado no stream, cobre o player com um frame limpo em 360p até o intervalo acabar.
- **Adblock para VODs da Twitch** - bloqueia as requisições de anúncio CSAI dos vídeos sob demanda.
- **Sem trocar o player fora do anúncio** - quando não há anúncio, quem manda é o player nativo da Twitch, na qualidade que você escolheu (até 1080p).
- **Áudio de volta sozinho** - o estado de mudo e o volume são salvos antes do anúncio e restaurados depois. Você não precisa clicar no ícone de volume.
- **Sem rewind e sem áudio duplicado** - o standby fica escondido e mudo; o player nativo é silenciado enquanto o frame limpo está na frente.

---

## Como instalar e usar

### 1. Baixe o ZIP

No GitHub, clique no botão verde **Code** (ou **Código**) → **Download ZIP**.

### 2. Extraia o ZIP

Abra o `.zip` e arraste a pasta de dentro para a **Área de Trabalho** (ou outro lugar que você não vá apagar).

A pasta da extensão é a **`kick-overlay`** - a que tem o arquivo `manifest.json` dentro. Não é a pasta raiz do projeto.

### 3. Abra a página de extensões do navegador

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

- **Opção A:** arraste a pasta **`kick-overlay`** para dentro da página de extensões, **ou**
- **Opção B:** clique em **Carregar sem compactação** (Load unpacked) e escolha a pasta **`kick-overlay`**.

### 6. Fixe o ícone e abra a Twitch

Clique no ícone da extensão na barra do navegador e deixe-o fixado. Depois abra a Twitch e **recarregue a aba uma vez** (F5) para o content script entrar.

> **Importante:** a pasta `kick-overlay` precisa continuar no computador. O navegador lê os arquivos dela direto; não apague enquanto estiver usando.

---

## Como usar

1. Abra o canal na Twitch.
2. Clique no ícone da extensão.
3. Escolha o player:

   | Player | O que faz |
   |--------|-----------|
   | **Kick** | Informe o nome do canal na Kick. Se for igual ao da Twitch, pode deixar o padrão. |
   | **YouTube** | Cole a URL da live/vídeo, o `@handle` ou o ID `UC...`. Se o streamer usa outro nome no YouTube, é aqui que você ajusta. |
   | **Twitch** | Mantém o player nativo; o adblock continua ativo. |

4. Preencha o canal e clique em **Save**. O ajuste vale só para aquele canal da Twitch.
5. Use o toggle **Overlay** para ligar/desligar o player alternativo.
6. Use o toggle **Twitch adblock** para ligar/desligar o bloqueio de anúncios.

> **Importante para multi stream:** clique no ícone da extensão e informe o canal da Kick ou o YouTube do streamer. O nome pode ser diferente do nome usado na Twitch. No Kick, se você não informar, a extensão tenta usar o mesmo nome da Twitch; no YouTube, é preciso colocar a URL, o `@handle` ou o ID. Sem isso, pode abrir o canal errado ou ficar sem imagem.

### Streamer faz multi stream?

Se o streamer transmite na Twitch e também na Kick e/ou no YouTube, o nome do canal pode ser diferente em cada plataforma. É por isso que o passo 2 é importante: clique no ícone da extensão e preencha o canal certo. A extensão salva esse ajuste por canal da Twitch; na próxima vez você não precisa configurar de novo.

### Atualizei a extensão e nada mudou

O content script só é trocado quando a página recarrega. Dê **F5** na aba da Twitch depois de atualizar a extensão.

---

## O que acontece durante um anúncio

O Twitch coloca os anúncios de live **dentro do próprio playlist** (SSAI). Não é um banner que dá para bloquear por CSS; o anúncio chega costurado no stream.

A extensão faz três coisas, nesta ordem:

1. **Reescreve o token** e remove as linhas de anúncio dos playlists.
2. Se o anúncio já estiver colado, **cobre o player** com um player limpo que já estava pronto e mudo (standby).
3. Quando o intervalo termina, **devolve o player nativo** na qualidade original e restaura mudo + volume.

### Qualidade durante o anúncio

Durante o intervalo, o frame limpo é **360p**. Fora do anúncio, o player nativo volta para a qualidade que você escolheu (até 1080p).

Isso é de propósito: em intervalos longos, a fonte em HD pode virar “só anúncio”. Foi isso que já causou tela preta e travamento. Por isso, durante o intervalo, o frame limpo fica em 360p - e o player nativo volta à sua qualidade quando o intervalo termina.

---

## Problemas comuns

| Problema | O que fazer |
|----------|-------------|
| Atualizei a extensão e o comportamento antigo continua | Recarregue a aba da Twitch com **F5**. O content script só troca no próximo carregamento. |
| Fiquei sem áudio depois do anúncio | Confirme que está na **0.8.29** ou mais novo e dê **F5**. A versão 0.8.29 restaura volume + mudo; antes disso o volume ficava em 0. |
| Apareceu um anúncio | No anúncio antes da live, o anúncio nativo pode aparecer **mudo** por alguns segundos enquanto o frame limpo fica pronto. Isso é preferível a uma tela preta. Se acontecer no meio de um intervalo longo, verifique se o toggle **Twitch adblock** está ligado. |
| Tela preta ou player travado | A extensão tenta voltar para o player nativo quando o frame limpo não chega a `Playing`. Se persistir, dê **F5** e desligue o overlay para isolar o problema. |
| Kick ou YouTube não aparece | Confira se o canal está ao vivo e se o nome/URL está certo. Se o streamer faz multi stream, confirme no popup se o canal da Kick/YouTube é o mesmo que ele está usando. O mapeamento é por canal e fica salvo. |
| Quero conferir a versão | Abra `chrome://extensions` e veja o número embaixo do nome. A versão validada é **0.8.29**. |

---

## Privacidade

- **Não pede senha** da Twitch, Kick ou YouTube. Usa a sessão que você já tem aberta no navegador.
- Configurações, mapeamentos e o log de anúncios ficam **só no seu navegador** (`chrome.storage.local`).
- Não há analytics, telemetria ou servidor do projeto. As únicas conexões são com as plataformas (Twitch/Kick/YouTube).

---

## Para desenvolvedores

### Estrutura

| Caminho | O que é |
|---------|---------|
| `kick-overlay/` | A extensão Chrome (manifest, content scripts, player HLS, popup). |
| `_tools/` | Harness de teste via CDP (Chrome/Edge separado). |
| `kick-overlay/ADBLOCK-FINDINGS.md` | Log técnico do adblock: o que foi medido, o que falhou e por quê. **Leia antes de mexer no `twitch-adblock.js`.** |
| `TODO.md` | Estado final do projeto e limitações aceitas. |

### Harness

```powershell
node _tools/ko-harness.mjs check --fresh --yt='https://www.youtube.com/watch?v=3cOk_W3ewcE'
```

O harness sobe um perfil separado (porta 9335) para não mexer no seu Chrome. O relatório vai para `G:\Temp\opencode\ko-harness-report.json`.

### Princípios do adblock

- Nunca revelar um frame sem `Playing` saudável (`readyState >= 3`); se travar, voltar ao nativo.
- O standby fica sempre mudo e escondido; clique na página não pode desmutá-lo.
- Salvar e restaurar `muted` **e** `volume`: o Twitch zera o volume quando o elemento é mutado.
- Sem rewind no caminho quente; o standby já está tocando.
- Durante o anúncio, o frame limpo é 360p; fora dele, o player nativo volta à qualidade escolhida.

---

## Limitações conhecidas

- **Anúncio de live:** durante o intervalo, o frame limpo é 360p. Fora do anúncio, o player nativo volta à qualidade escolhida.
- **Anúncio antes da live:** o anúncio nativo pode aparecer mudo por alguns segundos até o frame limpo ficar pronto. A alternativa seria uma tela preta, que foi descartada.
- **Twitch muda com frequência:** se o Twitch mudar o formato do SSAI, o adblock pode parar de funcionar até uma atualização. O log em `ADBLOCK-FINDINGS.md` existe para facilitar o diagnóstico.
- **VOD:** o bloqueio é de CSAI; se o Twitch mudar a entrega, pode ser necessário ajustar os hosts bloqueados.
- **A extensão não é afiliada** à Twitch, Kick ou YouTube.

---

Feito por [@mateusant13](https://github.com/mateusant13).
